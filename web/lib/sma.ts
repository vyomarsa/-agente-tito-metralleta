// Media móvil simple. PURA. Devuelve la media de los ÚLTIMOS `period` cierres, o null
// si no hay suficientes barras (p. ej. un símbolo recién listado sin 200 días de histórico).
export function sma(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}
