// Paper trading de VENTA DE PRIMA dentro de Tito.
//
//   GET                    → estado de la cuenta (abiertas + libro + resumen)
//   POST {action:"manage"} → re-cotiza las abiertas y aplica las reglas de salida
//   POST {action:"open"}   → escanea y abre (SOLO lunes; el motor lo comprueba)
//
// Cierra el traslado desde el bot Python: la estrategia ya vivía en
// `lib/creditSpread.ts`; esto trae la ejecución. Nada mueve dinero real.
//
// El escaneo de apertura es CARO (103 símbolos × cadena), así que solo corre cuando
// se pide explícitamente `open`, nunca en el GET que pinta la pantalla.

import { MassiveError } from "@/lib/massive";
import { fetchOptionChain2, MarketSnackError } from "@/lib/marketsnack";
import { normalizeChain2 } from "@/lib/optionChain2";
import { DTE_MAX, type SpreadCandidate } from "@/lib/creditSpread";
import { SPREAD_UNIVERSE } from "@/lib/spreadUniverse";
import { addDaysStr, cachedMacroCalendar, macroEventsInWindow } from "@/lib/macroCalendar";
import { fetchWindowQuotes, scanSymbol } from "@/lib/spreadScan";
import {
  START_EQUITY, closePosition, managePosition, planOpen, positionFrom,
  reprice, sizeFor, summarize, type PrimaPosition,
} from "@/lib/primaPaper";
import { repriceFromChain } from "@/lib/primaReprice";
import { commit, loadClosed, loadOpen, saveOpen } from "@/lib/primaPaperStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Concurrencia del escaneo. Igual que /spreads: MarketSnack no agradece más. */
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// GET — estado
// ---------------------------------------------------------------------------

export async function GET() {
  const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);
  return Response.json({
    ok: true,
    summary: summarize(closed, open, START_EQUITY),
    open: open.filter((p) => p.status === "abierta"),
    closed: closed.slice(-60).reverse(), // lo más reciente primero
  });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido." }, { status: 400 });
  }

  try {
    if (body.action === "manage") return await doManage();
    if (body.action === "open") return await doOpen();
    return Response.json({ ok: false, error: "action debe ser 'open' o 'manage'." }, { status: 400 });
  } catch (err) {
    const msg =
      err instanceof MarketSnackError || err instanceof MassiveError
        ? err.message
        : err instanceof Error ? err.message : "Error inesperado.";
    return Response.json({ ok: false, error: msg }, { status: 502 });
  }
}

/** Re-cotiza las abiertas y aplica las reglas. Barato: una cadena por posición. */
async function doManage() {
  const now = new Date();
  const abiertas = (await loadOpen()).filter((p) => p.status === "abierta");
  if (abiertas.length === 0) {
    return Response.json({ ok: true, managed: 0, closed: [], notes: ["Sin posiciones abiertas."] });
  }

  const notes: string[] = [];
  const siguen: PrimaPosition[] = [];
  const cerradas: PrimaPosition[] = [];

  await mapLimit(abiertas, CONCURRENCY, async (p) => {
    let actualizada = p;
    try {
      const chain = normalizeChain2(await fetchOptionChain2(p.ticker, p.expiration));
      const r = repriceFromChain(p, chain);
      if (r.currentValue == null) {
        // Sin precio NO se decide: aplicar una regla sobre un valor rancio podría
        // cerrar una posición sana. Se deja como está y se avisa.
        notes.push(`${p.ticker}: no se pudo re-cotizar (${r.problem}). Se mantiene sin evaluar.`);
        siguen.push(p);
        return;
      }
      actualizada = reprice(p, r.currentValue, r.shortDelta ?? undefined);
    } catch (e) {
      notes.push(`${p.ticker}: fallo al pedir la cadena (${e instanceof Error ? e.message : "?"}). Se mantiene.`);
      siguen.push(p);
      return;
    }

    const d = managePosition(actualizada, now);
    if (d.action === "cerrar") {
      cerradas.push(closePosition(actualizada, d.reason, now));
      notes.push(`${p.ticker}: CERRADA — ${d.reason}`);
    } else {
      if (d.action === "avisar") notes.push(`${p.ticker}: ⚠ ${d.reason}`);
      siguen.push(actualizada);
    }
  });

  await commit(siguen, cerradas);
  const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);
  return Response.json({
    ok: true,
    managed: abiertas.length,
    closed: cerradas.map((c) => ({ ticker: c.ticker, pnl: c.realizedPnl, reason: c.closeReason })),
    notes,
    summary: summarize(closed, open, START_EQUITY),
  });
}

/** Escanea el universo y abre lo que toque. SOLO lunes (lo decide `planOpen`). */
async function doOpen() {
  const now = new Date();

  // Se comprueba el día ANTES de escanear: 103 cadenas es caro y en martes no sirve.
  const abiertasPrev = (await loadOpen()).filter((p) => p.status === "abierta");
  const preflight = planOpen([], abiertasPrev, now);
  if (preflight.blocked && !preflight.blocked.includes("ningún candidato")) {
    return Response.json({ ok: true, opened: [], scanned: 0, blocked: preflight.blocked });
  }

  // Calendario macro: si no hay, se BLOQUEA. No se abre a ciegas (mismo criterio
  // que /spreads: un CPI o un FOMC dentro de la semana cambia el riesgo por completo).
  const macro = await cachedMacroCalendar(now);
  if (!macro) {
    return Response.json({
      ok: false,
      error: "No hay calendario macro (FRED falló y no hay cache). No se abre a ciegas.",
    }, { status: 503 });
  }
  const today = now.toISOString().slice(0, 10);
  const macroEvents = macroEventsInWindow(macro.events, today, addDaysStr(today, DTE_MAX));

  const candidatos: SpreadCandidate[] = [];
  let escaneados = 0;
  const fallos: string[] = [];

  await mapLimit(SPREAD_UNIVERSE, CONCURRENCY, async (sym) => {
    const r = await scanSymbol(sym, { now, macroEvents, bias: "neutral", expert: false, fetchQuotes: fetchWindowQuotes });
    if (!r.ok) { fallos.push(`${sym.ticker}: ${r.reason}`); return; }
    escaneados += 1;
    candidatos.push(...r.scan.candidates);
  });

  const equity = summarize(await loadClosed(), abiertasPrev, START_EQUITY).equity;
  const plan = planOpen(candidatos, abiertasPrev, now);

  const nuevas: PrimaPosition[] = [];
  for (const c of plan.chosen) {
    const contratos = sizeFor(c, equity);
    if (contratos < 1) continue; // el riesgo por operación no da ni para uno
    nuevas.push(positionFrom(c, contratos, `VP-${Date.now()}-${nuevas.length}`, now));
  }

  if (nuevas.length > 0) await saveOpen([...abiertasPrev, ...nuevas]);

  const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);
  return Response.json({
    ok: true,
    scanned: escaneados,
    candidates: candidatos.length,
    opened: nuevas.map((p) => ({ ticker: p.ticker, type: p.type, short: p.shortStrike, long: p.longStrike, contracts: p.contracts, credit: p.entryCredit, pop: p.popPct })),
    skipped: plan.skipped,
    blocked: plan.blocked,
    failures: fallos.slice(0, 10),
    summary: summarize(closed, open, START_EQUITY),
  });
}
