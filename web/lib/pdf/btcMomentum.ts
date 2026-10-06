// Motor de Momentum/Volumen/MACD/VWAP para BTC, con el conteo de Ondas de
// Elliott como CONTEXTO (no reemplaza la señal): si coincide, sube la
// confianza; si la contradice, la baja — mismo patrón de boost/descuento que
// ya usa `lib/magnetWall.ts` para combinar señales (CROSS_MARKET_BOOST /
// CROSS_MARKET_CONFLICT_DISCOUNT / REGIME_DISCOUNT). Sin cadena de opciones
// (BTC no tiene flujo de opciones en este proyecto), así que a diferencia de
// `lib/zerodteAlt.ts` (sigma de IV + flujo real), acá todo sale de precio y
// volumen.

import type { LevelsReport } from "./levels";
import type { TfBar } from "./types";
import { computeAtr, computeMacd, computeRelativeVolume, computeRsi, computeVwap } from "./technicalIndicators";
import type { ElliottWaveSignal, WaveBias } from "./btcElliottWave";

export interface MomentumSignal {
  bias: WaveBias;
  stopLoss: number | null;
  target: number | null;
  reason: string;
  confidence: number; // 0-1
  /** Si coincide o contradice el bias de la tarjeta de Elliott ("n/a" cuando Elliott está neutral). */
  elliottAgreement: "agrees" | "conflicts" | "n/a";
}

const MIN_CONFIDENCE = 0.3;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const REL_VOLUME_PERIOD = 20;
const BIAS_THRESHOLD = 0.15;
const MOMENTUM_ELLIOTT_AGREE_BOOST = 1.25;
const MOMENTUM_ELLIOTT_CONFLICT_DISCOUNT = 0.5;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function neutralSignal(reason: string): MomentumSignal {
  return { bias: "neutral", stopLoss: null, target: null, reason, confidence: 0, elliottAgreement: "n/a" };
}

/** Stop por ATR; target = zona de liquidez más cercana en la dirección del trade si está razonablemente cerca, si no un múltiplo de ATR. */
function computeStopTarget(
  bias: "long" | "short",
  entry: number,
  atrVal: number,
  levels: LevelsReport | null,
): { stop: number; target: number } {
  const risk = Math.max(atrVal * 1.5, entry * 0.001);
  const stop = bias === "long" ? entry - risk : entry + risk;
  const fallbackTarget = bias === "long" ? entry + risk * 2 : entry - risk * 2;
  if (!levels) return { stop, target: fallbackTarget };

  const pool = bias === "long" ? levels.resistances : levels.supports;
  const nearby = pool.find((l) => {
    const dist = Math.abs(l.price - entry);
    return (bias === "long" ? l.price > entry : l.price < entry) && dist <= risk * 6;
  });
  return { stop, target: nearby ? nearby.price : fallbackTarget };
}

export function btcMomentumSignal(
  bars: TfBar[],
  levels: LevelsReport | null,
  elliott: ElliottWaveSignal,
): MomentumSignal {
  if (bars.length < 30) return neutralSignal("No hay suficientes velas para calcular momentum/volumen.");

  const closes = bars.map((b) => b.close);
  const rsi = computeRsi(closes, RSI_PERIOD);
  const macdSeries = computeMacd(bars);
  const vwap = computeVwap(bars);
  const atr = computeAtr(bars, ATR_PERIOD);
  const relVol = computeRelativeVolume(bars, REL_VOLUME_PERIOD);

  const lastIdx = bars.length - 1;
  const lastClose = bars[lastIdx].close;
  const lastRsi = rsi[lastIdx];
  const lastMacd = macdSeries[lastIdx];
  const lastVwap = vwap[lastIdx];
  const lastRelVol = relVol[lastIdx];
  const lastAtr = atr[lastIdx] ?? [...atr].reverse().find((v): v is number => v != null) ?? lastClose * 0.01;

  if (lastRsi == null || lastMacd.histogram == null || lastVwap == null) {
    return neutralSignal("Todavía no hay suficiente historia en esta temporalidad para RSI/MACD/VWAP.");
  }

  const rsiStrength = clamp((lastRsi - 50) / 25, -1, 1);
  const macdScale = Math.max(lastAtr * 0.5, lastClose * 0.0005);
  const macdStrength = clamp(lastMacd.histogram / macdScale, -1, 1);
  const vwapScale = Math.max(lastAtr, lastClose * 0.001);
  const vwapStrength = clamp((lastClose - lastVwap) / vwapScale, -1, 1);

  const combined = 0.3 * rsiStrength + 0.4 * macdStrength + 0.3 * vwapStrength;
  const bias: WaveBias = combined > BIAS_THRESHOLD ? "long" : combined < -BIAS_THRESHOLD ? "short" : "neutral";
  if (bias === "neutral") {
    return neutralSignal("RSI, MACD y VWAP no muestran un sesgo claro en esta temporalidad.");
  }

  const relVolFactor = clamp((lastRelVol ?? 1) / 1.5, 0.4, 1.3);
  let confidence = clamp(Math.abs(combined) * relVolFactor, 0, 1);

  const parts: string[] = [
    bias === "long" ? "RSI/MACD/VWAP con sesgo alcista" : "RSI/MACD/VWAP con sesgo bajista",
  ];
  if (lastRelVol != null) parts.push(`volumen relativo ${lastRelVol.toFixed(1)}x`);

  let elliottAgreement: MomentumSignal["elliottAgreement"] = "n/a";
  if (elliott.bias !== "neutral") {
    if (elliott.bias === bias) {
      confidence = clamp(confidence * MOMENTUM_ELLIOTT_AGREE_BOOST, 0, 1);
      elliottAgreement = "agrees";
      parts.push(`confirma el conteo de Ondas de Elliott (${elliott.waveLabel})`);
    } else {
      confidence = clamp(confidence * MOMENTUM_ELLIOTT_CONFLICT_DISCOUNT, 0, 1);
      elliottAgreement = "conflicts";
      parts.push(`contradice el conteo de Ondas de Elliott (${elliott.waveLabel}, que espera ${elliott.bias === "long" ? "subida" : "baja"})`);
    }
  }

  if (confidence < MIN_CONFIDENCE) {
    return neutralSignal(`Señal débil o en conflicto (${parts.join(", ")}) — se prefiere no operar.`);
  }

  const { stop, target } = computeStopTarget(bias, lastClose, lastAtr, levels);

  return {
    bias,
    stopLoss: stop,
    target,
    reason: `${parts.join(", ")}.`,
    confidence,
    elliottAgreement,
  };
}
