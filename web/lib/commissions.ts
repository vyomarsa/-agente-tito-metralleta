// ============================================================================
// Comisiones de los tres simuladores de paper (0DTE, Venta de Prima, Swing).
//
// Hasta el 2026-09-17 ninguno las descontaba, y la auditoría de ese día midió lo
// que eso escondía: en Venta de Prima se comían ~la mitad de la ganancia (+$54
// bruto → ~+$25 neto en 8 cierres) y en el 0DTE sumaban ~$174 sobre 73
// operaciones. Un paper sin comisiones mide una estrategia que no se puede operar.
//
// TARIFA: la de thinkorswim, que es donde el dueño replica las alertas: $0,65 por
// contrato y por pata, al abrir y al cerrar. Tastytrade cobra otra cosa ($1 al
// abrir, $0 al cerrar); si algún día se opera allí, se cambia AQUÍ y en ningún
// otro sitio. No se incluyen las tasas regulatorias (céntimos por contrato).
//
// VENCER NO COBRA: un contrato que expira no tiene orden de cierre. Se asume
// también que el ejercicio/asignación de uno que vence ITM no tiene cargo.
//
// PURO: sin I/O, lo pueden usar el servidor y la UI.
// ============================================================================

/** $ por contrato y por pata, en cada orden (apertura o cierre). */
export const COMISION_POR_CONTRATO = 0.65;

/**
 * Comisión de una operación completa.
 *
 * @param contracts nº de contratos (spreads: por spread, no por pata).
 * @param legs      patas por orden: 1 una opción suelta, 2 una vertical.
 * @param closed    si hubo orden de CIERRE (false = venció, o sigue abierta).
 */
export function commissionOf(
  contracts: number,
  legs: number,
  closed: boolean,
  rate = COMISION_POR_CONTRATO,
): number {
  if (!(contracts > 0) || !(legs > 0) || !(rate > 0)) return 0;
  const ordenes = closed ? 2 : 1;
  return round2(contracts * legs * ordenes * rate);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
