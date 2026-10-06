// Matemática GEX propia del Agente 0DTE (vanna/charm/IV de la cadena). Aislada
// de lib/gex.ts real a propósito: gex.ts sigue con su modelo "IV estimada de
// volatilidad realizada + gamma Black-Scholes anclada a MarketSnack" para el
// resto del proyecto; 0DTE tiene griegos reales de Schwab para el vencimiento
// del día y no necesita esa estimación. Funciones puras. Ver plan de port.

import type { ZRow } from "./zerodteTypes";

/** IV por encima de esto se descarta por absurda (contratos ilíquidos muy OTM). */
export const MAX_SANE_IV = 3;

/** Solo se consideran strikes dentro de ±este % del spot para la IV de la cadena. */
const NEAR_SPOT_PCT = 0.2;

/** Densidad normal estándar φ(x). */
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** d1, d2 de Black-Scholes con r = q = 0. null si los insumos no valen. */
function d1d2(spot: number, strike: number, T: number, iv: number): [number, number] | null {
  if (spot <= 0 || strike <= 0 || T <= 0 || iv <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * sqrtT);
  return [d1, d1 - iv * sqrtT];
}

/**
 * Vanna de Black-Scholes (r = q = 0): ∂Δ/∂σ = −φ(d1)·d2/σ. Igual para call y
 * put. Mide cuánto se mueve el delta si cambia la IV.
 */
export function bsVanna(spot: number, strike: number, T: number, iv: number): number {
  const dd = d1d2(spot, strike, T, iv);
  if (!dd) return 0;
  const [d1, d2] = dd;
  return (-phi(d1) * d2) / iv;
}

/**
 * Charm de Black-Scholes (r = q = 0): −φ(d1)·d2/(2T). Griego clave del 0DTE:
 * crece como 1/T, se dispara hacia el cierre.
 */
export function bsCharm(spot: number, strike: number, T: number, iv: number): number {
  const dd = d1d2(spot, strike, T, iv);
  if (!dd) return 0;
  const [d1, d2] = dd;
  return (-phi(d1) * d2) / (2 * T);
}

/**
 * IV real de la cadena: media de la IV por contrato ponderada por Open
 * Interest, limitada a strikes cerca del spot (±NEAR_SPOT_PCT). PURA.
 */
export function chainIV(rows: ZRow[], spot: number): number | null {
  if (spot <= 0) return null;
  const lo = spot * (1 - NEAR_SPOT_PCT);
  const hi = spot * (1 + NEAR_SPOT_PCT);
  let weighted = 0;
  let weight = 0;
  for (const r of rows) {
    const iv = r.greeks?.iv;
    if (typeof iv !== "number" || !(iv > 0) || iv > MAX_SANE_IV) continue;
    if (r.strike < lo || r.strike > hi) continue;
    if (!(r.openInterest > 0)) continue;
    weighted += iv * r.openInterest;
    weight += r.openInterest;
  }
  return weight > 0 ? weighted / weight : null;
}
