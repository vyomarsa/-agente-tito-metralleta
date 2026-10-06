// "Unusual Swing Trades" — escáner de mercado completo para contratos con
// actividad institucional inusual, horizonte de swing (30-120 días), no
// day-trading. PURO — reusa FlowRow de lib/flow.ts, ya clasificado por
// classifyFlow en la ruta.
//
// Criterio pedido por el usuario: fuera del dinero (OTM), vencimiento 30-120 días,
// premium ≥$2M (ver MIN_PREMIUM en app/api/unusual-swing/route.ts — se aplica
// server-side, al pedirle el flujo a MarketSnack), volumen MUY grande y MUCHO
// mayor al Open Interest (dinero nuevo entrando de golpe, no rotación), call o
// put, ejecutado SOLO al ask (compra agresiva), y una sola pata (nunca
// multileg — eso es otra estrategia, no una apuesta direccional).

import type { FlowRow } from "./flow";

// Subido de 10 a 20 (2026-08-20, pedido explícito: "quiero más
// contratos" — antes solo aparecía uno con la ventana de 60-90 días y $5M).
export const MAX_RESULTS = 20;
export const MIN_DTE_SWING = 30;
export const MAX_DTE_SWING = 120;
/**
 * Bajado de 3x a 1.5x el 2026-07-28, y de 1.5x a 1x el mismo día — el usuario pidió
 * quitar el múltiplo exacto: ya no importa cuánto mayor, solo que el volumen del
 * día supere al Open Interest existente (dinero nuevo entrando de golpe).
 */
export const VOLUME_OI_MULTIPLE = 1;
/** "Muy grande" en términos absolutos, no solo de ratio contra un OI chico. */
export const MIN_VOLUME = 300;

/** ¿Está el strike FUERA del dinero respecto al precio del subyacente al momento del trade? */
export function isOtm(row: FlowRow): boolean {
  if (row.strike == null || !(row.assetPrice > 0) || row.type === "unknown") return false;
  return row.type === "call" ? row.strike > row.assetPrice : row.strike < row.assetPrice;
}

/**
 * ¿Es un contrato de "unusual swing trade"? OTM + vencimiento 30-120 días + volumen
 * ≥300 contratos y mayor a su Open Interest + compra agresiva al ask + una sola pata.
 * El piso de premium ($2M) se aplica antes, server-side (ver route.ts).
 */
export function isUnusualSwingCandidate(row: FlowRow): boolean {
  if (!isOtm(row)) return false;
  if (row.dte == null || row.dte < MIN_DTE_SWING || row.dte > MAX_DTE_SWING) return false;
  if (row.aggression !== "ask") return false;
  if (row.flags.multileg) return false;
  if (!(row.openInterest > 0)) return false;
  if (row.volume < MIN_VOLUME) return false;
  if (row.volume <= row.openInterest * VOLUME_OI_MULTIPLE) return false;
  return true;
}

/** Ordena por qué tan inusual es (ratio volumen/OI), y dentro de eso por premium. */
export function rankUnusualSwing(rows: FlowRow[]): FlowRow[] {
  return [...rows].sort((a, b) => {
    const ratioA = a.openInterest > 0 ? a.volume / a.openInterest : 0;
    const ratioB = b.openInterest > 0 ? b.volume / b.openInterest : 0;
    if (ratioA !== ratioB) return ratioB - ratioA;
    return b.premium - a.premium;
  });
}
