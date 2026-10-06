// Clasificación del flujo (Time & Sales) según el Scorecard — sub-agente Agresividad.
// Funciones puras: reciben trades crudos de MarketSnack + `now`, devuelven filas procesadas.

import { conditionOf, isCanceledCondition, isMultiLegCondition } from "./conditions";
import { daysToExpiration, parseOcc } from "./occ";

export interface RawTrade {
  id: number;
  symbol: string;
  price: number;
  size: number;
  side: string;
  bid_price: number;
  ask_price: number;
  premium: number;
  delta: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  implied_volatility: number;
  open_interest: number;
  volume: number;
  score: number;
  sentiment: string;
  timestamp: string;
  asset_price?: number; // precio del subyacente en el momento del trade
  trade_condition_id?: number; // condición OPRA: define single vs multi leg
}

export type Aggression = "ask" | "bid" | "mid" | "unknown";

export interface FlowFlags {
  big: boolean; // ≥ $1M
  convDelta: boolean; // ≥ $100K y |delta| > .60
  aboveAsk: boolean;
  belowBid: boolean;
  mid: boolean;
  leap: boolean; // DTE largo (LEAP-ish)
  repeated: boolean; // repetido en ventana de 5 min
  multileg: boolean; // condición OPRA de multi leg (MLET/MLAT/MLCT/MLFT/CBMO/MCTP)
  simultaneous: boolean; // mismo timestamp que otros contratos del mismo subyacente
  exceededOI: boolean; // volumen del contrato > Open Interest
}

/** Sub-scores del scorecard del sub-agente (0-10 cada uno). */
export interface TradeScores {
  volume: number; // por # de contratos
  timing: number; // por horario (ET)
  repetition: number; // por repetición del mismo strike
  total: number; // suma (0-30)
}

export interface FlowRow {
  id: number;
  symbol: string;
  underlying: string;
  type: "call" | "put" | "unknown";
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  price: number;
  size: number;
  side: string;
  aggression: Aggression;
  assetPrice: number;
  bid: number;
  ask: number;
  premium: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** Decaimiento diario como % del precio del contrato: |theta| / price × 100. */
  thetaPctDaily: number | null;
  iv: number;
  openInterest: number;
  volume: number;
  score: number;
  sentiment: string;
  timestamp: string;
  /** Código OPRA de la condición (ej. "SLAN", "MLET") y su nombre legible. */
  conditionCode: string | null;
  conditionName: string | null;
  flags: FlowFlags;
  scores: TradeScores;
  unusual: boolean; // puntaje inusual → resaltar en amarillo
  interesting: boolean;
  /** Estado del contrato respecto a HOY (los trades pueden ser de hace semanas). */
  expiryStatus: "expirado" | "expira_hoy" | "vigente" | "desconocido";
}

// Umbrales (ajustables) tomados del Scorecard.
export const BIG_PREMIUM = 1_000_000;
export const CONVICTION_PREMIUM = 100_000;
export const CONVICTION_DELTA = 0.6;
export const AGGRESSIVE_FLOOR = 50_000; // piso para que un above-ask/below-bid "cuente"
export const REPEAT_WINDOW_MS = 5 * 60 * 1000;
export const REPEAT_MIN_COUNT = 3;
export const LEAP_DTE = 90;

const ASK_SIDES = new Set(["ABOVE_ASK", "ASKSIDE", "AT_ASK"]);
const BID_SIDES = new Set(["BELOW_BID", "BIDSIDE", "AT_BID"]);

export const UNUSUAL_TOTAL = 24; // total (de 30) para marcar el trade como "inusual" (resaltar)

/** A. Puntuación por Volumen (# de contratos). */
export function volumeScore(size: number, premium: number): number {
  if (size >= 150) return 10;
  if (size >= 100) return 8;
  if (size >= 50) return 6;
  if (size >= 20) return 4;
  if (size < 20 && premium > 500_000) return 1;
  return 0;
}

/** Minutos desde medianoche en horario del mercado (ET). */
function etMinutes(ts: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ts));
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}

/** B. Puntuación por Momento (horario ET). */
export function timingScore(ts: string): number {
  const min = etMinutes(ts);
  if (min == null) return 3;
  if (min >= 660 && min <= 780) return 10; // 11:00–13:00 Mediodía
  if (min >= 570 && min <= 630) return 7; //  9:30–10:30 Apertura
  if (min >= 900 && min <= 960) return 6; // 15:00–16:00 Cierre
  return 3; // Otros horarios
}

/** C. Puntuación por Repetición (nº de trades sobre el mismo contrato). */
export function repetitionScore(count: number): number {
  if (count >= 3) return 10;
  if (count === 2) return 7;
  if (count === 1) return 4;
  return 1;
}

export function aggressionOf(side: string): Aggression {
  if (ASK_SIDES.has(side)) return "ask";
  if (BID_SIDES.has(side)) return "bid";
  if (side === "MIDMKT") return "mid";
  return "unknown";
}

/** Convierte un trade crudo en FlowRow (sin las banderas cross-row: repeated/multileg). */
function baseRow(raw: RawTrade, now: Date): FlowRow {
  const occ = parseOcc(raw.symbol);
  const dte = occ ? daysToExpiration(occ.expiration, now) : null;
  const aggression = aggressionOf(raw.side);
  const premium = raw.premium ?? 0;
  const delta = raw.delta ?? 0;

  const flags: FlowFlags = {
    big: premium >= BIG_PREMIUM,
    convDelta: premium >= CONVICTION_PREMIUM && Math.abs(delta) > CONVICTION_DELTA,
    aboveAsk: aggression === "ask",
    belowBid: aggression === "bid",
    mid: aggression === "mid",
    leap: dte != null && dte >= LEAP_DTE,
    repeated: false,
    multileg: isMultiLegCondition(raw.trade_condition_id),
    simultaneous: false,
    exceededOI: (raw.volume ?? 0) > (raw.open_interest ?? 0) && (raw.open_interest ?? 0) > 0,
  };

  return {
    id: raw.id,
    symbol: raw.symbol,
    underlying: occ?.underlying ?? raw.symbol,
    type: occ?.type ?? "unknown",
    strike: occ?.strike ?? null,
    expiration: occ?.expiration ?? null,
    dte,
    price: raw.price,
    size: raw.size,
    side: raw.side,
    aggression,
    assetPrice: raw.asset_price ?? 0,
    bid: raw.bid_price,
    ask: raw.ask_price,
    premium,
    delta,
    gamma: raw.gamma ?? 0,
    theta: raw.theta ?? 0,
    vega: raw.vega ?? 0,
    thetaPctDaily:
      raw.theta != null && raw.price > 0 ? (Math.abs(raw.theta) / raw.price) * 100 : null,
    iv: raw.implied_volatility,
    openInterest: raw.open_interest,
    volume: raw.volume,
    score: raw.score,
    sentiment: raw.sentiment,
    timestamp: raw.timestamp,
    conditionCode: conditionOf(raw.trade_condition_id)?.code ?? null,
    conditionName: conditionOf(raw.trade_condition_id)?.name ?? null,
    flags,
    scores: { volume: 0, timing: 0, repetition: 0, total: 0 },
    unusual: false,
    interesting: false,
    expiryStatus: dte == null ? "desconocido" : dte < 0 ? "expirado" : dte === 0 ? "expira_hoy" : "vigente",
  };
}

function markRepeated(rows: FlowRow[]): void {
  // Agrupa por contrato+lado; marca los que forman ≥REPEAT_MIN_COUNT en 5 min.
  const groups = new Map<string, FlowRow[]>();
  for (const r of rows) {
    const key = `${r.symbol}|${r.aggression}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  for (const group of groups.values()) {
    if (group.length < REPEAT_MIN_COUNT) continue;
    const sorted = [...group].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    let start = 0;
    for (let end = 0; end < sorted.length; end++) {
      while (
        Date.parse(sorted[end].timestamp) - Date.parse(sorted[start].timestamp) >
        REPEAT_WINDOW_MS
      ) {
        start++;
      }
      if (end - start + 1 >= REPEAT_MIN_COUNT) {
        for (let i = start; i <= end; i++) sorted[i].flags.repeated = true;
      }
    }
  }
}

function markSimultaneous(rows: FlowRow[]): void {
  // Mismo timestamp exacto + mismo subyacente, en ≥2 contratos distintos.
  // OJO: esto NO define multileg (para eso está la condición OPRA); es solo una
  // señal de ejecuciones simultáneas.
  const groups = new Map<string, FlowRow[]>();
  for (const r of rows) {
    const key = `${r.underlying}|${r.timestamp}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  for (const group of groups.values()) {
    const distinctContracts = new Set(group.map((r) => r.symbol));
    if (distinctContracts.size >= 2) {
      for (const r of group) r.flags.simultaneous = true;
    }
  }
}

function computeInteresting(r: FlowRow): boolean {
  if (r.flags.mid) return false; // los mid se descartan por ahora
  return (
    r.flags.big ||
    r.flags.convDelta ||
    r.flags.repeated ||
    r.flags.multileg ||
    r.flags.simultaneous ||
    ((r.flags.aboveAsk || r.flags.belowBid) && r.premium >= AGGRESSIVE_FLOOR)
  );
}

/** Se queda con un solo trade por contrato: el de mayor premium. */
export function dedupeByContract(rows: FlowRow[]): FlowRow[] {
  const best = new Map<string, FlowRow>();
  for (const r of rows) {
    const prev = best.get(r.symbol);
    if (!prev || r.premium > prev.premium) best.set(r.symbol, r);
  }
  return [...best.values()];
}

export interface ClassifiedFlow {
  rows: FlowRow[];
  interesting: FlowRow[];
}

/** Pipeline completo: crudo → filas clasificadas + subconjunto "interesante". */
export function classifyFlow(raw: RawTrade[], now: Date): ClassifiedFlow {
  // Las transacciones canceladas se descartan: la orden se anuló, no existió.
  const rows = raw
    .filter((t) => !isCanceledCondition(t.trade_condition_id))
    .map((t) => baseRow(t, now));
  markRepeated(rows);
  markSimultaneous(rows);
  scoreRows(rows);
  for (const r of rows) r.interesting = computeInteresting(r);
  const interesting = rows
    .filter((r) => r.interesting)
    .sort((a, b) => b.premium - a.premium);
  return { rows, interesting };
}

/** Aplica el sistema de puntuación del sub-agente (volumen, momento, repetición). */
function scoreRows(rows: FlowRow[]): void {
  // Repeticiones = nº de trades sobre el mismo contrato.
  const perContract = new Map<string, number>();
  for (const r of rows) perContract.set(r.symbol, (perContract.get(r.symbol) ?? 0) + 1);
  for (const r of rows) {
    const volume = volumeScore(r.size, r.premium);
    const timing = timingScore(r.timestamp);
    const repetition = repetitionScore(perContract.get(r.symbol) ?? 1);
    const total = volume + timing + repetition;
    r.scores = { volume, timing, repetition, total };
    r.unusual = total >= UNUSUAL_TOTAL;
  }
}

// ---- Detección de racimos (acumulación de trades) ----
export const CLUSTER_WINDOW_MS = 5 * 60 * 1000; // gap máx entre trades del racimo
export const CLUSTER_MIN_COUNT = 3; // mínimo de trades para contar como racimo
export const CLUSTER_MIN_PREMIUM = 500_000; // premium acumulado mínimo

export interface Cluster {
  startSec: number;
  endSec: number;
  count: number;
  premiumAsk: number;
  premiumBid: number;
  premium: number;
  direction: "ask" | "bid";
  unidirectionality: number; // 0..1 (qué tan de un solo lado)
  score: number; // 0-10 (fuerza: cantidad + dinero + unidireccionalidad)
  trades: FlowRow[];
  // Composición call/put y apuesta neta (comprar puts = bajista, no alcista):
  callPremium: number;
  putPremium: number;
  bullishPremium: number; // compra de calls + venta de puts
  bearishPremium: number; // compra de puts + venta de calls
  bet: "alcista" | "bajista";
  betLabel: string; // ej. "Compraron PUTS"
}

/**
 * Detecta racimos: bursts de ≥minCount trades notables (ask/bid) contiguos
 * (gap ≤ windowMs) con premium acumulado ≥ minPremium. Devuelve dirección y fuerza.
 */
export function detectClusters(
  rows: FlowRow[],
  opts: { windowMs?: number; minCount?: number; minPremium?: number } = {},
): Cluster[] {
  const windowMs = opts.windowMs ?? CLUSTER_WINDOW_MS;
  const minCount = opts.minCount ?? CLUSTER_MIN_COUNT;
  const minPremium = opts.minPremium ?? CLUSTER_MIN_PREMIUM;

  const sorted = rows
    .filter((r) => r.aggression === "ask" || r.aggression === "bid")
    .map((r) => ({ r, sec: Math.floor(Date.parse(r.timestamp) / 1000) }))
    .filter((x) => Number.isFinite(x.sec))
    .sort((a, b) => a.sec - b.sec);

  const clusters: Cluster[] = [];
  let group: { r: FlowRow; sec: number }[] = [];

  const flush = () => {
    if (group.length >= minCount) {
      let ask = 0, bid = 0;
      let callP = 0, putP = 0;
      // 4 cubetas: compra de calls / compra de puts / venta de calls / venta de puts
      const buckets = { callAsk: 0, putAsk: 0, callBid: 0, putBid: 0 };
      for (const g of group) {
        const p = g.r.premium;
        if (g.r.aggression === "ask") ask += p;
        else bid += p;
        if (g.r.type === "call") callP += p;
        else if (g.r.type === "put") putP += p;
        if (g.r.type === "call") {
          if (g.r.aggression === "ask") buckets.callAsk += p;
          else buckets.callBid += p;
        } else if (g.r.type === "put") {
          if (g.r.aggression === "ask") buckets.putAsk += p;
          else buckets.putBid += p;
        } else {
          // tipo desconocido: cae al criterio simple ask=alcista / bid=bajista
          if (g.r.aggression === "ask") buckets.callAsk += p;
          else buckets.callBid += p;
        }
      }
      const premium = ask + bid;
      if (premium >= minPremium) {
        const direction = ask >= bid ? "ask" : "bid";
        const unid = premium > 0 ? Math.max(ask, bid) / premium : 0;
        const normCount = Math.min(1, group.length / 10);
        const normPrem = Math.min(1, premium / 2_000_000);
        const score = Math.round(10 * (0.4 * normCount + 0.3 * normPrem + 0.3 * unid));
        // Apuesta neta: compra de calls y venta de puts empujan alcista;
        // compra de puts y venta de calls empujan bajista.
        const bullish = buckets.callAsk + buckets.putBid;
        const bearish = buckets.putAsk + buckets.callBid;
        const bet = bullish >= bearish ? "alcista" : "bajista";
        const labels: [number, string][] = [
          [buckets.callAsk, "Compraron CALLS"],
          [buckets.putAsk, "Compraron PUTS"],
          [buckets.callBid, "Vendieron CALLS"],
          [buckets.putBid, "Vendieron PUTS"],
        ];
        labels.sort((a, b) => b[0] - a[0]);
        clusters.push({
          startSec: group[0].sec,
          endSec: group[group.length - 1].sec,
          count: group.length,
          premiumAsk: ask,
          premiumBid: bid,
          premium,
          direction,
          unidirectionality: unid,
          score,
          trades: group.map((g) => g.r),
          callPremium: callP,
          putPremium: putP,
          bullishPremium: bullish,
          bearishPremium: bearish,
          bet,
          betLabel: labels[0][1],
        });
      }
    }
    group = [];
  };

  for (const x of sorted) {
    if (group.length === 0) { group.push(x); continue; }
    const gap = (x.sec - group[group.length - 1].sec) * 1000;
    if (gap <= windowMs) group.push(x);
    else { flush(); group = [x]; }
  }
  flush();
  return clusters;
}

// ============================================================================
// Sub-agente 2 — CONVICCIÓN
// Mide la calidad/decisión del flujo: spread, dominancia ask-vs-bid y fuerza
// de ejecución. Ver SCOREDCARD/Conviccion.md
// ============================================================================

/** Umbral de premium para alertar sobre spreads muy anchos (>10%). */
export const WIDE_SPREAD_ALERT_PREMIUM = 1_000_000;

/** Spread relativo de un trade: (ask − bid) / mid, en %. Null si no hay quote. */
export function spreadPct(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (ask + bid) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 100;
}

/** Puntuación por spread (0-10). >10% no puntúa: se separa aparte. */
export function spreadScore(pct: number | null): number {
  if (pct == null) return 0;
  if (pct < 2) return 10;
  if (pct <= 5) return 7;
  if (pct <= 10) return 4;
  return 0; // spread ancho → se aparta del análisis normal
}

/** Un spread > 10% se separa para revisión aparte. */
export function isWideSpread(pct: number | null): boolean {
  return pct != null && pct > 10;
}

/** Puntuación por dominancia de un lado (% del premium en el lado dominante). */
export function dominanceScore(pctDominant: number): number {
  if (pctDominant >= 80) return 10;
  if (pctDominant >= 70) return 8;
  if (pctDominant >= 60) return 6;
  if (pctDominant >= 55) return 4;
  if (pctDominant >= 50) return 2;
  return 0;
}

export type ExecutionLevel = "above_ask" | "below_bid" | "at_ask" | "at_bid" | "near" | "mid" | "unclear";

/**
 * Nivel de ejecución: dónde cayó el precio del trade respecto al spread.
 * "Cerca" = dentro del 20% del spread desde el ask o el bid.
 */
export function executionLevel(price: number, bid: number, ask: number, side: string): ExecutionLevel {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return "unclear";
  if (price > ask) return "above_ask";
  if (price < bid) return "below_bid";
  const width = ask - bid;
  if (width <= 0) return price >= ask ? "at_ask" : "at_bid";
  if (price >= ask) return "at_ask";
  if (price <= bid) return "at_bid";
  const fromAsk = (ask - price) / width;
  const fromBid = (price - bid) / width;
  if (fromAsk <= 0.2 || fromBid <= 0.2) return "near";
  // Zona media: si está muy centrado es mid; si no, nos apoyamos en el lado reportado.
  if (Math.abs(fromAsk - fromBid) < 0.2) return "mid";
  return side === "MIDMKT" ? "mid" : "near";
}

/** Puntuación por fuerza de ejecución (0-10). La dirección se etiqueta aparte. */
export function executionScore(level: ExecutionLevel): number {
  switch (level) {
    case "above_ask":
    case "below_bid":
      return 10;
    case "at_ask":
    case "at_bid":
      return 8;
    case "near":
      return 6;
    case "mid":
      return 3;
    default:
      return 0;
  }
}

export const EXECUTION_LABEL: Record<ExecutionLevel, string> = {
  above_ask: "Sobre el ask",
  below_bid: "Bajo el bid",
  at_ask: "En el ask",
  at_bid: "En el bid",
  near: "Cerca del borde",
  mid: "En el medio",
  unclear: "Sin claridad",
};

export interface ConvictionScore {
  score: number; // 0-10 final de la categoría
  spread: { avgPct: number | null; points: number; wideCount: number; wideAlert: FlowRow[] };
  dominance: { askPct: number; bidPct: number; dominantPct: number; side: "ask" | "bid"; points: number };
  execution: { points: number; avgRaw: number; counts: Record<ExecutionLevel, number> };
  n: number;
}

/**
 * Score de Convicción (0-10) = promedio de los 3 sub-scores (spread, dominancia,
 * fuerza de ejecución), ponderando por premium donde aplica.
 */
export function convictionScore(rows: FlowRow[]): ConvictionScore {
  const counts: Record<ExecutionLevel, number> = {
    above_ask: 0, below_bid: 0, at_ask: 0, at_bid: 0, near: 0, mid: 0, unclear: 0,
  };

  let spreadWeighted = 0, spreadWeight = 0, wideCount = 0;
  const wideAlert: FlowRow[] = [];
  let askPrem = 0, bidPrem = 0;
  let execWeighted = 0, execWeight = 0;

  for (const r of rows) {
    const pct = spreadPct(r.bid, r.ask);
    if (pct != null) {
      if (isWideSpread(pct)) {
        wideCount++;
        if (r.premium >= WIDE_SPREAD_ALERT_PREMIUM) wideAlert.push(r);
      } else {
        spreadWeighted += pct * r.premium;
        spreadWeight += r.premium;
      }
    }

    if (r.aggression === "ask") askPrem += r.premium;
    else if (r.aggression === "bid") bidPrem += r.premium;

    const level = executionLevel(r.price, r.bid, r.ask, r.side);
    counts[level]++;
    execWeighted += executionScore(level) * r.premium;
    execWeight += r.premium;
  }

  const avgSpreadPct = spreadWeight > 0 ? spreadWeighted / spreadWeight : null;
  const spreadPoints = spreadScore(avgSpreadPct);

  const totalDir = askPrem + bidPrem;
  const askPct = totalDir > 0 ? (askPrem / totalDir) * 100 : 0;
  const bidPct = totalDir > 0 ? (bidPrem / totalDir) * 100 : 0;
  const dominantPct = Math.max(askPct, bidPct);
  const domPoints = totalDir > 0 ? dominanceScore(dominantPct) : 0;

  const execAvg = execWeight > 0 ? execWeighted / execWeight : 0;

  const score = Math.round((spreadPoints + domPoints + execAvg) / 3);

  return {
    score,
    spread: { avgPct: avgSpreadPct, points: spreadPoints, wideCount, wideAlert: wideAlert.sort((a, b) => b.premium - a.premium) },
    dominance: { askPct, bidPct, dominantPct, side: askPct >= bidPct ? "ask" : "bid", points: domPoints },
    execution: { points: Math.round(execAvg), avgRaw: execAvg, counts },
    n: rows.length,
  };
}

// ============================================================================
// Sub-agente 3 — INUSUALIDAD
// Identifica transacciones inusuales de los últimos 30 días: operaciones con
// parámetros de "griegos" propios de grandes instituciones.
// Ver SCOREDCARD/Inusualidad.md
// ============================================================================

/** Tamaño de la orden (premium en $). */
export function orderSizeScore(premium: number): number {
  if (premium > 5_000_000) return 10;
  if (premium >= 1_000_000) return 8;
  if (premium >= 500_000) return 7;
  if (premium >= 200_000) return 5;
  if (premium >= 100_000) return 3;
  return 0;
}

/** Delta (se usa el valor absoluto: un put de −0.85 es tan direccional como un call de +0.85). */
export function deltaScore(delta: number): number {
  const d = Math.abs(delta);
  if (d >= 0.8) return 10;
  if (d >= 0.7) return 8;
  if (d >= 0.6) return 7;
  if (d >= 0.5) return 5;
  return 0;
}

/** Theta como % de decaimiento diario sobre el precio del contrato. */
export function thetaScore(pctDaily: number | null): number {
  if (pctDaily == null) return 0;
  if (pctDaily < 1) return 10;
  if (pctDaily <= 3) return 8;
  if (pctDaily <= 5) return 5;
  return 0;
}

/** Gamma: la zona 0.01–0.08 es la "institucional"; muy alta o muy baja puntúa menos. */
export function gammaScore(gamma: number): number {
  const g = Math.abs(gamma);
  if (g < 0.01) return 2;
  if (g <= 0.08) return 10;
  if (g <= 0.15) return 8;
  return 4;
}

/** Condición de transacción: una sola pata es más limpia de leer que un multileg. */
export function legScore(multileg: boolean): number {
  return multileg ? 5 : 10;
}

/** Vencimiento (días para expirar). */
export function expiryScore(dte: number | null): number {
  if (dte == null) return 0;
  if (dte >= 120) return 10; // incluye los LEAPs de ~320 días
  if (dte >= 90) return 8;
  if (dte >= 60) return 7;
  if (dte >= 30) return 5;
  return 2;
}

export interface UnusualScores {
  size: number;
  delta: number;
  theta: number;
  gamma: number;
  leg: number;
  expiry: number;
  total: number; // 0-10 (promedio de los 6)
}

/** Puntúa un trade con la tabla de Inusualidad (6 parámetros → promedio 0-10). */
export function unusualTradeScore(r: FlowRow): UnusualScores {
  const size = orderSizeScore(r.premium);
  const delta = deltaScore(r.delta);
  const theta = thetaScore(r.thetaPctDaily);
  const gamma = gammaScore(r.gamma);
  const leg = legScore(r.flags.multileg);
  const expiry = expiryScore(r.dte);
  const total = (size + delta + theta + gamma + leg + expiry) / 6;
  return { size, delta, theta, gamma, leg, expiry, total: Math.round(total * 10) / 10 };
}

/** Umbral para etiquetar un trade como "inusual" (grado institucional). */
export const UNUSUAL_TRADE_THRESHOLD = 7;

export interface UnusualityScore {
  score: number; // 0-10 de la categoría
  avgByParam: { size: number; delta: number; theta: number; gamma: number; leg: number; expiry: number };
  unusualCount: number; // trades con total ≥ umbral
  n: number;
  top: { row: FlowRow; scores: UnusualScores }[]; // más inusuales, ordenados
}

/**
 * Score de Inusualidad (0-10): promedio ponderado por premium del puntaje
 * inusual de cada trade (los tickets grandes pesan más).
 */
export function unusualityScore(rows: FlowRow[]): UnusualityScore {
  if (rows.length === 0) {
    return {
      score: 0,
      avgByParam: { size: 0, delta: 0, theta: 0, gamma: 0, leg: 0, expiry: 0 },
      unusualCount: 0,
      n: 0,
      top: [],
    };
  }

  const scored = rows.map((row) => ({ row, scores: unusualTradeScore(row) }));

  let weighted = 0, weight = 0;
  const sums = { size: 0, delta: 0, theta: 0, gamma: 0, leg: 0, expiry: 0 };
  for (const { row, scores } of scored) {
    const w = Math.max(row.premium, 1);
    weighted += scores.total * w;
    weight += w;
    sums.size += scores.size;
    sums.delta += scores.delta;
    sums.theta += scores.theta;
    sums.gamma += scores.gamma;
    sums.leg += scores.leg;
    sums.expiry += scores.expiry;
  }

  const n = scored.length;
  const avg = (v: number) => Math.round((v / n) * 10) / 10;

  return {
    score: Math.round(weight > 0 ? weighted / weight : 0),
    avgByParam: {
      size: avg(sums.size), delta: avg(sums.delta), theta: avg(sums.theta),
      gamma: avg(sums.gamma), leg: avg(sums.leg), expiry: avg(sums.expiry),
    },
    unusualCount: scored.filter((s) => s.scores.total >= UNUSUAL_TRADE_THRESHOLD).length,
    n,
    top: scored.sort((a, b) => b.scores.total - a.scores.total || b.row.premium - a.row.premium).slice(0, 150),
  };
}

export interface AggressionScore {
  score: number; // 0-10 (casilla del scorecard)
  ratio: number; // premium al ask / (ask + bid)
  premiumAsk: number;
  premiumBid: number;
  premiumMid: number;
  n: number; // nº de transacciones notables consideradas
}

/**
 * Score de Agresividad (0-10) — "¿compran al ask con fuerza?".
 * Pondera por premium: cuánto del dinero notable entró agresivo al ask vs golpeando el bid.
 * Los mid se reportan pero no cuentan para el ratio. Sin flujo ask/bid → score 0.
 */
export function aggressionScore(rows: FlowRow[]): AggressionScore {
  let ask = 0, bid = 0, mid = 0;
  for (const r of rows) {
    if (r.aggression === "ask") ask += r.premium;
    else if (r.aggression === "bid") bid += r.premium;
    else if (r.aggression === "mid") mid += r.premium;
  }
  const denom = ask + bid;
  const ratio = denom > 0 ? ask / denom : 0;
  return {
    score: denom > 0 ? Math.round(ratio * 10) : 0,
    ratio,
    premiumAsk: ask,
    premiumBid: bid,
    premiumMid: mid,
    n: rows.length,
  };
}
