// POST /api/trades/refresh — re-cotiza los trades ABIERTOS (pendiente/activa) y avanza sus
// estados con la lógica pura de lib/paperTrade. Fuentes (directiva del dueño 2026-08-24:
// TODO sale de Tastytrade + MarketSnack, Massive fuera):
//  - precio del SUBYACENTE: Tastytrade (streamer) → Massive de reserva.
//  - prima de la OPCIÓN: Tastytrade (cadena del vencimiento) → MarketSnack Option Chain 2.0.
//
// Sin NINGUNA fuente de prima no se puede fijar entrada ni P&L: se avisa claro en vez de
// inventar precios. NADA de esto mueve dinero real.
//
// OJO con la prima — es de donde salió el bug del "P&L en cero" (2026-08-24): este
// endpoint solo miraba MarketSnack y, cuando la cadena no traía el contrato, `evaluate`
// cerraba con la prima rancia (= la de entrada) y el P&L salía $0 en las 12 operaciones
// que llegaron a entrar. Por eso ahora hay cascada de fuentes Y `evaluate` se niega a
// poner precio de salida si no lo tiene.

import { loadPaperTrades, savePaperTrades } from "@/lib/paperTradeStore";
import { evaluate, isClosed, isExpired, isOpen, summarize, type PaperTrade } from "@/lib/paperTrade";
import { closeOnDate, loadTfBars } from "@/lib/barSources";
import { cachedTfBars } from "@/lib/barsStore";
import { promises as fs } from "fs";
import path from "path";
import { fetchQuotes } from "@/lib/massive";
import { marketsnackConfigured } from "@/lib/marketsnackCookie";
import { fetchOptionChain2, MarketSnackError } from "@/lib/marketsnack";
import { dteOf, normalizeChain2 } from "@/lib/optionChain2";
import {
  fetchQuoteToken, fetchTastytradeChain, fetchTastytradeQuotes, tastytradeConfigured,
  type QuoteToken,
} from "@/lib/tastytrade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONCURRENCY = 4;

const LOG_FILE = path.join(process.cwd(), "data", "trades-refresh.log");
const LOG_MAX_LINES = 500;

/**
 * Bitácora de cada re-cotización, misma convención que `data/prima-run.log`.
 * Sirve para responder "¿cuántas caducaron hoy?" sin tener que diffear el JSON:
 * las transiciones se pierden en cuanto se sobrescribe `paper-trades.json`.
 * Nunca revienta la petición — un fallo de disco no debe tumbar el refresh.
 */
async function log(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    let lines: string[] = [];
    try {
      lines = (await fs.readFile(LOG_FILE, "utf8")).split("\n").filter(Boolean);
    } catch {
      /* primera vez */
    }
    lines.push(`${new Date().toISOString()}  ${line}`);
    if (lines.length > LOG_MAX_LINES) lines = lines.slice(lines.length - LOG_MAX_LINES);
    await fs.writeFile(LOG_FILE, lines.join("\n") + "\n", "utf8");
  } catch {
    /* la bitácora es un extra, no una dependencia */
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** Clave del contrato dentro de una cadena: tipo + strike (tolera flotantes). */
function contractKey(type: string, strike: number): string {
  return `${type}|${strike.toFixed(3)}`;
}

/**
 * Precio del subyacente de todos los tickers a la vez.
 *
 * Tastytrade primero: el snapshot masivo de Massive responde **403 NOT_AUTHORIZED**
 * en el plan gratis (verificado 2026-08-24), así que dejarlo de primero era gastar
 * una llamada para recibir nada. Massive queda de reserva por si Tastytrade no está
 * conectado.
 */
async function underlyingPrices(
  tickers: string[],
  ttToken?: QuoteToken,
): Promise<{ prices: Map<string, number>; source: string }> {
  if (ttToken) {
    try {
      const tt = await fetchTastytradeQuotes(tickers, { quoteToken: ttToken });
      const prices = new Map<string, number>();
      for (const [ticker, q] of tt) if (q.price != null) prices.set(ticker, q.price);
      if (prices.size > 0) return { prices, source: "tastytrade" };
    } catch {
      // cae a Massive
    }
  }
  const quotes = await fetchQuotes(tickers).catch(() => []);
  const prices = new Map<string, number>();
  for (const q of quotes) if (q.price != null) prices.set(q.ticker, q.price);
  return { prices, source: prices.size > 0 ? "massive" : "ninguna" };
}

/** Mid utilizable de una horquilla. Sin los dos lados no hay mid que valga. */
function midOf(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid != null && ask != null && ask > 0) return (bid + ask) / 2;
  return last != null && last >= 0 ? last : null;
}

/**
 * Primas de un (ticker, vencimiento) por cascada Tastytrade → MarketSnack.
 *
 * Devuelve un mapa `tipo|strike` → mid. Cada fuente sabe fallar por su cuenta y la
 * siguiente lo intenta: lo que NO puede pasar es quedarse sin prima en silencio,
 * porque de ahí salía el P&L en cero.
 */
async function marksFor(
  ticker: string,
  expiration: string,
  now: Date,
  ttToken?: QuoteToken,
): Promise<{ marks: Map<string, number>; problem: string | null }> {
  const marks = new Map<string, number>();

  if (ttToken) {
    try {
      const dte = dteOf(expiration, now);
      const { contracts } = await fetchTastytradeChain(ticker, {
        dteMin: Math.max(0, dte - 1), dteMax: dte + 1, quoteToken: ttToken,
      });
      for (const c of contracts) {
        if (c.expiration !== expiration) continue;
        const mid = midOf(c.bid, c.ask, c.last);
        if (mid != null) marks.set(contractKey(c.type, c.strike), mid);
      }
      if (marks.size > 0) return { marks, problem: null };
    } catch {
      // cae a MarketSnack
    }
  }

  try {
    const contracts = normalizeChain2(await fetchOptionChain2(ticker, expiration));
    for (const c of contracts) {
      const mark = c.mid ?? c.lastPrice;
      if (mark != null) marks.set(contractKey(c.type, c.strike), mark);
    }
    if (marks.size === 0) return { marks, problem: "la cadena llegó vacía" };
    return { marks, problem: null };
  } catch (e) {
    return { marks, problem: e instanceof MarketSnackError ? e.message : "no se pudo pedir la cadena" };
  }
}


/**
 * Cierre del subyacente el día en que venció cada contrato, para liquidarlo a
 * valor intrínseco.
 *
 * NO sirve el spot de hoy: `isExpired` compara la fecha de MERCADO, así que un
 * vencimiento solo se detecta al día siguiente, y para entonces el único precio
 * guardado en el trade es el de la sesión posterior. Con el USO 111C del
 * 2026-08-21 eso eran $2.364 de intrínseco (cierre del viernes, 134.64) contra
 * $2.116 (spot del lunes): la misma posición y el doble de ganancia. En un
 * contrato ajustado, además, el signo cambia.
 *
 * Se pide la serie diaria completa por ticker (una sola vez, cacheada en disco por
 * `cachedTfBars`) y se busca la vela de esa fecha. Sin vela, `null` → el trade se
 * cierra sin precio, que es preferible a liquidar con un día equivocado.
 *
 * APROXIMACIÓN CONOCIDA: las opciones MENSUALES de índice (SPX) liquidan con el
 * SET, la apertura especial del viernes por la mañana, no con el cierre. Para
 * ETFs, acciones y semanales PM (SPXW incluido) el cierre es el bueno.
 */
async function settlementCloses(expiradas: PaperTrade[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (expiradas.length === 0) return out;

  const tickers = [...new Set(expiradas.map((t) => t.ticker))];
  const series = new Map<string, Awaited<ReturnType<typeof cachedTfBars>>["bars"]>();
  await mapLimit(tickers, CONCURRENCY, async (ticker) => {
    try {
      const r = await cachedTfBars(ticker, "1y", () => loadTfBars(ticker, "1y"));
      series.set(ticker, r.bars);
    } catch {
      // sin barras no se liquida: el trade se queda sin precio
    }
  });

  for (const t of expiradas) {
    const cierre = closeOnDate(series.get(t.ticker) ?? [], t.expiration);
    if (cierre != null) out.set(`${t.ticker}|${t.expiration}`, cierre);
  }
  return out;
}


/**
 * Pasada de FECHAS: aplica solo lo que NO necesita mercado.
 *
 * La caducidad de un plan pendiente (7 días sin cruzar su gatillo) y el vencimiento
 * de uno que nunca entró son aritmética de calendario: no hace falta un precio para
 * decidirlas. Pero vivían dentro del refresco completo, que solo corre en sesión, así
 * que un plan que cumplía 7 días un sábado seguía **reservando su ticker** hasta el
 * lunes — y el piloto respeta "una entrada por ticker", así que ese veto fantasma es
 * exactamente lo que el 2026-08-17 dejó 58 tickers bloqueados y un escaneo con 25
 * candidatos abriendo CERO.
 *
 * Cero red: ni cadenas, ni cotizaciones, ni cookie. Por eso puede correr un domingo.
 *
 * SOLO toca PENDIENTES, y eso es deliberado. Una posición ACTIVA siempre necesita
 * precio para cerrarse: si entrara aquí, una que hubiera vencido se liquidaría sin
 * cotización y sin cierre del día de vencimiento — justo lo que se acaba de arreglar
 * con el valor intrínseco. Las activas esperan al refresco de sesión.
 */
async function pasadaDeFechas(all: PaperTrade[], now: Date) {
  const tally = { caducadas: 0, expiradas: 0 };
  const caducadasTickers: string[] = [];

  const next = all.map((t) => {
    if (t.status !== "pendiente") return t;
    // Sin datos de mercado: `evaluate` no puede activar (necesita las dos cosas) y
    // solo puede aplicar las reglas de fecha.
    const updated = evaluate(t, null, null, now);
    if (updated.status === t.status) return t; // intacto: ni se le toca `updatedAt`
    if (updated.closeReason === "caducada") {
      tally.caducadas += 1;
      caducadasTickers.push(t.ticker);
    } else if (updated.closeReason === "expirada") {
      tally.expiradas += 1;
    }
    return updated;
  });

  const cambios = tally.caducadas + tally.expiradas;
  // Sin transiciones NO se escribe: esta pasada corre a diario, también en fin de
  // semana, y reescribir el libro entero para no cambiar nada es pedir un corte a
  // media escritura a cambio de cero información.
  if (cambios > 0) {
    await savePaperTrades(next);
    const detalle = caducadasTickers.length ? ` [${caducadasTickers.join(", ")}]` : "";
    await log(`OK      fechas — caducadas ${tally.caducadas}${detalle} · expiradas ${tally.expiradas}`);
  }

  return Response.json({
    ok: true,
    modo: "fechas",
    changed: cambios,
    revisados: all.filter((t) => t.status === "pendiente").length,
    tally: { activadas: 0, ganadas: 0, perdidas: 0, ...tally },
    caducadasTickers,
    trades: next,
    summary: summarize(next),
  });
}

export async function POST(request: Request) {
  const all = await loadPaperTrades();

  // `?modo=fechas` → solo las reglas de calendario, sin tocar la red. Lo usa la tarea
  // programada una vez al día, incluidos sábados y domingos.
  if (new URL(request.url).searchParams.get("modo") === "fechas") {
    return await pasadaDeFechas(all, new Date());
  }

  const open = all.filter(isOpen);
  if (open.length === 0) {
    return Response.json({ ok: true, changed: 0, trades: all, summary: summarize(all) });
  }

  const tt = tastytradeConfigured();
  if (!tt && !(await marketsnackConfigured())) {
    return Response.json(
      {
        ok: false,
        kind: "marketsnack",
        error:
          "No hay fuente para la prima de la opción: conecta Tastytrade o pega la cookie de MarketSnack en ⚙️ Ajustes.",
      },
      { status: 422 },
    );
  }

  // Un solo api-quote-token para todo el pase (subyacentes + cadenas).
  const ttToken = tt ? await fetchQuoteToken().catch(() => undefined) : undefined;

  // --- Precio del subyacente ---
  const tickers = [...new Set(open.map((t) => t.ticker))];
  const { prices: underlyingBy, source: fuenteSpot } = await underlyingPrices(tickers, ttToken);

  // --- Prima de la opción: una cadena por (ticker, vencimiento) ---
  const now = new Date();
  const groups = [...new Set(open.map((t) => `${t.ticker}|${t.expiration}`))].map((k) => {
    const [ticker, expiration] = k.split("|");
    return { ticker, expiration };
  });

  const markBy = new Map<string, number>(); // `${ticker}|${exp}|${type}|${strike}` → mid
  const failed: string[] = [];
  await mapLimit(groups, CONCURRENCY, async ({ ticker, expiration }) => {
    const { marks, problem } = await marksFor(ticker, expiration, now, ttToken);
    for (const [k, mid] of marks) markBy.set(`${ticker}|${expiration}|${k}`, mid);
    if (problem) failed.push(`${ticker} ${expiration} (${problem})`);
  });

  // --- Liquidación de lo que ya venció (valor intrínseco al cierre de ese día) ---
  const settle = await settlementCloses(open.filter((t) => isExpired(t, now)));

  // --- Avanza cada trade abierto con la lógica pura ---
  let changed = 0;
  const revisados = open.length;
  const tally = { activadas: 0, caducadas: 0, expiradas: 0, ganadas: 0, perdidas: 0 };
  const caducadasTickers: string[] = [];
  /** Contratos que existen en la bitácora pero no aparecieron en ninguna cadena. */
  const sinPrima: string[] = [];
  /** Vencidas liquidadas a intrínseco: se reporta porque su P&L no sale de una cotización. */
  const liquidadas: string[] = [];

  const next: PaperTrade[] = all.map((t) => {
    if (!isOpen(t)) return t;
    const u = underlyingBy.get(t.ticker) ?? null;
    const mark = markBy.get(`${t.ticker}|${t.expiration}|${contractKey(t.optionType, t.strike)}`) ?? null;
    if (mark == null) sinPrima.push(`${t.ticker} ${t.strike}${t.optionType === "call" ? "C" : "P"} ${t.expiration}`);
    const updated = evaluate(t, u, mark, now, settle.get(`${t.ticker}|${t.expiration}`) ?? null);
    if (updated.status !== t.status || updated.updatedAt !== t.updatedAt) changed++;

    if (t.status === "pendiente" && updated.status === "activa") tally.activadas++;
    if (!isClosed(t) && isClosed(updated)) {
      if (updated.closeReason === "expirada" && t.entryPrice != null && updated.exitPrice != null) {
        liquidadas.push(`${t.ticker} ${t.strike}${t.optionType === "call" ? "C" : "P"} → ${updated.exitPrice}`);
      }
      if (updated.closeReason === "caducada") {
        tally.caducadas++;
        caducadasTickers.push(t.ticker);
      } else if (updated.closeReason === "expirada") tally.expiradas++;
      else if (updated.status === "ganada") tally.ganadas++;
      else if (updated.status === "perdida") tally.perdidas++;
    }
    return updated;
  });

  await savePaperTrades(next);

  const detalle = caducadasTickers.length ? ` [${caducadasTickers.join(", ")}]` : "";
  await log(
    `OK      refresh — revisados ${revisados} · spot ${fuenteSpot} · sin prima ${sinPrima.length} · ` +
      (liquidadas.length ? `liquidadas ${liquidadas.length} [${liquidadas.join(", ")}] · ` : "") +
      `activadas ${tally.activadas} · caducadas ${tally.caducadas}${detalle} · ganadas ${tally.ganadas} · ` +
      `perdidas ${tally.perdidas} · expiradas ${tally.expiradas}`,
  );

  return Response.json({
    ok: true,
    changed,
    revisados,
    tally,
    caducadasTickers,
    trades: next,
    summary: summarize(next),
    source: { spot: fuenteSpot, chain: ttToken ? "tastytrade→marketsnack" : "marketsnack" },
    settled: liquidadas,
    warnings:
      failed.length || sinPrima.length
        ? { unquoted: failed, noMark: sinPrima.slice(0, 12) }
        : undefined,
  });
}
