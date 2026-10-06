// Selector de temporalidad para la gráfica de "Grandes empresas" (ago 2026,
// pedido explícito: semanal/diario/4h/1h/15m/5m, cada una con su
// propia ventana de histórico). Massive (`fetchBars`, ver lib/massive.ts) ya
// expone timespans "day"/"minute"/"hour"/"week" vía el mismo endpoint de aggs
// — no hace falta una fuente de datos nueva, solo pedir la combinación
// correcta de multiplier/timespan/días por cada opción.
//
// La única que Massive NO tiene nativa es "4 horas" (Polygon/Massive solo
// da minute/hour/day/week/month/quarter/year) — se arma agregando barras de
// 1h con `aggregateHourlyBars`, PURA y testeada abajo.

import type { TfBar } from "./types";

export type ChartTimeframeId = "1w" | "1d" | "4h" | "1h" | "15m" | "5m";

export interface ChartTimeframeConfig {
  id: ChartTimeframeId;
  label: string;
  multiplier: number;
  timespan: "week" | "day" | "hour" | "minute";
  /** Días de histórico a pedir a Massive (antes de cualquier agregación). */
  days: number;
  /** Si está presente, agrega N barras horarias en una sola (ver `aggregateHourlyBars`). */
  aggregateHours?: number;
}

/**
 * Ventanas de histórico pedidas por el usuario, una por una:
 * semanal → 3 años, diario → 1 año, 4h → 1 año, 1h → 1 año, 15m y 5m → 15 días.
 */
export const CHART_TIMEFRAMES: ChartTimeframeConfig[] = [
  { id: "1w", label: "Semanal", multiplier: 1, timespan: "week", days: 3 * 365 },
  { id: "1d", label: "Diario", multiplier: 1, timespan: "day", days: 365 },
  { id: "4h", label: "4 horas", multiplier: 1, timespan: "hour", days: 365, aggregateHours: 4 },
  { id: "1h", label: "1 hora", multiplier: 1, timespan: "hour", days: 365 },
  { id: "15m", label: "15 min", multiplier: 15, timespan: "minute", days: 15 },
  { id: "5m", label: "5 min", multiplier: 5, timespan: "minute", days: 15 },
];

export const DEFAULT_CHART_TIMEFRAME: ChartTimeframeId = "15m";

export function chartTimeframeConfig(id: string): ChartTimeframeConfig {
  return CHART_TIMEFRAMES.find((tf) => tf.id === id) ?? CHART_TIMEFRAMES.find((tf) => tf.id === DEFAULT_CHART_TIMEFRAME)!;
}

/**
 * Agrupa barras de 1h en velas de `hours` horas. Los cortes se anclan a
 * medianoche UTC (`floor(time / bucketSeconds) * bucketSeconds`), NO a la
 * apertura del mercado (9:30 ET) — igual que la mayoría de plataformas
 * agrupan timeframes de horas para activos con sesión acotada: la sesión de
 * 6.5h de NYSE no es múltiplo exacto de 4h, así que cualquier ancla fija dentro
 * del día iba a dejar un bucket corto en algún punto igual. Elegir UTC
 * medianoche es simple, determinista y no depende de la zona horaria del
 * ticker. Barras vacías (sin ninguna hora real esa franja) simplemente no
 * generan bucket — no se inventan huecos.
 */
export function aggregateHourlyBars(bars: TfBar[], hours: number): TfBar[] {
  if (hours <= 1) return bars;
  const bucketSeconds = hours * 3600;
  const out: TfBar[] = [];
  let current: TfBar | null = null;
  let currentBucketStart = -1;

  for (const b of bars) {
    const bucketStart = Math.floor(b.time / bucketSeconds) * bucketSeconds;
    if (current == null || bucketStart !== currentBucketStart) {
      if (current) out.push(current);
      current = { time: bucketStart, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
      currentBucketStart = bucketStart;
    } else {
      current.high = Math.max(current.high, b.high);
      current.low = Math.min(current.low, b.low);
      current.close = b.close;
      current.volume = (current.volume ?? 0) + (b.volume ?? 0);
    }
  }
  if (current) out.push(current);
  return out;
}
