// Sub-agente 5 — Contexto IV ("¿IV limpia o inflada?", 10% del scorecard).
// Fuente: SCOREDCARD/Contexto-IV.md.
//
// El documento pide dos cosas:
//   1. El promedio de IV por fecha de vencimiento y los contratos de mayor IV
//      → sirve para ver si un movimiento está a punto de pasar.
//   2. El IV Rank → dónde está la IV de hoy dentro de su propio rango histórico,
//      es decir si el movimiento se está comprimiendo o expandiendo.
//
// Nota de escala: MarketSnack entrega la IV en decimal (0.477 = 47.7%). Aquí se
// trabaja SIEMPRE en porcentaje, que es la unidad de las tablas del documento.

import type { FlowRow } from "./flow";
import type { ChainIvSurface } from "./optionChain2";

export interface IvBand {
  points: number;
  band: string;
  /** El documento marca +100% como "categoría especial". */
  special?: boolean;
}

/**
 * Parámetro 1 — Implied Volatility actual.
 * El pico está en la IV MODERADA (40-60%): hay movimiento esperado y la prima
 * todavía es razonable. Hacia arriba baja porque comprar volatilidad cara
 * castiga aunque el precio acompañe (riesgo de IV crush), y hacia abajo baja
 * porque no se espera movimiento ninguno.
 */
export function ivPoints(ivPct: number): IvBand {
  if (!Number.isFinite(ivPct) || ivPct < 0) return { points: 0, band: "sin datos" };
  if (ivPct >= 100) return { points: 6, band: "≥100% — prima muy inflada", special: true };
  if (ivPct >= 90) return { points: 5, band: "90-99% — cara" };
  if (ivPct >= 61) return { points: 8, band: "61-89% — elevada" };
  if (ivPct >= 40) return { points: 10, band: "40-60% — moderada, la zona buena" };
  if (ivPct >= 30) return { points: 5, band: "30-39% — baja" };
  return { points: 2, band: "<30% — muy baja, sin movimiento esperado" };
}

/**
 * Parámetro 2 — IV Rank (0-100): dónde cae la IV de hoy en su rango histórico.
 * El pico está en 16-30%: IV comprimida pero despertando. Por debajo de 15 la
 * acción está dormida (2 pts) y por encima de 70 la volatilidad ya está
 * estirada, con poco recorrido y riesgo de desplome de prima.
 */
export function ivRankPoints(rank: number): IvBand {
  if (!Number.isFinite(rank) || rank < 0) return { points: 0, band: "sin datos" };
  if (rank >= 100) return { points: 0, band: "100% — techo histórico" };
  if (rank >= 71) return { points: 1, band: "71-99% — IV estirada" };
  if (rank >= 51) return { points: 5, band: "51-70% — por encima de su media" };
  if (rank >= 31) return { points: 8, band: "31-50% — en su media" };
  if (rank >= 16) return { points: 10, band: "16-30% — comprimida, lista para expandir" };
  return { points: 2, band: "0-15% — dormida, sin movimiento" };
}

// ---------- volatilidad realizada (proxy del IV Rank) ----------

const TRADING_DAYS = 252;

/**
 * Serie de volatilidad realizada anualizada (%) en ventana móvil.
 * Es el proxy del IV histórico: nadie nos vende una serie de IV de 52 semanas,
 * pero la volatilidad que la acción REALMENTE tuvo sí la podemos calcular.
 */
export function realizedVolSeries(closes: number[], window = 30): number[] {
  if (closes.length < window + 2) return [];
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const out: number[] = [];
  for (let i = window; i <= rets.length; i++) {
    const slice = rets.slice(i - window, i);
    const mean = slice.reduce((s, r) => s + r, 0) / slice.length;
    const varc = slice.reduce((s, r) => s + (r - mean) ** 2, 0) / (slice.length - 1);
    out.push(Math.sqrt(varc * TRADING_DAYS) * 100);
  }
  return out;
}

/** Posición de `current` dentro de [min, max] de la serie, en 0-100. */
export function rankWithin(series: number[], current: number): number | null {
  if (series.length < 2) return null;
  const low = Math.min(...series);
  const high = Math.max(...series);
  if (!(high > low)) return null;
  return Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100));
}

// ---------- reporte ----------

export interface IvExpirationStat {
  expiration: string;
  dte: number | null;
  trades: number;
  avgIv: number;
  maxIv: number;
  premium: number;
}

export interface IvContract {
  id: number;
  symbol: string;
  strike: number | null;
  type: "call" | "put" | "unknown";
  expiration: string | null;
  dte: number | null;
  iv: number;
  premium: number;
  size: number;
}

export type IvRankSource = "tastytrade" | "iv-history" | "realized-proxy" | "none";
export type IvRegime = "dormida" | "compresion" | "expansion" | "normal" | "inflada" | "desconocido";

export interface IvContextScore {
  score: number;
  iv: {
    /** IV ponderada por premium: a qué IV está entrando el dinero de verdad. */
    current: number | null;
    simpleAvg: number | null;
    min: number | null;
    max: number | null;
    contracts: number;
    points: number;
    band: string;
    special: boolean;
    /** "chain" = IV de TODA la cadena (option_chain_extended); "trades" = solo lo que operó. */
    source: "chain" | "trades";
  };
  rank: {
    value: number | null;
    source: IvRankSource;
    /** Cuántos días de historia respaldan el rank. */
    days: number;
    low: number | null;
    high: number | null;
    reference: number | null;
    points: number;
    band: string;
  };
  /** Lo que pide el documento: promedio de IV por fecha de vencimiento. */
  byExpiration: IvExpirationStat[];
  /** Y los contratos que mayor IV tienen. */
  topContracts: IvContract[];
  /** Diferencia entre la IV del vencimiento más cercano y la del resto. */
  frontSkew: number | null;
  regime: IvRegime;
  note: string;
}

const EMPTY: IvContextScore = {
  score: 0,
  iv: { current: null, simpleAvg: null, min: null, max: null, contracts: 0, points: 0, band: "sin datos", special: false, source: "trades" },
  rank: { value: null, source: "none", days: 0, low: null, high: null, reference: null, points: 0, band: "sin datos" },
  byExpiration: [],
  topContracts: [],
  frontSkew: null,
  regime: "desconocido",
  note: "Sin trades con volatilidad implícita en la ventana.",
};

export interface IvContextInput {
  rows: FlowRow[];
  /** Cierres diarios del subyacente (≈1 año) para el proxy del IV Rank. */
  closes: number[];
  /** Historial de IV acumulado día a día; manda sobre el proxy cuando alcanza. */
  ivHistory?: { date: string; avgIv: number }[];
  /**
   * IV Rank REAL de Tastytrade (0-100). Cuando viene, MANDA sobre el historial y
   * el proxy de vol realizada: es el rank verdadero del proveedor, no una
   * estimación. Se cablea desde `lib/tastytrade.ts` (endpoint market-metrics).
   */
  tastytradeIvRank?: number | null;
  /**
   * Superficie de IV de TODA la cadena (option_chain_extended). Si viene, la IV
   * actual y el promedio por vencimiento salen de la cadena completa —mucho más
   * estable que solo lo que operó hoy—. Los `topContracts` siguen siendo trades reales.
   */
  chainIv?: ChainIvSurface;
}

/** Días de historia propia a partir de los cuales el IV Rank real desplaza al proxy. */
export const MIN_IV_HISTORY_DAYS = 60;

export function ivContextScore(input: IvContextInput): IvContextScore {
  const { rows, closes, ivHistory = [], chainIv, tastytradeIvRank } = input;

  // MarketSnack manda la IV en decimal → a porcentaje.
  const withIv = rows.filter((r) => Number.isFinite(r.iv) && r.iv > 0);
  const usingChain = chainIv?.current != null;
  // Sin IV de cadena NI de trades no hay nada que reportar.
  if (withIv.length === 0 && !usingChain) return EMPTY;
  const ivPct = (r: FlowRow) => r.iv * 100;

  // IV representativa de los trades = ponderada por premium. El dinero grande
  // define el contexto; un promedio simple lo dominarían los tickets de 0DTE.
  let wSum = 0, wIv = 0, plain = 0, min = Infinity, max = -Infinity;
  for (const r of withIv) {
    const v = ivPct(r);
    const w = Math.max(r.premium, 1);
    wSum += w; wIv += v * w; plain += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const tradeCurrent = wSum > 0 ? wIv / wSum : null;

  // La IV actual: la de TODA la cadena si viene (más estable), si no la de trades.
  const current = (usingChain ? chainIv!.current! : tradeCurrent) as number;
  const iv = ivPoints(current);
  const ivSource: "chain" | "trades" = usingChain ? "chain" : "trades";

  // --- promedio de IV por vencimiento (lo que pide el documento) ---
  // De la cadena completa si la tenemos; si no, de los trades del flujo.
  let byExpiration: IvExpirationStat[];
  if (usingChain && chainIv!.byExpiration.length > 0) {
    byExpiration = chainIv!.byExpiration.map((e) => ({
      expiration: e.expiration,
      dte: e.dte,
      trades: e.contracts,
      avgIv: e.avgIv,
      maxIv: e.maxIv,
      premium: e.premium,
    }));
  } else {
    const byExpMap = new Map<string, { dte: number | null; ivs: number[]; premium: number }>();
    for (const r of withIv) {
      if (!r.expiration) continue;
      const e = byExpMap.get(r.expiration) ?? { dte: r.dte, ivs: [], premium: 0 };
      e.ivs.push(ivPct(r));
      e.premium += r.premium;
      if (e.dte == null) e.dte = r.dte;
      byExpMap.set(r.expiration, e);
    }
    byExpiration = [...byExpMap.entries()]
      .map(([expiration, e]) => ({
        expiration,
        dte: e.dte,
        trades: e.ivs.length,
        avgIv: e.ivs.reduce((s, v) => s + v, 0) / e.ivs.length,
        maxIv: Math.max(...e.ivs),
        premium: e.premium,
      }))
      .sort((a, b) => (a.dte ?? 1e9) - (b.dte ?? 1e9));
  }

  // Skew del frente: si el vencimiento más cercano cotiza muy por encima del
  // resto, el mercado está pagando por un evento inminente.
  let frontSkew: number | null = null;
  if (byExpiration.length >= 2) {
    const rest = byExpiration.slice(1);
    const restAvg = rest.reduce((s, e) => s + e.avgIv, 0) / rest.length;
    frontSkew = byExpiration[0].avgIv - restAvg;
  }

  const topContracts: IvContract[] = [...withIv]
    .sort((a, b) => b.iv - a.iv)
    .slice(0, 8)
    .map((r) => ({
      id: r.id, symbol: r.symbol, strike: r.strike, type: r.type,
      expiration: r.expiration, dte: r.dte, iv: ivPct(r),
      premium: r.premium, size: r.size,
    }));

  // --- IV Rank: historia propia si alcanza, si no el proxy de vol realizada ---
  let rankValue: number | null = null;
  let source: IvRankSource = "none";
  let days = 0, low: number | null = null, high: number | null = null;
  let reference: number | null = null;

  // Prioridad 1: IV Rank REAL de Tastytrade (cuando está cableado). Es el rank
  // verdadero del proveedor, así que desplaza al historial propio y al proxy.
  if (tastytradeIvRank != null && Number.isFinite(tastytradeIvRank) && tastytradeIvRank >= 0) {
    rankValue = Math.max(0, Math.min(100, tastytradeIvRank));
    source = "tastytrade";
    days = 0;            // Tastytrade da el rank directo, no una serie propia
    reference = current; // la IV mostrada como referencia sigue siendo la actual
  }
  // Prioridad 2: historia propia acumulada (≥60 días).
  if (rankValue == null && ivHistory.length >= MIN_IV_HISTORY_DAYS) {
    const series = ivHistory.map((h) => h.avgIv).filter((v) => Number.isFinite(v) && v > 0);
    rankValue = rankWithin(series, current);
    if (rankValue != null) {
      source = "iv-history"; days = series.length;
      low = Math.min(...series); high = Math.max(...series); reference = current;
    }
  }
  // Prioridad 3: proxy de volatilidad realizada.
  if (rankValue == null) {
    const rv = realizedVolSeries(closes);
    if (rv.length >= 2) {
      const today = rv[rv.length - 1];
      rankValue = rankWithin(rv, today);
      if (rankValue != null) {
        source = "realized-proxy"; days = rv.length;
        low = Math.min(...rv); high = Math.max(...rv); reference = today;
      }
    }
  }

  const rank = rankValue != null ? ivRankPoints(rankValue) : { points: 0, band: "sin datos" };

  // Régimen: cruza el nivel de IV con su posición histórica.
  let regime: IvRegime = "desconocido";
  if (rankValue != null) {
    if (iv.special) regime = "inflada";
    else if (rankValue < 16) regime = "dormida";
    else if (rankValue <= 30) regime = "compresion";
    else if (rankValue >= 71) regime = "expansion";
    else regime = "normal";
  }

  const NOTE: Record<IvRegime, string> = {
    dormida:
      "IV pegada al piso de su propio rango: el mercado no espera movimiento. Las opciones están baratas, " +
      "pero baratas porque nadie cree que pase nada.",
    compresion:
      "IV comprimida contra su propio rango: las opciones están baratas y el movimiento lleva rato guardado. " +
      "Es el terreno donde una apuesta direccional paga mejor si acierta.",
    expansion:
      "IV estirada en la parte alta de su rango: el mercado ya está pagando caro el movimiento. " +
      "Comprar aquí carga con el riesgo de que la prima se desinfle aunque el precio acompañe.",
    inflada:
      "IV por encima de 100%: prima extremadamente inflada. Normalmente hay un evento encima y suele estar " +
      "descontado — el riesgo de IV crush después del anuncio es alto.",
    normal: "IV en la zona media de su rango histórico: ni regalada ni estirada.",
    desconocido: "No hay suficiente historia para situar la IV en su rango.",
  };

  return {
    score: Math.round((iv.points + rank.points) / 2),
    iv: {
      current,
      simpleAvg: withIv.length > 0 ? plain / withIv.length : null,
      min: min === Infinity ? null : min,
      max: max === -Infinity ? null : max,
      contracts: withIv.length,
      points: iv.points,
      band: iv.band,
      special: Boolean(iv.special),
      source: ivSource,
    },
    rank: {
      value: rankValue, source, days, low, high, reference,
      points: rank.points, band: rank.band,
    },
    byExpiration,
    topContracts,
    frontSkew,
    regime,
    note: NOTE[regime],
  };
}
