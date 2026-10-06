// Primitivas de Black-Scholes, puras y compartidas.
//
// Viven aquí y no dentro de gex.ts porque la Wheel necesita delta e IV implícita
// de la misma familia de fórmulas. `normCdf` NO se redefine: ya está en
// expectedMove.ts y está testeada allí.

import { normCdf } from "./expectedMove";

/**
 * Tasa libre de riesgo. Constante a propósito: a 7-45 días su efecto sobre el
 * delta es de segundo orden, y una llamada extra por una curva de tasas no se
 * paga sola.
 */
export const RISK_FREE = 0.04;

export type OptionType = "call" | "put";

/** Densidad normal estándar φ(x). */
function phi(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function d1Of(spot: number, strike: number, T: number, iv: number, r: number): number {
  return (Math.log(spot / strike) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
}

const invalid = (spot: number, strike: number, T: number, iv: number): boolean =>
  !(spot > 0) || !(strike > 0) || !(T > 0) || !(iv > 0);

/** Precio teórico de una europea. Devuelve 0 si los insumos no son válidos. */
export function bsPrice(
  spot: number, strike: number, T: number, iv: number,
  type: OptionType, r = RISK_FREE,
): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const d1 = d1Of(spot, strike, T, iv, r);
  const d2 = d1 - iv * Math.sqrt(T);
  const disc = strike * Math.exp(-r * T);
  return type === "call"
    ? spot * normCdf(d1) - disc * normCdf(d2)
    : disc * normCdf(-d2) - spot * normCdf(-d1);
}

/** Delta. Call ∈ (0,1), put ∈ (−1,0). Devuelve 0 si los insumos no son válidos. */
export function bsDelta(
  spot: number, strike: number, T: number, iv: number,
  type: OptionType, r = RISK_FREE,
): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const nd1 = normCdf(d1Of(spot, strike, T, iv, r));
  return type === "call" ? nd1 : nd1 - 1;
}

/**
 * Gamma de Black-Scholes (r = 0). Se mudó tal cual desde gex.ts —misma fórmula,
 * mismo resultado— para no alterar el GEX ya calibrado.
 */
export function bsGamma(spot: number, strike: number, T: number, iv: number): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * sqrtT);
  return phi(d1) / (spot * iv * sqrtT);
}

const IV_LO = 0.01;
const IV_HI = 5;
const IV_TOL = 1e-6;
const IV_ITERS = 60;

/**
 * IV implícita por bisección sobre σ. Devuelve null si el precio viola los
 * límites de no-arbitraje (pasa con quotes anchas o cruzadas) — el que llama
 * debe caer a una IV estimada y marcar la fila.
 */
export function impliedVol(
  price: number, spot: number, strike: number, T: number,
  type: OptionType, r = RISK_FREE,
): number | null {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(T > 0)) return null;

  const disc = strike * Math.exp(-r * T);
  const intrinsic = type === "put" ? Math.max(0, disc - spot) : Math.max(0, spot - disc);
  const upper = type === "put" ? disc : spot;
  if (price <= intrinsic || price >= upper) return null;

  let lo = IV_LO;
  let hi = IV_HI;
  if (bsPrice(spot, strike, T, lo, type, r) > price) return null;
  if (bsPrice(spot, strike, T, hi, type, r) < price) return null;

  for (let i = 0; i < IV_ITERS; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(spot, strike, T, mid, type, r);
    if (Math.abs(p - price) < IV_TOL) return mid;
    if (p < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Charm (r = q = 0): variación del delta por el PASO DEL TIEMPO, `∂Δ/∂T` con T =
 * tiempo restante = `−φ(d1)·d2 / (2T)`. Con q = 0 es idéntica para call y put
 * (Δ_put = Δ_call − 1, así que la derivada es la misma), por eso no recibe tipo.
 *
 * Es el griego del 0DTE: escala como 1/T, así que a media sesión es leve y en la
 * última hora domina. El delta que se desvanece obliga al dealer a deshacer
 * cobertura, y ESE flujo mecánico es el que empuja el precio hacia el cierre
 * (el "pin" o la deriva de fin de día).
 *
 * Va con r = 0 igual que `bsGamma`: el GEX del 0DTE está calibrado así y a horas
 * del vencimiento la tasa no mueve la aguja.
 */
export function bsCharm(spot: number, strike: number, T: number, iv: number): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  return -phi(d1) * d2 / (2 * T);
}
