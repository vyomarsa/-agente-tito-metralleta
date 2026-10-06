// ============================================================================
// Motor GEX — Gamma Exposure de dealer a partir de la cadena de Massive.
// Fusiona el POSICIONAMIENTO (gamma × Open Interest de toda la cadena) con la
// ACTIVIDAD REAL (premium de los trades que están ocurriendo) para dibujar
// "nodos de concentración" y derivar una predicción (precio imán).
//
// Desde la migración a Schwab (jul-2026) la cadena trae gamma e IV REALES por
// contrato, así que el orden de preferencia es:
//  · IV     → media ponderada por OI de la IV real de la cadena; si no hay,
//             se estima de la volatilidad realizada del subyacente
//  · gamma  → la real del contrato; si no hay, Black-Scholes anclado contra la
//             gamma real de la fuente de datos donde ese strike operó
//
// La ruta estimada se conserva intacta como respaldo: si las filas vienen sin
// griegos (p. ej. si la fuente vuelve a ser Massive), el comportamiento es el
// de antes.
//
// Funciones puras y testeables (lib/gex.test.ts). Términos neutros a propósito.
// ============================================================================

import type { Row } from "./types";
import { daysToExpiration } from "./occ";

/** IV de respaldo cuando no hay suficientes barras para estimar. */
export const FALLBACK_IV = 0.4;

/** Solo se consideran strikes dentro de ±este % del spot (los LEAPs lejanos no pintan). */
export const NEAR_SPOT_PCT = 0.2;

/** Peso del GEX vs. premium de trades reales al medir "concentración de dinero". */
const GEX_WEIGHT = 0.6;
const TRADE_WEIGHT = 0.4;

/** Trade mínimo para anclar/sumar (subconjunto estructural de FlowRow). */
export interface TradeLite {
  strike: number | null;
  type: "call" | "put" | "unknown";
  premium: number;
  gamma: number;
}

export interface GexNode {
  strike: number;
  netGex: number;       // callGex − putGex (signo = lado dominante)
  callGex: number;      // magnitud de gamma de calls (≥0)
  putGex: number;       // magnitud de gamma de puts (≥0)
  tradePremium: number; // $ de trades reales en ese strike
  tradeCount: number;
  concentration: number; // 0-1 (dinero concentrado: GEX + actividad)
  side: "call" | "put";  // signo del GEX neto
}

export interface GexAnalysis {
  spot: number;
  iv: number;
  nodes: GexNode[];                 // cerca del spot, ordenados por concentración desc
  kingStrike: number | null;        // nodo principal = precio imán / objetivo
  flipStrike: number | null;        // zona de inversión gamma
  regime: "positive" | "negative";  // gamma neta total
  totalNetGex: number;
  direction: "up" | "down" | "flat" | null;
  confidence: number;               // 0-100
  lowLiquidity: boolean;
  n: number;                        // strikes considerados cerca del spot
  /** "chain" = IV real de la cadena; "realized" = estimada de las barras. */
  ivSource: IvSource;
  /** Fracción 0-1 de contratos que usaron gamma real en vez de Black-Scholes. */
  realGammaShare: number;
}

export type IvSource = "chain" | "realized";

/** Densidad normal estándar φ(x). */
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Gamma de Black-Scholes (r = 0). Devuelve 0 si los insumos no son válidos. */
export function bsGamma(spot: number, strike: number, T: number, iv: number): number {
  if (spot <= 0 || strike <= 0 || T <= 0 || iv <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * sqrtT);
  return phi(d1) / (spot * iv * sqrtT);
}

/** d1, d2 de Black-Scholes con r = q = 0. null si los insumos no valen. */
function d1d2(spot: number, strike: number, T: number, iv: number): [number, number] | null {
  if (spot <= 0 || strike <= 0 || T <= 0 || iv <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * sqrtT);
  return [d1, d1 - iv * sqrtT];
}

/**
 * Vanna de Black-Scholes (r = q = 0): ∂Δ/∂σ = ∂vega/∂S = −φ(d1)·d2/σ.
 * Igual para call y put. Mide cuánto se mueve el delta si cambia la IV — por eso
 * un cambio de volatilidad obliga a los dealers a re-cubrir y empuja el precio.
 */
export function bsVanna(spot: number, strike: number, T: number, iv: number): number {
  const dd = d1d2(spot, strike, T, iv);
  if (!dd) return 0;
  const [d1, d2] = dd;
  return -phi(d1) * d2 / iv;
}

/**
 * Charm de Black-Scholes (r = q = 0): variación del delta por el paso del TIEMPO
 * (calendario), = −φ(d1)·d2/(2T). Igual para call y put con q = 0.
 *
 * Es el griego clave del 0DTE: crece como 1/T, así que se dispara hacia el cierre.
 * El delta que se desvanece obliga a los dealers a re-cubrir, y ese flujo empuja
 * el precio (el "pin" o la deriva de fin de día).
 */
export function bsCharm(spot: number, strike: number, T: number, iv: number): number {
  const dd = d1d2(spot, strike, T, iv);
  if (!dd) return 0;
  const [d1, d2] = dd;
  return -phi(d1) * d2 / (2 * T);
}

/**
 * IV estimada de la volatilidad realizada anualizada de los cierres diarios.
 * `closes` va del más viejo al más reciente. Ventana de hasta 21 sesiones.
 */
export function estimateIV(closes: number[]): number {
  const c = closes.filter((v) => v > 0).slice(-22);
  if (c.length < 3) return FALLBACK_IV;
  const rets: number[] = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const iv = Math.sqrt(variance) * Math.sqrt(252);
  return Math.min(3, Math.max(0.05, iv));
}

/** IV por encima de esto se descarta por absurda (contratos ilíquidos muy OTM). */
export const MAX_SANE_IV = 3;

/**
 * IV real de la cadena: media de la IV por contrato **ponderada por Open Interest**,
 * limitada a strikes cerca del spot (±NEAR_SPOT_PCT).
 *
 * Se pondera por OI porque interesa la IV de donde está el dinero, no la de los
 * strikes muertos. Se acota a MAX_SANE_IV porque los contratos ilíquidos muy OTM
 * reportan IVs disparatadas (en AAPL se vieron hasta 790%) que contaminarían la media.
 *
 * PURA. Devuelve null si la cadena no trae IV real (fuente sin griegos).
 */
// Ventana del fallback de IV (chainIV): ±5%. Antes usaba NEAR_SPOT_PCT (±20%), que
// es para el GEX multi-exp pero DEMASIADO ancha para una IV — a ±20% entran puts
// deep-OTM con IV altísima que sesgan mucho. ±5% mantiene la robustez sin el sesgo.
export const CHAIN_IV_PCT = 0.05;

export function chainIV(rows: Row[], spot: number): number | null {
  if (spot <= 0) return null;
  const lo = spot * (1 - CHAIN_IV_PCT);
  const hi = spot * (1 + CHAIN_IV_PCT);

  let weighted = 0;
  let weight = 0;
  for (const r of rows) {
    const iv = r.greeks?.iv;
    if (typeof iv !== "number" || !(iv > 0) || iv > MAX_SANE_IV) continue;
    if (r.strike < lo || r.strike > hi) continue;
    const oi = r.openInterest;
    if (!(oi > 0)) continue;
    weighted += iv * oi;
    weight += oi;
  }

  if (weight <= 0) return null;
  return weighted / weight;
}

export interface GexInput {
  rows: Row[];
  closes: number[];               // cierres diarios (viejo→nuevo); respaldo para la IV
  spot: number;
  trades?: TradeLite[];
  convictionScore?: number | null; // 0-10
  structureScore?: number | null;  // 0-10
  lowLiquidity?: boolean;
  now: Date;
}

const emptyAnalysis = (
  spot: number,
  iv: number,
  lowLiquidity: boolean,
  ivSource: IvSource,
): GexAnalysis => ({
  spot, iv, nodes: [], kingStrike: null, flipStrike: null,
  regime: "positive", totalNetGex: 0, direction: null, confidence: 0,
  lowLiquidity, n: 0, ivSource, realGammaShare: 0,
});

/**
 * Analiza la cadena: GEX por strike (gamma × OI × 100 × spot² × 0.01, con signo
 * +call/−put), fusiona el premium de trades reales, y deriva nodo principal
 * (imán), zona de inversión gamma, régimen, dirección y confianza.
 */
export function gexAnalysis(input: GexInput): GexAnalysis {
  const { rows, closes, spot, trades = [], convictionScore, structureScore, now } = input;
  // IV real de la cadena si la fuente la trae (Schwab); si no, volatilidad realizada.
  const realIv = chainIV(rows, spot);
  const iv = realIv ?? estimateIV(closes);
  const ivSource: IvSource = realIv !== null ? "chain" : "realized";
  const lowLiquidity = input.lowLiquidity ?? false;
  if (spot <= 0 || rows.length === 0) {
    return emptyAnalysis(spot, iv, lowLiquidity, ivSource);
  }

  // ── Gamma real por strike+lado (promedio) desde los trades, para anclar ──
  const realGamma = new Map<string, { sum: number; n: number }>();
  const tradePrem = new Map<number, { premium: number; count: number }>();
  for (const t of trades) {
    if (t.strike == null || t.type === "unknown") continue;
    if (t.gamma > 0) {
      const k = `${t.strike}|${t.type}`;
      const g = realGamma.get(k) ?? { sum: 0, n: 0 };
      g.sum += Math.abs(t.gamma); g.n += 1; realGamma.set(k, g);
    }
    const p = tradePrem.get(t.strike) ?? { premium: 0, count: 0 };
    p.premium += t.premium; p.count += 1; tradePrem.set(t.strike, p);
  }

  // ── GEX por strike sobre toda la cadena (solo contratos vigentes) ──
  const lo = spot * (1 - NEAR_SPOT_PCT);
  const hi = spot * (1 + NEAR_SPOT_PCT);
  const byStrike = new Map<number, { callGex: number; putGex: number }>();

  let considered = 0;
  let withRealGamma = 0;

  for (const r of rows) {
    if (r.strike < lo || r.strike > hi) continue;
    if (r.openInterest <= 0) continue;
    const dte = daysToExpiration(r.expiration, now);
    if (dte <= 0) continue;
    const T = dte / 365;
    considered += 1;

    // 1º la gamma real del contrato (Schwab). Si no está, Black-Scholes anclado
    // contra la gamma real de la fuente de datos donde ese strike operó.
    const own = r.greeks?.gamma;
    let gamma: number;
    if (typeof own === "number" && own > 0) {
      gamma = own;
      withRealGamma += 1;
    } else {
      gamma = bsGamma(spot, r.strike, T, iv);
      const anchor = realGamma.get(`${r.strike}|${r.contractType}`);
      if (anchor && anchor.n > 0) gamma = (gamma + anchor.sum / anchor.n) / 2;
    }

    const gex = gamma * r.openInterest * 100 * spot * spot * 0.01;
    const s = byStrike.get(r.strike) ?? { callGex: 0, putGex: 0 };
    if (r.contractType === "call") s.callGex += gex;
    else s.putGex += gex;
    byStrike.set(r.strike, s);
  }

  const realGammaShare = considered > 0 ? withRealGamma / considered : 0;

  if (byStrike.size === 0) return emptyAnalysis(spot, iv, lowLiquidity, ivSource);

  // ── Nodos + concentración de dinero (GEX + actividad real) ──
  const raw = [...byStrike.entries()].map(([strike, g]) => {
    const netGex = g.callGex - g.putGex;
    const tp = tradePrem.get(strike);
    return {
      strike, netGex, callGex: g.callGex, putGex: g.putGex,
      tradePremium: tp?.premium ?? 0, tradeCount: tp?.count ?? 0,
      gexMag: Math.abs(netGex),
    };
  });

  const maxGexMag = Math.max(...raw.map((r) => r.gexMag), 0);
  const maxTradePrem = Math.max(...raw.map((r) => r.tradePremium), 0);
  const hasTrades = maxTradePrem > 0;

  const nodes: GexNode[] = raw.map((r) => {
    const gexNorm = maxGexMag > 0 ? r.gexMag / maxGexMag : 0;
    const premNorm = maxTradePrem > 0 ? r.tradePremium / maxTradePrem : 0;
    const concentration = hasTrades ? GEX_WEIGHT * gexNorm + TRADE_WEIGHT * premNorm : gexNorm;
    return {
      strike: r.strike, netGex: r.netGex, callGex: r.callGex, putGex: r.putGex,
      tradePremium: r.tradePremium, tradeCount: r.tradeCount,
      concentration, side: (r.netGex >= 0 ? "call" : "put") as "call" | "put",
    };
  }).sort((a, b) => b.concentration - a.concentration);

  const king = nodes[0] ?? null;
  const kingStrike = king ? king.strike : null;

  // ── Zona de inversión gamma: entre strikes contiguos donde el GEX neto
  // cambia de signo (put-dominante abajo → call-dominante arriba). Se elige el
  // cruce más cercano al spot e interpola el punto medio ponderado.
  const asc = [...raw].sort((a, b) => a.strike - b.strike);
  let flipStrike: number | null = null;
  let bestDist = Infinity;
  for (let i = 1; i < asc.length; i++) {
    const a = asc[i - 1], b = asc[i];
    if ((a.netGex < 0 && b.netGex >= 0) || (a.netGex > 0 && b.netGex <= 0)) {
      const span = Math.abs(a.netGex) + Math.abs(b.netGex);
      const cross = span > 0 ? a.strike + (b.strike - a.strike) * (Math.abs(a.netGex) / span) : (a.strike + b.strike) / 2;
      const dist = Math.abs(cross - spot);
      if (dist < bestDist) { bestDist = dist; flipStrike = cross; }
    }
  }

  const totalNetGex = raw.reduce((s, r) => s + r.netGex, 0);
  const regime: GexAnalysis["regime"] = totalNetGex >= 0 ? "positive" : "negative";

  const direction: GexAnalysis["direction"] =
    kingStrike == null ? null
      : kingStrike > spot * 1.002 ? "up"
        : kingStrike < spot * 0.998 ? "down"
          : "flat";

  // ── Confianza: nitidez del nodo principal (share del GEX) + scores de sub-agentes ──
  const sumGexMag = raw.reduce((s, r) => s + r.gexMag, 0);
  const sharpness = sumGexMag > 0 ? maxGexMag / sumGexMag : 0;
  const subScores = [convictionScore, structureScore].filter((v): v is number => v != null);
  const subAvg = subScores.length > 0 ? subScores.reduce((a, b) => a + b, 0) / subScores.length / 10 : 0.5;
  const confidence = Math.round(100 * Math.min(1, 0.6 * sharpness + 0.4 * subAvg));

  return {
    spot, iv, nodes, kingStrike, flipStrike, regime, totalNetGex,
    direction, confidence, lowLiquidity, n: byStrike.size,
    ivSource, realGammaShare,
  };
}
