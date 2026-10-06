// ============================================================================
// Agresor acumulado del Agente 0DTE — quién compró y quién vendió cada strike.
//
// `side` (ask/bid) es el único dato que distingue compra de venta, y sin él la
// tabla del Proceso Principal §4 no se puede aplicar. Pero el feed de
// MarketSnack es una ventana estrechísima (~1 min de cinta por consulta) y una
// foto suelta es inestable — por eso se ACUMULA a lo largo de la sesión: cada
// ciclo suma su tramo de cinta al total del día, deduplicando por id de trade.
//
// Solo servidor (usa fs).
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { isCanceledCondition } from "./conditions";
import { aggressionOf, type RawTrade } from "./flow";
import { marketDateStr, parseOcc } from "./occ";
import type { ContractType, ZContractGreeks, ZRow } from "./zerodteTypes";

const DATA_DIR = path.join(process.cwd(), "data", "pdf", "0dte");

/** Cuántos ids recientes se recuerdan para no contar un trade dos veces. */
export const SEEN_LIMIT = 5_000;

/** Mínimo de trades para que el porcentaje de agresor signifique algo. */
export const MIN_TRADES = 5;

export interface AggBucket {
  strike: number;
  type: ContractType;
  /** Contratos ejecutados contra el ASK — comprador agresivo. */
  ask: number;
  /** Contra el BID — vendedor agresivo. */
  bid: number;
  mid: number;
  trades: number;
  volume: number;
  oi: number;
  gamma: number | null;
  delta: number | null;
  iv: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  /** ms del trade más reciente considerado (para quedarse con la última foto). */
  ts: number;
}

/** Un ciclo de sondeo (~cada 60s, ver REFRESH_MS en AgenteOdteTab). */
export interface CycleSample {
  ts: number;
  /** Contratos nuevos (ask+bid+mid) sumados en ESTE ciclo, no acumulado. */
  added: number;
  /** ask-bid nuevos de ESTE ciclo (signado) — insumo del sparkline de CVD reciente. */
  net: number;
}

export interface FlowAccumulator {
  ticker: string;
  /** Fecha de mercado (ET). El acumulado es del día: no se arrastra. */
  date: string;
  updatedAt: string;
  cycles: number;
  /** Clave "call:7450". */
  buckets: Record<string, AggBucket>;
  seenIds: number[];
  /** Últimos ciclos, para "volumen del último minuto vs promedio de la ventana". */
  recentCycles: CycleSample[];
  /** "Contratos entrantes" (bursts agresivos que calificaron) — solo lo trae
   *  el acumulador cuando lo escribe un streamer de Tastytrade (ver
   *  streamer/lib/top-trades.mjs); el resto de escritores lo dejan vacío. */
  topTrades?: import("./zerodteStream").TopTrade[];
}

/** Cuántos ciclos recientes se guardan para la velocidad de volumen y el sparkline de CVD. */
export const RECENT_CYCLES_LIMIT = 15;

export function emptyAccumulator(ticker: string, date: string): FlowAccumulator {
  return {
    ticker: ticker.toUpperCase(), date, updatedAt: new Date(0).toISOString(),
    cycles: 0, buckets: {}, seenIds: [], recentCycles: [],
  };
}

export function bucketKey(type: ContractType, strike: number): string {
  return `${type}:${strike}`;
}

/**
 * Suma un lote de trades al acumulado. PURA: devuelve uno nuevo.
 * Descarta los cancelados y todo lo que no venza en `expiration`.
 */
export function accumulate(
  acc: FlowAccumulator, trades: RawTrade[], expiration: string, now: Date = new Date(),
): FlowAccumulator {
  const seen = new Set(acc.seenIds);
  const buckets: Record<string, AggBucket> = { ...acc.buckets };
  const fresh: number[] = [];
  let cycleAdded = 0;
  let cycleNet = 0;

  for (const t of trades) {
    if (seen.has(t.id)) continue;
    if (isCanceledCondition(t.trade_condition_id)) continue;
    const occ = parseOcc(t.symbol);
    if (!occ || occ.expiration !== expiration) continue;

    seen.add(t.id);
    fresh.push(t.id);

    const key = bucketKey(occ.type, occ.strike);
    const p = buckets[key] as Partial<AggBucket> | undefined;
    const b: AggBucket = {
      strike: occ.strike, type: occ.type,
      ask: p?.ask ?? 0, bid: p?.bid ?? 0, mid: p?.mid ?? 0, trades: p?.trades ?? 0,
      volume: p?.volume ?? 0, oi: p?.oi ?? 0,
      gamma: p?.gamma ?? null, delta: p?.delta ?? null, iv: p?.iv ?? null,
      bidPrice: p?.bidPrice ?? null, askPrice: p?.askPrice ?? null, ts: p?.ts ?? 0,
    };
    const size = Number(t.size) || 0;
    const side = aggressionOf(t.side);
    if (side === "ask") { b.ask += size; cycleNet += size; }
    else if (side === "bid") { b.bid += size; cycleNet -= size; }
    else if (side === "mid") b.mid += size;
    b.trades += 1;
    cycleAdded += size;

    if (Number.isFinite(t.volume)) b.volume = Math.max(b.volume, t.volume);
    if (Number.isFinite(t.open_interest)) b.oi = Math.max(b.oi, t.open_interest);
    const ts = Date.parse(t.timestamp) || 0;
    if (ts >= b.ts) {
      b.ts = ts;
      if (typeof t.gamma === "number") b.gamma = t.gamma;
      if (Number.isFinite(t.delta)) b.delta = t.delta;
      if (Number.isFinite(t.implied_volatility)) b.iv = t.implied_volatility;
      if (Number.isFinite(t.bid_price)) b.bidPrice = t.bid_price;
      if (Number.isFinite(t.ask_price)) b.askPrice = t.ask_price;
    }
    buckets[key] = { ...b };
  }

  const recentCycles = [...acc.recentCycles, { ts: now.getTime(), added: cycleAdded, net: cycleNet }]
    .slice(-RECENT_CYCLES_LIMIT);

  return {
    ...acc, updatedAt: now.toISOString(), cycles: acc.cycles + 1, buckets, recentCycles,
    seenIds: [...acc.seenIds, ...fresh].slice(-SEEN_LIMIT),
  };
}

export type AggressorSide = "compra" | "venta" | "mixto" | "mid";

export interface AggressorRead {
  side: AggressorSide;
  /** Porcentaje del lado dominante (0-1). */
  pct: number;
  trades: number;
  contracts: number;
  meaning: string;
}

/**
 * Lectura del agresor de un contrato. PURA. Devuelve null si no hay muestra
 * suficiente — mejor sin dato que con un 100% salido de un solo trade.
 */
export function readAggressor(
  acc: FlowAccumulator, type: ContractType, strike: number, minTrades: number = MIN_TRADES,
): AggressorRead | null {
  const b = acc.buckets[bucketKey(type, strike)];
  if (!b || b.trades < minTrades) return null;
  const total = b.ask + b.bid + b.mid;
  if (total <= 0) return null;

  const pAsk = b.ask / total;
  const pBid = b.bid / total;
  const pMid = b.mid / total;

  if (pAsk >= 0.55) {
    return {
      side: "compra", pct: pAsk, trades: b.trades, contracts: total,
      meaning: type === "call" ? "direccional alcista" : "cobertura o bajista",
    };
  }
  if (pBid >= 0.55) {
    return {
      side: "venta", pct: pBid, trades: b.trades, contracts: total,
      meaning: type === "call" ? "resistencia / muro" : "soporte",
    };
  }
  if (pMid >= 0.55) {
    return { side: "mid", pct: pMid, trades: b.trades, contracts: total, meaning: "sin agresor claro" };
  }
  return { side: "mixto", pct: Math.max(pAsk, pBid), trades: b.trades, contracts: total, meaning: "" };
}

// ------------------------------------------------- agresor neto (CVD) + velocidad

/** Mínimo de contratos en el libro para que el CVD y la velocidad signifiquen algo. */
export const MIN_SAMPLE_TOTAL = 30;

export interface NetAggressorTotals {
  ask: number;
  bid: number;
  mid: number;
  /** ask - bid, TODO el día acumulado. Negativo = domina la venta. */
  net: number;
  total: number;
  enough: boolean;
}

/** Suma cruda de compra/venta/mid de TODOS los strikes — el "libro" completo del día. */
export function netAggressorTotals(acc: FlowAccumulator): NetAggressorTotals {
  let ask = 0;
  let bid = 0;
  let mid = 0;
  for (const b of Object.values(acc.buckets)) {
    ask += b.ask;
    bid += b.bid;
    mid += b.mid;
  }
  const total = ask + bid + mid;
  return { ask, bid, mid, net: ask - bid, total, enough: total >= MIN_SAMPLE_TOTAL };
}

export interface ClassifiedFlow {
  /** Contratos clasificados alcistas: calls comprados (ask) + puts vendidos (bid). */
  bull: number;
  /** Contratos clasificados bajistas: puts comprados (ask) + calls vendidos (bid). */
  bear: number;
  /** Dominancia del CVD 0-1 = |ask−bid|/total del libro completo. */
  cvdDom: number | null;
}

/**
 * Flujo clasificado por dirección real (no solo compra/venta ciega a
 * call/put) — insumo de `lib/zerodteAlt.ts` (flowLean/flowWeight). A
 * diferencia del proyecto standalone (que usa PREMIUM $ de "bursts"
 * recientes), acá se suman CONTRATOS acumulados de toda la sesión desde este
 * mismo acumulador — mismos datos reales de MarketSnack que ya usa el resto
 * del panel, sin un feed nuevo. PURA.
 */
export function classifiedFlow(acc: FlowAccumulator): ClassifiedFlow {
  let bull = 0, bear = 0, ask = 0, bid = 0;
  for (const b of Object.values(acc.buckets)) {
    if (b.type === "call") { bull += b.ask; bear += b.bid; }
    else { bull += b.bid; bear += b.ask; }
    ask += b.ask; bid += b.bid;
  }
  const total = ask + bid;
  return { bull, bear, cvdDom: total > 0 ? Math.abs(ask - bid) / total : null };
}

export interface VolumeVelocity {
  /** Contratos nuevos en el ciclo más reciente (~último minuto). */
  lastAdded: number;
  /** Promedio de contratos nuevos por ciclo en el resto de la ventana. */
  windowAvg: number;
  /** lastAdded / windowAvg. null si todavía no hay suficiente historia. */
  ratio: number | null;
  /** Serie de "added" por ciclo, más viejo primero — para el mini gráfico de barras. */
  series: number[];
  /** Serie de CVD acumulado DENTRO de la ventana reciente (no el del día completo) — para el sparkline. */
  cvdSeries: number[];
}

/**
 * Compara el último ciclo (~1 min) contra el promedio de los ciclos anteriores de la
 * ventana. PURA. Necesita ≥2 ciclos para dar un ratio; con uno solo no hay contra qué comparar.
 */
export function volumeVelocity(acc: FlowAccumulator): VolumeVelocity {
  const cycles = acc.recentCycles;
  const series = cycles.map((c) => c.added);
  const cvdSeries: number[] = [];
  let running = 0;
  for (const c of cycles) {
    running += c.net;
    cvdSeries.push(running);
  }

  if (cycles.length === 0) return { lastAdded: 0, windowAvg: 0, ratio: null, series, cvdSeries };

  const last = cycles[cycles.length - 1];
  const rest = cycles.slice(0, -1);
  if (rest.length === 0) {
    return { lastAdded: last.added, windowAvg: 0, ratio: null, series, cvdSeries };
  }
  const windowAvg = rest.reduce((s, c) => s + c.added, 0) / rest.length;
  const ratio = windowAvg > 0 ? last.added / windowAvg : null;
  return { lastAdded: last.added, windowAvg, ratio, series, cvdSeries };
}

/**
 * Construye la cadena (ZRow[]) desde los buckets de un streamer de Tastytrade
 * (índice/ETF o futuro nativo) — mismo formato para ambos. Cada strike aporta
 * su OI, griegos (gamma/delta/iv), volumen y quotes reales. PURA.
 */
export function bucketsToRows(buckets: Record<string, AggBucket>, expiration: string, ticker: string): ZRow[] {
  const rows: ZRow[] = [];
  for (const b of Object.values(buckets)) {
    if (!b || !(b.strike > 0)) continue;
    rows.push({
      optionTicker: `${ticker}-${expiration}-${b.strike}-${b.type[0].toUpperCase()}`,
      contractType: b.type,
      expiration,
      strike: b.strike,
      openInterest: b.oi ?? 0,
      volume: b.volume ?? 0,
      bid: b.bidPrice ?? null,
      ask: b.askPrice ?? null,
      greeks: { delta: b.delta ?? null, gamma: b.gamma ?? null, theta: null, vega: null, iv: b.iv ?? null },
    });
  }
  return rows;
}

// ----------------------------------------------- superposición en tiempo real

export interface OverlayResult {
  rows: ZRow[];
  realtimeStrikes: number;
  newestTs: number;
}

/**
 * Superpone la foto en tiempo real de MarketSnack sobre las filas de Schwab.
 * PURA. Schwab está completa pero retrasada ~15 min; MarketSnack es fresco
 * (~30 s) pero solo cubre lo que operó. Solo se pisa un campo si MarketSnack
 * lo trae; nunca se degrada un dato bueno de Schwab por un hueco de MarketSnack.
 */
export function overlayRealtime(rows: ZRow[], acc: FlowAccumulator | null): OverlayResult {
  if (!acc || !acc.buckets) return { rows, realtimeStrikes: 0, newestTs: 0 };
  let realtimeStrikes = 0;
  let newestTs = 0;

  const out = rows.map((r) => {
    const b = acc.buckets[bucketKey(r.contractType, r.strike)];
    if (!b || b.gamma == null) return r;
    realtimeStrikes += 1;
    if (b.ts > newestTs) newestTs = b.ts;

    const greeks: ZContractGreeks = {
      ...(r.greeks ?? { delta: null, gamma: null, theta: null, vega: null, iv: null }),
      gamma: b.gamma,
      delta: b.delta ?? r.greeks?.delta ?? null,
      iv: b.iv ?? r.greeks?.iv ?? null,
    };
    return {
      ...r,
      openInterest: b.oi > 0 ? b.oi : r.openInterest,
      volume: Math.max(b.volume, r.volume),
      bid: b.bidPrice ?? r.bid ?? null,
      ask: b.askPrice ?? r.ask ?? null,
      greeks,
    };
  });

  return { rows: out, realtimeStrikes, newestTs };
}

// ------------------------------------------------------------------ persistencia

function fileFor(ticker: string, date: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}-${date}.json`);
}

export async function loadFlow(ticker: string, date: string): Promise<FlowAccumulator> {
  try {
    const raw = await fs.readFile(fileFor(ticker, date), "utf8");
    const parsed = JSON.parse(raw) as FlowAccumulator;
    if (parsed.date !== date || typeof parsed.buckets !== "object") {
      return emptyAccumulator(ticker, date);
    }
    return { ...emptyAccumulator(ticker, date), ...parsed };
  } catch {
    return emptyAccumulator(ticker, date);
  }
}

export async function saveFlow(acc: FlowAccumulator): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(acc.ticker, acc.date), JSON.stringify(acc), "utf8");
}

/** Fecha de mercado de hoy — reexportada para que las rutas no dupliquen la lógica. */
export const flowDate = marketDateStr;
