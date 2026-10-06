// Motor de Ondas de Elliott para BTC — heurístico y declarado como tal: el
// conteo de Elliott es subjetivo por naturaleza (el usuario lo aceptó explícitamente
// como "capa de contexto", no como predicción certera). Cuando la confianza del
// mejor conteo encontrado es baja, el resultado cae a `bias: "neutral"` en vez
// de forzar una entrada — mismo principio de "ante la duda, no operar" que ya
// usa el resto del proyecto (ver CLAUDE.md).
//
// No reusa `findPivots`/`clusterPivots` de `lib/levels.ts` — esos son pivotes
// fractales de k-velas y no garantizan la alternancia estricta alto/bajo que
// necesita un conteo de ondas. Acá se usa un zigzag propio con umbral basado en
// ATR (se adapta solo al timeframe elegido, en vez de un % fijo).

import type { TfBar } from "./types";
import { computeAtr } from "./technicalIndicators";

export type WaveBias = "long" | "short" | "neutral";

/** Un punto ya formado del conteo (ej. "Onda 3") con su precio y hora reales — para mostrar qué ondas ya pasaron. */
export interface WavePoint {
  label: string;
  price: number;
  time: number;
  /** Techo o piso — para que el gráfico ponga la etiqueta del lado correcto. */
  kind: "high" | "low";
}

export interface ElliottWaveSignal {
  waveLabel: string;
  /** Los puntos del conteo ya confirmados por el zigzag, en orden — de dónde viene el movimiento. */
  waveSequence: WavePoint[];
  /** Camino proyectado hacia adelante — para alimentar el gráfico de proyección. */
  projection: Array<{ time: number; price: number }>;
  bias: WaveBias;
  stopLoss: number | null;
  target: number | null;
  reason: string;
  confidence: number; // 0-1
}

export interface Swing {
  time: number;
  price: number;
  kind: "high" | "low";
  index: number;
}

const ZIGZAG_ATR_MULTIPLE = 2.5;
const MIN_CONFIDENCE = 0.35;
const FIB_RETRACEMENTS = [0.382, 0.5, 0.618, 0.786];
const FIB_WAVE4_RETRACEMENTS = [0.236, 0.382, 0.5];
const FIB_EXTENSIONS = [1.618, 2.618];

/** Zigzag propio: confirma un swing cuando el precio se revierte al menos `threshold` desde el extremo. */
export function detectSwings(bars: TfBar[]): Swing[] {
  if (bars.length < 3) return [];
  const atr = computeAtr(bars, 14);
  const lastAtr = [...atr].reverse().find((v): v is number => v != null) ?? null;
  const lastClose = bars[bars.length - 1].close;
  const threshold = lastAtr != null && lastAtr > 0 ? lastAtr * ZIGZAG_ATR_MULTIPLE : lastClose * 0.03;
  if (!(threshold > 0)) return [];

  const swings: Swing[] = [];
  let dir: "up" | "down" | null = null;
  let extremeIdx = 0;
  let extremePrice = bars[0].close;

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (dir === null) {
      if (b.high - extremePrice >= threshold) {
        dir = "up";
        extremePrice = b.high;
        extremeIdx = i;
      } else if (extremePrice - b.low >= threshold) {
        dir = "down";
        extremePrice = b.low;
        extremeIdx = i;
      }
      continue;
    }
    if (dir === "up") {
      if (b.high > extremePrice) {
        extremePrice = b.high;
        extremeIdx = i;
      } else if (extremePrice - b.low >= threshold) {
        swings.push({ time: bars[extremeIdx].time, price: extremePrice, kind: "high", index: extremeIdx });
        dir = "down";
        extremePrice = b.low;
        extremeIdx = i;
      }
    } else {
      if (b.low < extremePrice) {
        extremePrice = b.low;
        extremeIdx = i;
      } else if (b.high - extremePrice >= threshold) {
        swings.push({ time: bars[extremeIdx].time, price: extremePrice, kind: "low", index: extremeIdx });
        dir = "up";
        extremePrice = b.high;
        extremeIdx = i;
      }
    }
  }
  return swings;
}

function closenessScore(ratio: number, targets: number[]): number {
  if (!(ratio > 0)) return 0;
  const nearest = targets.reduce((best, t) => (Math.abs(ratio - t) < Math.abs(ratio - best) ? t : best), targets[0]);
  const distance = Math.abs(ratio - nearest) / nearest;
  return Math.max(0, 1 - distance * 2);
}

function barStepOf(bars: TfBar[]): number {
  if (bars.length < 2) return 3600;
  return bars[bars.length - 1].time - bars[bars.length - 2].time || 3600;
}

export interface Candidate {
  bullish: boolean;
  confidence: number;
  waveLabel: string;
  waveSequence: WavePoint[];
  reason: string;
  invalidation: number;
  targetPrice: number;
  projection: Array<{ time: number; price: number }>;
}

/** Precio redondeado para meter en las frases explicativas — mismo criterio que ya usa BtcTab.tsx. */
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Narra la proyección tramo por tramo comparando cada punto contra el anterior
 * (pedido explícito: no solo "$A → $B → $C", sino "primero baja
 * hasta $A, luego sube hasta $B..." con la dirección de cada pierna dicha en
 * palabras).
 */
function narrateProjection(fromPrice: number, projection: Array<{ price: number }>): string {
  if (projection.length === 0) return "";
  let prev = fromPrice;
  const steps = projection.map((p) => {
    const verb = p.price > prev ? "suba" : p.price < prev ? "baje" : "se mantenga cerca de";
    prev = p.price;
    return `${verb} hasta $${fmt(p.price)}`;
  });
  if (steps.length === 1) return `Se espera que el precio ${steps[0]}.`;
  const labeled = steps.map((s, i) => {
    if (i === 0) return `primero ${s}`;
    if (i === steps.length - 1) return `y por último ${s}`;
    return `luego ${s}`;
  });
  return `Se espera que el precio ${labeled.join(", ")}.`;
}

/**
 * Impulso de 5 ondas terminado en el último swing → se espera una corrección
 * ABC en contra de la tendencia del impulso.
 */
export function tryImpulseComplete(swings: Swing[], step: number): Candidate | null {
  if (swings.length < 6) return null;
  const pts = swings.slice(-6);
  const P = pts.map((s) => s.price);
  const impulseBullish = P[5] > P[0];
  const sgn = impulseBullish ? 1 : -1;
  const sp = P.map((p) => p * sgn);

  const d1 = sp[1] - sp[0];
  const d2 = sp[2] - sp[1];
  const d3 = sp[3] - sp[2];
  const d4 = sp[4] - sp[3];
  const d5 = sp[5] - sp[4];
  if (!(d1 > 0 && d3 > 0 && d5 > 0 && d2 < 0 && d4 < 0)) return null; // debe alternar como impulso real
  if (!(sp[2] > sp[0])) return null; // onda 2 no retrocede el 100% de la onda 1
  if (Math.abs(d3) < d1 && Math.abs(d3) < d5) return null; // onda 3 no es la más corta de 1/3/5
  if (!(sp[4] > sp[1])) return null; // onda 4 no invade el territorio de la onda 1

  const ratio31 = d3 / d1;
  const retr2 = Math.abs(d2) / d1;
  const retr4 = Math.abs(d4) / d3;
  const confidence = Math.max(
    0,
    Math.min(
      1,
      0.4 +
        0.25 * closenessScore(ratio31, FIB_EXTENSIONS) +
        0.2 * closenessScore(retr2, FIB_RETRACEMENTS) +
        0.15 * closenessScore(retr4, FIB_WAVE4_RETRACEMENTS),
    ),
  );

  const impulseSpan = sp[5] - sp[0];
  const targetSp = sp[5] - impulseSpan * 0.5; // objetivo central de la corrección (retroceso 50%)
  const lastTime = pts[5].time;
  const projection = [0.382, 0.5, 0.618].map((r, i) => ({
    time: lastTime + step * (i + 1) * 3,
    price: (sp[5] - impulseSpan * r) * sgn,
  }));
  const waveSequence: WavePoint[] = [
    { label: "Inicio", price: P[0], time: pts[0].time, kind: pts[0].kind },
    { label: "Onda 1", price: P[1], time: pts[1].time, kind: pts[1].kind },
    { label: "Onda 2", price: P[2], time: pts[2].time, kind: pts[2].kind },
    { label: "Onda 3", price: P[3], time: pts[3].time, kind: pts[3].kind },
    { label: "Onda 4", price: P[4], time: pts[4].time, kind: pts[4].kind },
    { label: "Onda 5 (completa)", price: P[5], time: pts[5].time, kind: pts[5].kind },
  ];
  const invalidation = P[5];
  const targetPrice = targetSp * sgn;

  return {
    bullish: !impulseBullish, // el impulso terminó — la corrección va en contra de su tendencia
    confidence,
    waveLabel: impulseBullish ? "Onda 5 completa (impulso alcista)" : "Onda 5 completa (impulso bajista)",
    waveSequence,
    reason: impulseBullish
      ? `Ya se completaron las 5 ondas del impulso alcista: de $${fmt(P[0])} subió hasta $${fmt(P[5])} (Onda 1 a $${fmt(P[1])}, Onda 2 a $${fmt(P[2])}, Onda 3 a $${fmt(P[3])}, Onda 4 a $${fmt(P[4])}, Onda 5 a $${fmt(P[5])}). Ahora se espera una corrección ABC bajista. ${narrateProjection(P[5], projection)} Si el precio vuelve a superar $${fmt(invalidation)}, este conteo se invalida.`
      : `Ya se completaron las 5 ondas del impulso bajista: de $${fmt(P[0])} bajó hasta $${fmt(P[5])} (Onda 1 a $${fmt(P[1])}, Onda 2 a $${fmt(P[2])}, Onda 3 a $${fmt(P[3])}, Onda 4 a $${fmt(P[4])}, Onda 5 a $${fmt(P[5])}). Ahora se espera una corrección ABC alcista. ${narrateProjection(P[5], projection)} Si el precio vuelve a perforar $${fmt(invalidation)}, este conteo se invalida.`,
    invalidation,
    targetPrice,
    projection,
  };
}

/**
 * Ondas 1-2-3 confirmadas y el precio retrocediendo desde un techo/piso de onda 3
 * todavía no confirmado por el zigzag (onda 4 en curso) → se espera una onda 5.
 */
export function tryInWave4(bars: TfBar[], swings: Swing[], step: number): Candidate | null {
  if (swings.length < 3 || bars.length === 0) return null;
  const [S0, S1, S2] = swings.slice(-3);
  const impulseBullish = S1.price > S0.price;
  const sgn = impulseBullish ? 1 : -1;
  const sp0 = S0.price * sgn;
  const sp1 = S1.price * sgn;
  const sp2 = S2.price * sgn;
  if (!(sp1 > sp0 && sp2 > sp0 && sp2 < sp1)) return null; // onda1 arriba, onda2 corrige sin romper el inicio

  // El techo/piso de la onda 3 todavía no lo confirmó el zigzag — se estima
  // escaneando las barras reales desde el fin de la onda 2.
  let extIdx = S2.index;
  let extPrice = sgn > 0 ? bars[S2.index].high : bars[S2.index].low;
  for (let i = S2.index + 1; i < bars.length; i++) {
    const candidate = sgn > 0 ? bars[i].high : bars[i].low;
    if (sgn > 0 ? candidate > extPrice : candidate < extPrice) {
      extPrice = candidate;
      extIdx = i;
    }
  }
  const sp3 = extPrice * sgn;
  if (!(sp3 > sp1) || extIdx >= bars.length - 1) return null; // onda 3 debe superar el techo de la onda 1, y debe quedar margen para el retroceso

  const lastBar = bars[bars.length - 1];
  const spLast = lastBar.close * sgn;
  if (!(spLast < sp3 && spLast > sp1)) return null; // retrocediendo (onda4) sin invadir la onda 1

  const wave1Len = sp1 - sp0;
  const wave3Len = sp3 - sp2;
  const retr4 = wave3Len > 0 ? (sp3 - spLast) / wave3Len : 0;
  const confidence = Math.max(0, Math.min(1, 0.35 + 0.3 * closenessScore(retr4, FIB_WAVE4_RETRACEMENTS)));

  const targetSp = sp3 + wave1Len; // onda 5 ≈ largo de la onda 1, medida desde el techo de la onda 3
  const projection = [0.3, 0.6, 1].map((f, i) => ({
    time: lastBar.time + step * (i + 1) * 3,
    price: (spLast + (targetSp - spLast) * f) * sgn,
  }));
  const waveSequence: WavePoint[] = [
    { label: "Inicio", price: S0.price, time: S0.time, kind: S0.kind },
    { label: "Onda 1", price: S1.price, time: S1.time, kind: S1.kind },
    { label: "Onda 2", price: S2.price, time: S2.time, kind: S2.kind },
    { label: "Onda 3", price: extPrice, time: bars[extIdx].time, kind: impulseBullish ? "high" : "low" },
    { label: "Onda 4 (en curso)", price: lastBar.close, time: lastBar.time, kind: impulseBullish ? "low" : "high" },
  ];
  const invalidation2 = S1.price;

  return {
    bullish: impulseBullish,
    confidence,
    waveLabel: impulseBullish ? "Onda 4 en curso (impulso alcista)" : "Onda 4 en curso (impulso bajista)",
    waveSequence,
    reason: impulseBullish
      ? `Estás en la Onda 4 de un impulso alcista: la Onda 1 fue de $${fmt(S0.price)} a $${fmt(S1.price)}, la Onda 2 corrigió hasta $${fmt(S2.price)} y la Onda 3 se extendió hasta $${fmt(extPrice)}. Ahora el precio retrocede en la Onda 4 sin perder el techo de la Onda 1 en $${fmt(invalidation2)} (ese nivel invalida el conteo si se pierde). Si se sostiene, se espera un quinto tramo alcista. ${narrateProjection(lastBar.close, projection)}`
      : `Estás en la Onda 4 de un impulso bajista: la Onda 1 fue de $${fmt(S0.price)} a $${fmt(S1.price)}, la Onda 2 rebotó hasta $${fmt(S2.price)} y la Onda 3 se extendió hasta $${fmt(extPrice)}. Ahora el precio rebota en la Onda 4 sin superar el piso de la Onda 1 en $${fmt(invalidation2)} (ese nivel invalida el conteo si se rompe). Si se sostiene, se espera un quinto tramo bajista. ${narrateProjection(lastBar.close, projection)}`,
    invalidation: invalidation2,
    targetPrice: targetSp * sgn,
    projection,
  };
}

/**
 * Corrección ABC completa (tras un impulso previo) → se espera el inicio de un
 * nuevo impulso retomando la tendencia original.
 */
export function tryCorrectionComplete(swings: Swing[], step: number): Candidate | null {
  if (swings.length < 4) return null;
  const pts = swings.slice(-4);
  const [T, A, B, C] = pts.map((s) => s.price);
  const lastTime = pts[3].time;

  const bullishResume = A < T; // la corrección fue hacia abajo tras un techo → se retoma la subida
  const legA = Math.abs(A - T);
  if (legA === 0) return null;

  const rulesOk = bullishResume
    ? B > A && B < T && C < B && C >= T - legA * 2.618
    : B < A && B > T && C > B && C <= T + legA * 2.618;
  if (!rulesOk) return null;

  const retrB = Math.abs(B - A) / legA;
  const confidence = Math.max(0, Math.min(1, 0.35 + 0.3 * closenessScore(retrB, FIB_RETRACEMENTS)));

  const newImpulseLen = legA; // proyección conservadora: la nueva onda 1 ≈ el tramo A
  const targetPrice = bullishResume ? C + newImpulseLen : C - newImpulseLen;
  const projection = [0.4, 0.7, 1].map((f, i) => ({
    time: lastTime + step * (i + 1) * 3,
    price: C + (targetPrice - C) * f,
  }));
  const waveSequence: WavePoint[] = [
    { label: bullishResume ? "Techo previo" : "Piso previo", price: T, time: pts[0].time, kind: pts[0].kind },
    { label: "Onda A", price: A, time: pts[1].time, kind: pts[1].kind },
    { label: "Onda B", price: B, time: pts[2].time, kind: pts[2].kind },
    { label: "Onda C (completa)", price: C, time: pts[3].time, kind: pts[3].kind },
  ];

  return {
    bullish: bullishResume,
    confidence,
    waveLabel: bullishResume
      ? "Corrección ABC completa — nueva onda 1 alcista"
      : "Corrección ABC completa — nueva onda 1 bajista",
    waveSequence,
    reason: bullishResume
      ? `La corrección ABC parece completa: desde el techo en $${fmt(T)} bajó a $${fmt(A)} (Onda A), rebotó a $${fmt(B)} (Onda B) y volvió a bajar hasta $${fmt(C)} (Onda C). Mientras el precio no perfore $${fmt(C)}, se espera el inicio de una nueva Onda 1 alcista. ${narrateProjection(C, projection)}`
      : `La corrección ABC parece completa: desde el piso en $${fmt(T)} subió a $${fmt(A)} (Onda A), retrocedió a $${fmt(B)} (Onda B) y volvió a subir hasta $${fmt(C)} (Onda C). Mientras el precio no supere $${fmt(C)}, se espera el inicio de una nueva Onda 1 bajista. ${narrateProjection(C, projection)}`,
    invalidation: C,
    targetPrice,
    projection,
  };
}

function neutralSignal(reason: string): ElliottWaveSignal {
  return { waveLabel: "Conteo no claro", waveSequence: [], projection: [], bias: "neutral", stopLoss: null, target: null, reason, confidence: 0 };
}

export function elliottWaveSignal(bars: TfBar[]): ElliottWaveSignal {
  if (bars.length < 30) return neutralSignal("No hay suficientes velas para armar un conteo de ondas confiable.");

  const swings = detectSwings(bars);
  const step = barStepOf(bars);

  const candidates: Candidate[] = [];
  const impulseComplete = tryImpulseComplete(swings, step);
  if (impulseComplete) candidates.push(impulseComplete);
  const inWave4 = tryInWave4(bars, swings, step);
  if (inWave4) candidates.push(inWave4);
  const correctionComplete = tryCorrectionComplete(swings, step);
  if (correctionComplete) candidates.push(correctionComplete);

  if (candidates.length === 0) {
    return neutralSignal("No se detectó un patrón de Elliott claro con los swings recientes.");
  }

  const best = candidates.reduce((m, c) => (c.confidence > m.confidence ? c : m), candidates[0]);
  if (best.confidence < MIN_CONFIDENCE) {
    return {
      waveLabel: `${best.waveLabel} (confianza baja)`,
      waveSequence: best.waveSequence,
      projection: [],
      bias: "neutral",
      stopLoss: null,
      target: null,
      reason: `Conteo más probable (${best.waveLabel}) con confianza baja (${Math.round(best.confidence * 100)}%) — se prefiere no operar. ${best.reason}`,
      confidence: 0,
    };
  }

  return {
    waveLabel: best.waveLabel,
    waveSequence: best.waveSequence,
    projection: best.projection,
    bias: best.bullish ? "long" : "short",
    stopLoss: best.invalidation,
    target: best.targetPrice,
    reason: best.reason,
    confidence: best.confidence,
  };
}
