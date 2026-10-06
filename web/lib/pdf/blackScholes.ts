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

/**
 * Charm: ∂Delta/∂t — cuánto cambia el delta a medida que pasa el tiempo (T se
 * achica), a igual spot/IV. Bajo q=0 (sin dividendo, misma convención que el
 * resto del archivo) da el MISMO valor para call y put: Δput = Δcall − 1 es
 * una constante, así que su derivada respecto a t es idéntica — por eso no
 * lleva parámetro `type`, igual que `bsGamma`.
 *
 * Se deriva en forma cerrada de Δ = N(d1) (∂Δ/∂t = −φ(d1)·∂d1/∂T) en vez de
 * copiar una fórmula de texto — hay ambigüedad de signo entre fuentes para
 * "charm". Verificado en `blackScholes.test.ts` contra la derivada numérica
 * (diferencias finitas) de `bsDelta`, así queda garantizado consistente con
 * el delta que ya usa el resto del repo.
 */
export function bsCharm(spot: number, strike: number, T: number, iv: number, r = RISK_FREE): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const sqrtT = Math.sqrt(T);
  const d1 = d1Of(spot, strike, T, iv, r);
  const dD1dT = (0.5 / (iv * T * sqrtT)) * ((r + 0.5 * iv * iv) * T - Math.log(spot / strike));
  return -phi(d1) * dD1dT;
}

/**
 * Vanna: ∂Delta/∂σ (equivalente a ∂Vega/∂S) — cuánto cambia el delta ante un
 * cambio de IV. Mismo razonamiento que `bsCharm`: bajo q=0, call y put dan el
 * mismo valor (la derivada de la constante −1 es 0), así que no lleva `type`.
 * Forma cerrada: ∂Δ/∂σ = φ(d1)·∂d1/∂σ, y ∂d1/∂σ = −d2/σ (álgebra directa desde
 * d1 = (ln(S/K)+(r+0.5σ²)T)/(σ√T)), así que vanna = −φ(d1)·d2/σ. Verificado en
 * los tests contra la derivada numérica de `bsDelta` respecto a IV.
 */
export function bsVanna(spot: number, strike: number, T: number, iv: number, r = RISK_FREE): number {
  if (invalid(spot, strike, T, iv)) return 0;
  const d1 = d1Of(spot, strike, T, iv, r);
  const d2 = d1 - iv * Math.sqrt(T);
  return (-phi(d1) * d2) / iv;
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
