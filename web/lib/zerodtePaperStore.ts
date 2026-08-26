// Persistencia de la cuenta de paper del 0DTE.
//
// Copia deliberada del patrón de `primaPaperStore.ts` para que las dos cuentas se
// comporten igual ante un corte:
//   · `data/0dte/paper-positions.json` — las abiertas, escritura atómica.
//   · `data/0dte/paper-closed.jsonl`   — libro APPEND-ONLY de cerradas.
//
// El capital se DERIVA del libro (START_EQUITY + suma de P&L), así que no hay un
// número guardado que se pueda perder o desincronizar.
//
// `commit()` escribe el libro ANTES que las abiertas: ante un corte es preferible
// una posición duplicada y visible que un cierre que no quedó registrado.

import { promises as fs } from "fs";
import path from "path";
import {
  closePosition, managePosition, planOpen, reprice, summarize,
  type ZeroPaperPosition, type ZeroPaperSummary,
} from "./zerodtePaper";
import type { ZeroDteTicket, ZeroDteTrade } from "./zerodteSignals";
import { sendAlert } from "./telegram";
import { zeroClosedText, zeroOpenedText } from "./alertText";

const DIR = path.join(process.cwd(), "data", "0dte");
const OPEN_FILE = path.join(DIR, "paper-positions.json");
const CLOSED_FILE = path.join(DIR, "paper-closed.jsonl");

export async function loadOpen(): Promise<ZeroPaperPosition[]> {
  try {
    const raw = await fs.readFile(OPEN_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ZeroPaperPosition[]) : [];
  } catch {
    return [];
  }
}

export async function loadClosed(): Promise<ZeroPaperPosition[]> {
  try {
    const raw = await fs.readFile(CLOSED_FILE, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try { return JSON.parse(l) as ZeroPaperPosition; } catch { return null; }
      })
      .filter((p): p is ZeroPaperPosition => p != null);
  } catch {
    return [];
  }
}

/** Escritura atómica: tmp + rename, para no dejar un JSON a medias. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

/**
 * Guarda el estado nuevo. `justClosed` se APILA en el libro y `open` reemplaza
 * el fichero de abiertas.
 */
export async function commit(open: ZeroPaperPosition[], justClosed: ZeroPaperPosition[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  if (justClosed.length > 0) {
    const lines = justClosed.map((p) => JSON.stringify(p)).join("\n") + "\n";
    await fs.appendFile(CLOSED_FILE, lines, "utf8");
  }
  await writeAtomic(OPEN_FILE, JSON.stringify(open, null, 2));
}

// ---------------------------------------------------------------------------
// El "tick": gestionar lo abierto y, si toca, abrir.
// ---------------------------------------------------------------------------

/**
 * Cola de un solo carril para el tick.
 *
 * El tick corre desde DOS sitios: la vista (`/api/0dte`, cuando la página está
 * abierta) y la tarea programada (`POST /api/0dte-paper`). Ambos caen en el
 * minuto redondo, así que pueden solaparse — y como el patrón es leer-decidir-
 * escribir sobre el mismo JSON, dos ticks a la vez se pisarían: el segundo
 * escribiría partiendo de un estado que el primero ya había cambiado, y se
 * perdería una apertura o se duplicaría una posición.
 *
 * Los dos caminos viven en el MISMO proceso de Next, así que encadenarlos aquí
 * basta y evita un fichero de lock. El `catch` mantiene la cadena viva: un tick
 * que falla no puede dejar la cola atascada para siempre.
 */
let cola: Promise<unknown> = Promise.resolve();
function enCola<T>(fn: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(fn, fn);
  cola = siguiente.catch(() => undefined);
  return siguiente;
}

/**
 * Un ciclo completo de la cuenta: re-cotiza lo abierto, aplica las reglas y abre
 * si toca. Lo llaman los DOS caminos —la vista y la tarea programada— con el
 * mismo `scanZeroDte`, así que la cuenta avanza igual con la página abierta que
 * sin ella, y compra el contrato que la pantalla habría enseñado ese minuto.
 *
 * `priceOf` traduce un símbolo de contrato a su mid actual; devuelve null si ese
 * contrato no está en la cadena cargada (otro ticker u otro vencimiento), y
 * entonces la posición no se re-cotiza en vez de valorarse con un dato inventado.
 */
export async function tickZeroPaper(input: {
  ticker: string;
  expiration: string;
  spot: number;
  minutesLeft: number;
  sessionOpen: boolean;
  now: Date;
  ticket: ZeroDteTicket | null;
  trade: ZeroDteTrade | null;
  priceOf: (optionSymbol: string) => number | null;
}): Promise<{
  open: ZeroPaperPosition[];
  summary: ZeroPaperSummary;
  justClosed: ZeroPaperPosition[];
  blocked: string;
}> {
  return enCola(() => tickInner(input));
}

async function tickInner(input: Parameters<typeof tickZeroPaper>[0]): Promise<Awaited<ReturnType<typeof tickZeroPaper>>> {
  const prevOpen = await loadOpen();
  const closedBook = await loadClosed();

  // 1. Re-cotizar y aplicar reglas a lo que ya estaba abierto.
  const stillOpen: ZeroPaperPosition[] = [];
  const justClosed: ZeroPaperPosition[] = [];
  for (const p0 of prevOpen) {
    const p = reprice(p0, input.priceOf(p0.optionSymbol));
    // Las reglas se evalúan con el spot del SU ticker. Si la página está mirando
    // otro símbolo, la posición se mantiene sin tocar: no hay dato con el que
    // decidir, y decidir a ciegas es peor que esperar al siguiente refresco.
    if (p.ticker !== input.ticker) { stillOpen.push(p); continue; }
    const d = managePosition(p, input.spot, input.minutesLeft, input.sessionOpen);
    if (d.action === "cerrar" && d.reason) justClosed.push(closePosition(p, d.reason, input.now));
    else stillOpen.push(p);
  }

  // 2. ¿Abrir? Se decide con la cartera YA gestionada, no con la de antes: si una
  //    posición acaba de cerrarse, su hueco queda libre en el mismo ciclo.
  const equity = summarize([...closedBook, ...justClosed], stillOpen).equity;
  const plan = planOpen({
    ticker: input.ticker,
    expiration: input.expiration,
    ticket: input.ticket,
    trade: input.trade,
    spot: input.spot,
    equity,
    open: stillOpen,
    minutesLeft: input.minutesLeft,
    sessionOpen: input.sessionOpen,
    now: input.now,
  });
  if (plan.position) {
    stillOpen.push({ ...plan.position, id: `Z-${input.now.getTime()}` });
  }

  if (justClosed.length > 0 || plan.position || changed(prevOpen, stillOpen)) {
    await commit(stillOpen, justClosed);
  }

  const allClosed = [...closedBook, ...justClosed];
  const resumen = summarize(allClosed, stillOpen);

  // Avisos best-effort. Van DESPUÉS de guardar: si Telegram falla, la posición ya
  // está en el libro; si se mandara antes, un fallo de disco dejaría un aviso de
  // algo que no ocurrió.
  if (plan.position) {
    const abierta = stillOpen[stillOpen.length - 1];
    void sendAlert(zeroOpenedText(abierta, resumen.equity)).catch(() => null);
  }
  for (const c of justClosed) void sendAlert(zeroClosedText(c, resumen.equity)).catch(() => null);

  return {
    open: stillOpen,
    justClosed,
    blocked: plan.blocked,
    summary: resumen,
  };
}

/** ¿Cambió alguna cotización? Evita reescribir el fichero en cada minuto muerto. */
function changed(before: ZeroPaperPosition[], after: ZeroPaperPosition[]): boolean {
  if (before.length !== after.length) return true;
  return after.some((p, i) => p.currentPrice !== before[i]?.currentPrice);
}
