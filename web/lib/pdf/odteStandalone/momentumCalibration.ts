// ============================================================================
// Calibración del motor de MOMENTUM en γ− (momentumEntry, zerodteAlt.ts).
//
// A diferencia de la estrategia de fade en γ+ (dynamicParams/SPX_MIN_RR en
// zerodteStrategy.ts), que se calibró con backtests manuales reales sobre datos
// de un día real, MOMENTUM_DEFAULTS nunca se validó contra nada — son números
// puestos a ojo (minRR 1.5, stopSigmaK 0.5, minStrength 0.5...). Este módulo
// hace lo mismo que aquellos backtests pero de forma sistemática: dado un
// historial de snapshots crudos (1 por minuto, registrados por
// /api/odte-standalone/momentum-log mientras el mercado está abierto), REJUEGA
// `momentumEntry` con distintas combinaciones de parámetros y mide el win-rate
// real de cada una contra el spot que efectivamente ocurrió después.
//
// PURA — no hace fetch ni fs. El caller (ruta API) carga los archivos del disco
// (uno por sesión de mercado) y le pasa los snapshots ya parseados, agrupados
// por día — nunca se resuelve un trade cruzando a la sesión siguiente.
// ============================================================================

import { confirmMomentum, momentumEntry, type AltFlowCtx, type MomentumParams } from "./zerodteAlt";
import type { Direction, EntryDecision } from "./zerodteStrategy";

/** Snapshot crudo de UN minuto: todo lo que `momentumEntry` necesita para decidir
 *  (el mismo `AltFlowCtx` que ya arma la UI, aplanado) más lo que hace falta para
 *  resolver el trade después. */
export interface MomentumRawSnap {
  sec: number;
  spot: number;
  regime: "positive" | "negative";
  cvd: number | null;
  cvdDom: number | null;
  velocity: number | null;
  burstBull: number;
  burstBear: number;
  netGex: number | null;
  magnet: number | null;
  sigma: number | null;
  flip: number | null;
  callWall: number | null;
  putWall: number | null;
}

function toCtx(s: MomentumRawSnap): AltFlowCtx {
  return {
    regime: s.regime, cvd: s.cvd, cvdDom: s.cvdDom, velocity: s.velocity,
    burstBull: s.burstBull, burstBear: s.burstBear, netGex: s.netGex,
    spot: s.spot, magnet: s.magnet, sigma: s.sigma,
  };
}

interface OpenTrade { openSec: number; entrySpot: number; d: Direction; tgt: number; stop: number }

/** ¿Misma señal que la anterior? (misma dirección, target ≈ igual) — mismo criterio
 *  que ya usa `tradeEval.ts` para no contar el drift minuto a minuto como trades nuevos. */
function sameSig(a: EntryDecision | null, b: EntryDecision | null): boolean {
  return !!a && !!b && a.direction === b.direction && Math.abs(a.target - b.target) <= 1;
}

/** Resuelve un trade siguiendo el spot hacia adelante DENTRO DEL MISMO DÍA (el
 *  array `day` ya viene acotado a una sesión — nunca cruza a la siguiente). */
function resolve(t: OpenTrade, day: MomentumRawSnap[]): "win" | "loss" | "open" {
  for (const s of day) {
    if (s.sec <= t.openSec) continue;
    if (t.d === "long") {
      if (s.spot >= t.tgt) return "win";
      if (s.spot <= t.stop) return "loss";
    } else {
      if (s.spot <= t.tgt) return "win";
      if (s.spot >= t.stop) return "loss";
    }
  }
  return "open";
}

/**
 * Simula `momentumEntry` con UN set de parámetros sobre UN día (snapshots de esa
 * sesión, en cualquier orden). Extrae trades distintos (una racha de señal igual
 * = un trade, mismo criterio que `tradeEval.extractTrades`) y los resuelve contra
 * el spot que vino después. PURA.
 *
 * `persistRequired` (default 1 = sin gatear, preserva el comportamiento de
 * siempre) aplica `confirmMomentum` (zerodteAlt.ts) sobre la señal CRUDA antes
 * de abrir el trade — mismo principio que `applyPersistence` en
 * contratosVecinos3.ts. Permite comparar "como estaba" vs. "con persistencia"
 * sobre el mismo histórico real, igual que hizo el experimento de CV3.
 */
export function simulateMomentumDay(
  day: MomentumRawSnap[],
  params: MomentumParams,
  persistRequired: number = 1,
): { signals: OpenTrade[]; results: ("win" | "loss" | "open")[] } {
  const sorted = [...day].sort((a, b) => a.sec - b.sec);
  const signals: OpenTrade[] = [];
  let prev: EntryDecision | null = null; // último trade YA abierto
  let rawHistory: (EntryDecision | null)[] = [];
  for (const s of sorted) {
    if (s.regime !== "negative") { prev = null; rawHistory = []; continue; } // fuera de γ− momentumEntry ya da null
    const raw = momentumEntry(toCtx(s), s.callWall, s.putWall, s.flip, params);
    rawHistory.push(raw);
    const entry = confirmMomentum(rawHistory, persistRequired);
    if (entry && !sameSig(prev, entry)) {
      signals.push({ openSec: s.sec, entrySpot: s.spot, d: entry.direction, tgt: entry.target, stop: entry.stop });
    }
    prev = entry;
  }
  const results = signals.map((t) => resolve(t, sorted));
  return { signals, results };
}

export interface MomentumCalibrationResult {
  params: MomentumParams;
  signals: number;         // trades distintos generados (incluye los que quedaron abiertos)
  resolved: number;        // trades que tocaron target o stop antes del cierre
  wins: number;
  winRate: number | null;  // % sobre `resolved`
  avgRR: number | null;    // riesgo/beneficio promedio (del setup, no del resultado) de los resueltos
}

/** Corre UN set de parámetros sobre VARIOS días (uno por sesión) y agrega el resultado. PURA. */
export function evaluateParams(
  days: MomentumRawSnap[][],
  params: MomentumParams,
  persistRequired: number = 1,
): MomentumCalibrationResult {
  let signals = 0, resolved = 0, wins = 0, rrSum = 0, rrN = 0;
  for (const day of days) {
    const { signals: sigs, results } = simulateMomentumDay(day, params, persistRequired);
    signals += sigs.length;
    sigs.forEach((t, i) => {
      const r = results[i];
      if (r === "open") return;
      resolved++;
      if (r === "win") wins++;
      const reward = Math.abs(t.tgt - t.entrySpot);
      const risk = Math.abs(t.stop - t.entrySpot);
      if (risk > 0) { rrSum += reward / risk; rrN++; }
    });
  }
  return {
    params, signals, resolved, wins,
    winRate: resolved > 0 ? (wins / resolved) * 100 : null,
    avgRR: rrN > 0 ? rrSum / rrN : null,
  };
}

/**
 * Grid de candidatos a barrer, centrado en `MOMENTUM_DEFAULTS` (zerodteAlt.ts).
 * Pasos moderados a propósito: un barrido fino no tiene sentido con pocas
 * sesiones γ− reales acumuladas — más grillas finas que datos es sobreajuste.
 */
export function defaultGrid(): MomentumParams[] {
  const out: MomentumParams[] = [];
  for (const minRR of [1.0, 1.2, 1.5, 1.8, 2.2]) {
    for (const stopSigmaK of [0.35, 0.5, 0.65]) {
      for (const minStrength of [0.3, 0.4, 0.5, 0.6]) {
        for (const reachSigmaK of [1.5, 2.0, 2.5]) {
          out.push({ minRR, reachSigmaK, stopSigmaK, minStrength, minStopPts: 8, fallbackSigmaK: 1.2 });
        }
      }
    }
  }
  return out;
}

/** Bajo esta cantidad de trades resueltos, el win-rate de un set de parámetros
 *  es ruido — no se reporta como "mejor", por buena pinta que tenga. */
export const MIN_SAMPLES_FOR_TRUST = 20;

/**
 * Barre el grid completo sobre el histórico de días. `trusted` = solo los sets
 * que llegan a `MIN_SAMPLES_FOR_TRUST` resueltos, ordenados por win-rate desc.
 * `all` = TODOS los sets (para poder ver "cuánto falta" mientras se acumulan
 * sesiones), ordenados por cantidad de trades resueltos desc. PURA.
 */
export function calibrateMomentum(
  days: MomentumRawSnap[][],
  grid: MomentumParams[] = defaultGrid(),
): { trusted: MomentumCalibrationResult[]; all: MomentumCalibrationResult[] } {
  const all = grid.map((p) => evaluateParams(days, p));
  const trusted = all
    .filter((r) => r.resolved >= MIN_SAMPLES_FOR_TRUST)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));
  return { trusted, all: [...all].sort((a, b) => b.resolved - a.resolved) };
}
