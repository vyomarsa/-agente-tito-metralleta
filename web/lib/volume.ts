// Volumen promedio diario del subyacente para el filtro de elegibilidad de
// Credit Spreads (Sección 3 del prompt: acción con vol promedio 20d ≥ 5M).
// PURO: opera sobre barras ya descargadas, no toca red.

import type { DailyBar } from "./types";

/**
 * Media simple del volumen de las últimas `n` barras (por defecto 20).
 * Ignora barras sin volumen. Devuelve `null` si no hay ninguna barra con volumen
 * (no inventamos 0: la elegibilidad debe fallar por dato ausente, no por "bajo").
 */
export function avg20dVolume(bars: DailyBar[], n = 20): number | null {
  const vols = bars
    .filter((b) => typeof b.volume === "number" && Number.isFinite(b.volume))
    .map((b) => b.volume as number)
    .slice(-n);
  if (vols.length === 0) return null;
  return vols.reduce((a, v) => a + v, 0) / vols.length;
}
