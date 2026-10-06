// ============================================================================
// Motor GEX — Gamma Exposure de dealer a partir de la cadena de Massive.
// Fusiona el POSICIONAMIENTO (gamma × Open Interest de toda la cadena) con la
// ACTIVIDAD REAL (premium de los trades que están ocurriendo) para dibujar
// "nodos de concentración" y derivar una predicción (precio imán).
//
// Massive no entrega gamma ni IV en este plan, así que por defecto:
//  · la IV se estima de la volatilidad realizada del subyacente (barras diarias)
//  · la gamma se calcula con Black-Scholes por contrato
//  · donde hay gamma real de MarketSnack (de los trades), se ancla la estimada
//
// Si hay griegos reales de Schwab (Market Data Production, `schwabGreeks` en
// GexInput — ver lib/schwabParse.ts) para un strike+vencimiento, esos GANAN
// sobre la estimación BS y sobre el ancla de MarketSnack: es la fuente más
// fuerte porque viene directo del broker, no de una aproximación.
//
// Funciones puras y testeables (lib/gex.test.ts). Términos neutros a propósito.
// ============================================================================

import type { Row } from "./types";
import { daysToExpiration } from "./occ";
// bsGamma vive en blackScholes.ts (la Wheel usa las mismas primitivas).
// Se re-exporta para no romper a quien la importa desde aquí.
import { bsGamma } from "./blackScholes";
import { greeksKey, type SchwabGreeksMap } from "./schwabParse";
export { bsGamma };

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

export interface GexInput {
  rows: Row[];
  closes: number[];               // cierres diarios (viejo→nuevo) para estimar IV
  spot: number;
  trades?: TradeLite[];
  convictionScore?: number | null; // 0-10
  structureScore?: number | null;  // 0-10
  lowLiquidity?: boolean;
  now: Date;
  /** Griegos e IV reales de Schwab, si /api/schwab-greeks los trajo. Opcional. */
  schwabGreeks?: SchwabGreeksMap;
}

const emptyAnalysis = (spot: number, iv: number, lowLiquidity: boolean): GexAnalysis => ({
  spot, iv, nodes: [], kingStrike: null, flipStrike: null,
  regime: "positive", totalNetGex: 0, direction: null, confidence: 0,
  lowLiquidity, n: 0,
});

/**
 * Analiza la cadena: GEX por strike (gamma × OI × 100 × spot² × 0.01, con signo
 * +call/−put), fusiona el premium de trades reales, y deriva nodo principal
 * (imán), zona de inversión gamma, régimen, dirección y confianza.
 */
export function gexAnalysis(input: GexInput): GexAnalysis {
  const { rows, closes, spot, trades = [], convictionScore, structureScore, now, schwabGreeks } = input;
  let iv = estimateIV(closes);
  const lowLiquidity = input.lowLiquidity ?? false;
  if (spot <= 0 || rows.length === 0) return emptyAnalysis(spot, iv, lowLiquidity);

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
  const nearRows = rows.filter(
    (r) => r.strike >= lo && r.strike <= hi && r.openInterest > 0 && daysToExpiration(r.expiration, now) > 0,
  );

  // IV real de Schwab (promedio ponderado por OI de los strikes cercanos al spot)
  // reemplaza el proxy de volatilidad realizada cuando hay cobertura suficiente —
  // es la base que usan TODOS los strikes sin griego real propio en el loop de abajo.
  if (schwabGreeks) {
    let wSum = 0, wIv = 0;
    for (const r of nearRows) {
      const real = schwabGreeks[greeksKey(r.strike, r.expiration, r.contractType)];
      if (real?.iv != null && real.iv > 0) {
        wSum += r.openInterest;
        wIv += real.iv * r.openInterest;
      }
    }
    if (wSum > 0) iv = wIv / wSum;
  }

  const byStrike = new Map<number, { callGex: number; putGex: number }>();

  for (const r of nearRows) {
    const dte = daysToExpiration(r.expiration, now);
    const T = dte / 365;

    let gamma = bsGamma(spot, r.strike, T, iv);
    const anchor = realGamma.get(`${r.strike}|${r.contractType}`);
    if (anchor && anchor.n > 0) gamma = (gamma + anchor.sum / anchor.n) / 2;

    // Griego real de Schwab (si cubre este strike+vencimiento) gana sobre la
    // estimación BS y sobre el ancla de MarketSnack — viene directo del broker.
    const real = schwabGreeks?.[greeksKey(r.strike, r.expiration, r.contractType)];
    if (real?.gamma != null && real.gamma > 0) gamma = real.gamma;

    const gex = gamma * r.openInterest * 100 * spot * spot * 0.01;
    const s = byStrike.get(r.strike) ?? { callGex: 0, putGex: 0 };
    if (r.contractType === "call") s.callGex += gex;
    else s.putGex += gex;
    byStrike.set(r.strike, s);
  }

  if (byStrike.size === 0) return emptyAnalysis(spot, iv, lowLiquidity);

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
  };
}
