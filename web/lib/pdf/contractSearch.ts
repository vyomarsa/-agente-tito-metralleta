// "Búsqueda de contratos" — escáner de acumulación institucional real,
// limitado al S&P 500 (ver lib/sp500.ts) para la pestaña de Prueba de Fuego.
// PURO — reusa FlowRow de lib/flow.ts, ya clasificado por classifyFlow en la
// ruta.
//
// Criterio pedido por el usuario (ago 2026): single leg (nunca multileg), volumen
// del día que ya superó el Open Interest existente (dinero nuevo repitiéndose,
// no rotación — mismo concepto que lib/unusualSwing.ts), ejecutado
// agresivamente al ASK, vencimiento entre 10 y 40 días, premium > $1,000,000
// (aplicado server-side, ver app/api/contract-search/route.ts).

import type { FlowRow } from "./flow";
import { expectedMove, probTouch } from "./expectedMove";

export const FAVORITES_COUNT = 10;

export const MIN_DTE = 10;
export const MAX_DTE = 40;

/** ¿Vence dentro de la ventana pedida (10-40 días)? */
export function isInDteWindow(row: FlowRow, minDte: number = MIN_DTE, maxDte: number = MAX_DTE): boolean {
  return row.dte != null && row.dte >= minDte && row.dte <= maxDte;
}

/** ¿Una sola pata? Los multileg son otra estrategia, no una apuesta direccional. */
export function isSingleLeg(row: FlowRow): boolean {
  return !row.flags.multileg;
}

/**
 * ¿El volumen del día ya superó el Open Interest existente? Dinero nuevo
 * entrando de golpe (se repite/acumula), no solo rotación intradía — mismo
 * concepto exacto que lib/unusualSwing.ts (el usuario simplificó ese criterio de
 * un múltiplo de 3x/1.5x a "cualquier exceso" el 2026-07-28).
 */
export function isBuildingIntoOI(row: FlowRow): boolean {
  return row.openInterest > 0 && row.volume > row.openInterest;
}

/** ¿Comprador agresivo (ejecutado contra el ask)? */
export function isAggressiveAsk(row: FlowRow): boolean {
  return row.aggression === "ask";
}

export const MIN_CONVICTION_PCT = 50;

export interface TargetProjection {
  target1: number | null;
  convictionPct1: number | null;
  changePctToTarget1: number | null;
  estUsdGain1: number | null;
  target2: number | null;
  convictionPct2: number | null;
  changePctToTarget2: number | null;
  estUsdGain2: number | null;
}

const EMPTY_PROJECTION: TargetProjection = {
  target1: null, convictionPct1: null, changePctToTarget1: null, estUsdGain1: null,
  target2: null, convictionPct2: null, changePctToTarget2: null, estUsdGain2: null,
};

/**
 * Dos targets reales de precio (NO el strike) + convicción estadística de
 * llegar a cada uno. El strike solo dice CUÁL contrato comprar (por su
 * delta); no es una proyección de hacia dónde va el subyacente.
 *
 * Reusa el mismo modelo de movimiento esperado que ya corre el resto del
 * agente (lib/expectedMove.ts) en vez de correr GEX completo por candidato
 * (carísimo escaneando 500 tickers). Dirección = call arriba / put abajo.
 *
 * Target 1 = MITAD del movimiento esperado (√(dte/4) en vez de √dte, ya que
 * σ ∝ √T) — tocarlo ronda >50% de probabilidad, por eso se usa como piso de
 * convicción (MIN_CONVICTION_PCT). Target 2 = movimiento esperado COMPLETO
 * (√dte) — más lejos, más ambicioso, convicción necesariamente más baja
 * (~30-35% típico), sin piso: es el "si de verdad corre" del mismo lado.
 */
export function estimateTarget(row: FlowRow, liveSpot: number | null): TargetProjection {
  const spot = liveSpot ?? (row.assetPrice > 0 ? row.assetPrice : null);
  if (
    (row.type !== "call" && row.type !== "put") ||
    spot == null ||
    !(spot > 0) ||
    row.dte == null ||
    row.dte < 0 ||
    !(row.iv > 0)
  ) {
    return EMPTY_PROJECTION;
  }

  const halfMove = expectedMove(spot, row.iv, row.dte / 4);
  const target1 = row.type === "call" ? halfMove.upper1 : halfMove.lower1;
  const convictionPct1 = probTouch(spot, target1, row.iv, row.dte) * 100;
  const changePctToTarget1 = ((target1 - spot) / spot) * 100;
  const estUsdGain1 = Math.abs(row.delta) * Math.abs(target1 - spot) * 100;

  const fullMove = expectedMove(spot, row.iv, row.dte);
  const target2 = row.type === "call" ? fullMove.upper1 : fullMove.lower1;
  const convictionPct2 = probTouch(spot, target2, row.iv, row.dte) * 100;
  const changePctToTarget2 = ((target2 - spot) / spot) * 100;
  const estUsdGain2 = Math.abs(row.delta) * Math.abs(target2 - spot) * 100;

  return {
    target1, convictionPct1, changePctToTarget1, estUsdGain1,
    target2, convictionPct2, changePctToTarget2, estUsdGain2,
  };
}
