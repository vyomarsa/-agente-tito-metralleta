// ============================================================================
// Sugerencias de spreads 0DTE — vertical de débito, credit call e iron condor.
// PURA: no toca fs ni red. A diferencia de `lines` (top-10 por volumen), usa
// la cadena COMPLETA del día para poder elegir strikes por distancia (el
// borde de 1σ/2σ del movimiento esperado), no por volumen — un strike de
// borde de rango casi nunca es el de mayor volumen.
//
// Pedido por el usuario a partir de un script propio (Sugerencias 0DTE - script
// (verticals + IC).docx) que registraba estas tres sugerencias en Excel desde
// OTRO proyecto (Ruta2030-0DTE, puerto 3002). Acá se recalculan desde cero con
// la cadena real de Schwab de ESTE proyecto — no se portó el script tal cual.
// ============================================================================

import { expectedMove } from "./expectedMove";
import type { EntryDecision } from "./zerodteStrategy";
import type { ContractType, ZRow } from "./zerodteTypes";

export type SuggestionBias = "alcista" | "bajista" | "lateral";

export interface VerticalSuggestion {
  kind: "bull_call" | "bear_put";
  longStrike: number;
  shortStrike: number;
  /** $ por contrato (100 acciones). */
  debit: number;
  maxProfit: number;
  breakeven: number;
}

export interface CreditCallSuggestion {
  shortCall: number;
  longCall: number;
  credit: number;
  maxLoss: number;
  breakeven: number;
}

export interface IronCondorSuggestion {
  shortPut: number;
  longPut: number;
  shortCall: number;
  longCall: number;
  credit: number;
  beLow: number;
  beHigh: number;
}

export interface ZeroDteSuggestions {
  bias: SuggestionBias;
  /** Solo por completitud/depuración — el porqué del sesgo direccional. */
  biasSource: "pin" | "agresor" | "sin señal";
  vertical: VerticalSuggestion | null;
  creditCall: CreditCallSuggestion | null;
  ironCondor: IronCondorSuggestion | null;
}

/** El strike cotizado (bid/ask reales, no huecos) más cercano al target, en la dirección pedida. */
function nearestRow(
  rows: ZRow[], type: ContractType, target: number, dir: "up" | "down" | "nearest",
): ZRow | null {
  const candidates = rows.filter(
    (r) => r.contractType === type && r.bid != null && r.ask != null && r.bid > 0 && r.ask > r.bid,
  );
  if (candidates.length === 0) return null;
  const byDist = (a: ZRow, b: ZRow) => Math.abs(a.strike - target) - Math.abs(b.strike - target);
  if (dir === "up") {
    const above = candidates.filter((r) => r.strike >= target).sort((a, b) => a.strike - b.strike);
    return above[0] ?? [...candidates].sort(byDist)[0];
  }
  if (dir === "down") {
    const below = candidates.filter((r) => r.strike <= target).sort((a, b) => b.strike - a.strike);
    return below[0] ?? [...candidates].sort(byDist)[0];
  }
  return [...candidates].sort(byDist)[0];
}

/**
 * Vertical de débito en la dirección del sesgo: compra ATM, vende hacia el
 * imán del GEX si hay setup de pin, o hacia el borde de 1σ si no lo hay.
 */
function buildVertical(
  rows: ZRow[], spot: number, bias: SuggestionBias, entry: EntryDecision | null,
  upper1: number, lower1: number,
): VerticalSuggestion | null {
  if (bias === "lateral") return null;
  const type: ContractType = bias === "alcista" ? "call" : "put";
  const long = nearestRow(rows, type, spot, "nearest");
  if (!long?.ask) return null;

  const target = entry ? entry.target : bias === "alcista" ? upper1 : lower1;
  const short = nearestRow(rows, type, target, bias === "alcista" ? "up" : "down");
  if (!short?.bid) return null;
  if (bias === "alcista" && short.strike <= long.strike) return null;
  if (bias === "bajista" && short.strike >= long.strike) return null;

  const debitPerShare = long.ask - short.bid;
  if (!(debitPerShare > 0)) return null;
  const width = Math.abs(short.strike - long.strike);

  return {
    kind: bias === "alcista" ? "bull_call" : "bear_put",
    longStrike: long.strike,
    shortStrike: short.strike,
    debit: Math.round(debitPerShare * 100),
    maxProfit: Math.round((width - debitPerShare) * 100),
    breakeven: bias === "alcista" ? long.strike + debitPerShare : long.strike - debitPerShare,
  };
}

/** Credit call spread — vende el borde de 1σ arriba, compra el de 2σ como protección. Neutral/bajista. */
function buildCreditCall(rows: ZRow[], upper1: number, upper2: number): CreditCallSuggestion | null {
  const short = nearestRow(rows, "call", upper1, "up");
  if (!short?.bid) return null;
  const long = nearestRow(rows, "call", Math.max(upper2, short.strike), "up");
  if (!long?.ask || long.strike <= short.strike) return null;

  const creditPerShare = short.bid - long.ask;
  if (!(creditPerShare > 0)) return null;
  const width = long.strike - short.strike;

  return {
    shortCall: short.strike,
    longCall: long.strike,
    credit: Math.round(creditPerShare * 100),
    maxLoss: Math.round((width - creditPerShare) * 100),
    breakeven: short.strike + creditPerShare,
  };
}

/**
 * Iron condor con las 4 patas reales (con alas de protección, a diferencia
 * del script original que las omitía) — vende el borde de 1σ de cada lado,
 * compra el de 2σ como protección. Neutral: gana si el cierre queda adentro.
 */
function buildIronCondor(
  rows: ZRow[], lower1: number, lower2: number, upper1: number, upper2: number,
): IronCondorSuggestion | null {
  const shortPut = nearestRow(rows, "put", lower1, "down");
  const shortCall = nearestRow(rows, "call", upper1, "up");
  if (!shortPut?.bid || !shortCall?.bid) return null;
  const longPut = nearestRow(rows, "put", Math.min(lower2, shortPut.strike), "down");
  const longCall = nearestRow(rows, "call", Math.max(upper2, shortCall.strike), "up");
  if (!longPut?.ask || !longCall?.ask) return null;
  if (longPut.strike >= shortPut.strike || longCall.strike <= shortCall.strike) return null;

  const creditPerShare = shortPut.bid - longPut.ask + (shortCall.bid - longCall.ask);
  if (!(creditPerShare > 0)) return null;

  return {
    shortPut: shortPut.strike, longPut: longPut.strike,
    shortCall: shortCall.strike, longCall: longCall.strike,
    credit: Math.round(creditPerShare * 100),
    beLow: shortPut.strike - creditPerShare,
    beHigh: shortCall.strike + creditPerShare,
  };
}

/**
 * Arma las tres sugerencias del día. El sesgo direccional (para la vertical)
 * sale del setup de pin al imán si existe (gamma positiva); si no —el caso más
 * común, gamma negativa— cae al signo del agresor neto (CVD) acumulado hasta
 * ahora. Credit call e iron condor son neutrales: no dependen del sesgo, solo
 * del movimiento esperado (1σ/2σ por IV). PURA.
 */
export function buildSuggestions(
  rows: ZRow[], spot: number, iv: number | null, hoursLeft: number,
  entry: EntryDecision | null, netAggressorSign: number,
): ZeroDteSuggestions {
  const bias: SuggestionBias = entry
    ? entry.direction === "long" ? "alcista" : "bajista"
    : netAggressorSign > 0 ? "alcista" : netAggressorSign < 0 ? "bajista" : "lateral";
  const biasSource: ZeroDteSuggestions["biasSource"] = entry ? "pin" : bias !== "lateral" ? "agresor" : "sin señal";

  if (!(spot > 0) || iv == null || !(iv > 0) || hoursLeft <= 0) {
    return { bias, biasSource, vertical: null, creditCall: null, ironCondor: null };
  }

  const em = expectedMove(spot, iv, hoursLeft / 24);

  return {
    bias,
    biasSource,
    vertical: buildVertical(rows, spot, bias, entry, em.upper1, em.lower1),
    creditCall: buildCreditCall(rows, em.upper1, em.upper2),
    ironCondor: buildIronCondor(rows, em.lower1, em.lower2, em.upper1, em.upper2),
  };
}
