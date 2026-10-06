// Indicadores técnicos genéricos (EMA, MACD, VWAP, RSI, ATR, volumen relativo) —
// puros, sin llamadas de red. No existían en el proyecto (todo lo demás se
// deriva de la cadena de opciones/flujo real, no de indicadores de precio
// clásicos); nacen acá para la pestaña BTC pero no son específicos de BTC.

import type { TfBar } from "./types";

/** EMA de una serie. `null` mientras no hay suficientes datos para sembrarla. */
export function computeEma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prevEma = sum / period; // semilla: SMA de los primeros `period` valores
  out[period - 1] = prevEma;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    const ema = values[i] * k + prevEma * (1 - k);
    out[i] = ema;
    prevEma = ema;
  }
  return out;
}

export interface MacdPoint {
  time: number;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

/**
 * MACD clásico (12/26/9): línea MACD = EMA rápida − EMA lenta; línea de señal =
 * EMA(9) de la línea MACD (sembrada recién donde el MACD empieza a existir, no
 * desde el principio de la serie — si no, arrastraría ceros/huecos irreales).
 */
export function computeMacd(bars: TfBar[], fast = 12, slow = 26, signalPeriod = 9): MacdPoint[] {
  const closes = bars.map((b) => b.close);
  const emaFast = computeEma(closes, fast);
  const emaSlow = computeEma(closes, slow);
  const macdLine: Array<number | null> = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? (emaFast[i] as number) - (emaSlow[i] as number) : null,
  );

  const firstMacdIdx = macdLine.findIndex((v) => v != null);
  const signalLine: Array<number | null> = new Array(closes.length).fill(null);
  if (firstMacdIdx >= 0) {
    const macdValid = macdLine.slice(firstMacdIdx).map((v) => v as number);
    const emaOfMacd = computeEma(macdValid, signalPeriod);
    emaOfMacd.forEach((v, i) => {
      signalLine[firstMacdIdx + i] = v;
    });
  }

  return bars.map((b, i) => {
    const macd = macdLine[i];
    const signal = signalLine[i];
    return {
      time: b.time,
      macd,
      signal,
      histogram: macd != null && signal != null ? macd - signal : null,
    };
  });
}

/**
 * VWAP de sesión, anclado a medianoche UTC (mismo criterio que
 * `aggregateHourlyBars` para los buckets de horas: determinista, no depende de
 * la zona horaria del ticker). Sin volumen en la barra, cae al close (no
 * inventa un VWAP con datos que no existen).
 */
export function computeVwap(bars: TfBar[]): Array<number | null> {
  const DAY = 86_400;
  const out: Array<number | null> = new Array(bars.length).fill(null);
  let dayStart = -1;
  let cumPV = 0;
  let cumV = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const bucket = Math.floor(b.time / DAY) * DAY;
    if (bucket !== dayStart) {
      dayStart = bucket;
      cumPV = 0;
      cumV = 0;
    }
    const typicalPrice = (b.high + b.low + b.close) / 3;
    const vol = b.volume ?? 0;
    cumPV += typicalPrice * vol;
    cumV += vol;
    out[i] = cumV > 0 ? cumPV / cumV : b.close;
  }
  return out;
}

/** RSI de Wilder. `null` mientras no hay suficientes datos. */
export function computeRsi(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAvg(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAvg(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAvg(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** ATR de Wilder (rango verdadero suavizado). `null` mientras no hay suficientes datos. */
export function computeAtr(bars: TfBar[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;

  const tr: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    tr[i] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let atr = sum / period;
  out[period] = atr;

  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** Volumen de la barra actual contra el promedio de las `period` anteriores. */
export function computeRelativeVolume(bars: TfBar[], period = 20): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += bars[j].volume ?? 0;
    const avg = sum / period;
    out[i] = avg > 0 ? (bars[i].volume ?? 0) / avg : null;
  }
  return out;
}
