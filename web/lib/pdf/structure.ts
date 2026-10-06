// ============================================================================
// Sub-agente 4 — ACUMULACIÓN Y RAPIDEZ (categoría "Estructura" del scorecard)
// Identifica el posicionamiento y las fechas de expiración relevantes analizando
// la actividad por strike y por vencimiento en la cadena de opciones.
// Ver SCOREDCARD/Acumulacion-Rapidez.md
// ============================================================================

import type { Row } from "./types";

/** Debajo de este nocional promedio la cadena se marca como "Baja Liquidez". */
export const LOW_LIQUIDITY_NOTIONAL = 25_000_000;

/** Un lado (calls o puts) "domina" un strike si tiene al menos este % de su nocional. */
export const STRIKE_DOMINANCE_PCT = 60;

/** Cuántos strikes (los de mayor nocional) se evalúan para la dominancia. */
export const TOP_STRIKES_CONSIDERED = 5;

/** 1. Puntuación por Valor Nocional promedio (Strike × Open Interest × 100). */
export function notionalScore(avgNotional: number): number {
  if (avgNotional > 1_000_000_000) return 10;
  if (avgNotional >= 500_000_000) return 10;
  if (avgNotional >= 100_000_000) return 8;
  if (avgNotional >= 50_000_000) return 6;
  if (avgNotional >= 25_000_000) return 4;
  return 2;
}

/**
 * 2. Puntuación por en cuántos strikes domina claramente un lado (calls o puts).
 * NO mide concentración de nocional: mide dominancia direccional por strike.
 */
export function dominantStrikesScore(count: number): number {
  if (count >= 5) return 10;
  if (count >= 3) return 8;
  if (count >= 1) return 5;
  return 0; // sin visibilidad clara
}

/** 3. Puntuación por % de contratos donde el volumen supera el Open Interest. */
export function volumeOverOIScore(pct: number): number {
  if (pct >= 100) return 10;
  if (pct >= 50) return 8;
  if (pct >= 30) return 5;
  return 2;
}

export interface StrikeStat {
  strike: number;
  notional: number;
  pctOfTotal: number;
  callNotional: number;
  putNotional: number;
  side: "calls" | "puts";
  /** % del nocional del strike que tiene el lado mayoritario (0-100). */
  dominancePct: number;
  /** ¿Ese lado supera el umbral de dominancia? */
  dominant: boolean;
  openInterest: number;
  volume: number;
  expirations: number;
}

export interface ExpirationStat {
  expiration: string;
  notional: number;
  pctOfTotal: number;
  callNotional: number;
  putNotional: number;
  contracts: number;
}

export interface StructureScore {
  score: number; // 0-10 de la categoría
  notional: {
    avgPerStrike: number;
    total: number;
    strikeCount: number;
    points: number;
    lowLiquidity: boolean;
  };
  strikes: {
    dominantCount: number; // de los top strikes, en cuántos domina un lado
    consideredCount: number; // cuántos strikes se evaluaron (tope 5)
    points: number;
    top: StrikeStat[];
    callPct: number; // % del nocional en calls
    putPct: number;
    dominantSide: "calls" | "puts";
  };
  volOI: {
    pct: number;
    exceeded: number;
    considered: number;
    points: number;
  };
  expirations: ExpirationStat[]; // vencimientos más relevantes
}

/**
 * Analiza la cadena de opciones: nocional por strike, dominio calls/puts,
 * y cuántas veces el volumen supera al Open Interest.
 */
export function structureScore(rows: Row[]): StructureScore {
  const empty: StructureScore = {
    score: 0,
    notional: { avgPerStrike: 0, total: 0, strikeCount: 0, points: 0, lowLiquidity: true },
    strikes: { dominantCount: 0, consideredCount: 0, points: 0, top: [], callPct: 0, putPct: 0, dominantSide: "calls" },
    volOI: { pct: 0, exceeded: 0, considered: 0, points: 0 },
    expirations: [],
  };
  if (rows.length === 0) return empty;

  // ── 1. Nocional agrupado por strike (Strike × OI × 100, sumado por strike)
  const byStrike = new Map<number, StrikeStat>();
  const byExp = new Map<string, ExpirationStat>();
  let total = 0;
  let callTotal = 0, putTotal = 0;

  for (const r of rows) {
    const n = r.notionalValue;
    total += n;
    if (r.contractType === "call") callTotal += n;
    else putTotal += n;

    const s = byStrike.get(r.strike) ?? {
      strike: r.strike, notional: 0, pctOfTotal: 0,
      callNotional: 0, putNotional: 0, side: "calls" as const,
      dominancePct: 0, dominant: false,
      openInterest: 0, volume: 0, expirations: 0,
    };
    s.notional += n;
    if (r.contractType === "call") s.callNotional += n;
    else s.putNotional += n;
    s.openInterest += r.openInterest;
    s.volume += r.volume;
    s.expirations += 1;
    byStrike.set(r.strike, s);

    if (r.expiration) {
      const e = byExp.get(r.expiration) ?? {
        expiration: r.expiration, notional: 0, pctOfTotal: 0,
        callNotional: 0, putNotional: 0, contracts: 0,
      };
      e.notional += n;
      if (r.contractType === "call") e.callNotional += n;
      else e.putNotional += n;
      e.contracts += 1;
      byExp.set(r.expiration, e);
    }
  }

  const strikeStats = [...byStrike.values()];
  const strikeCount = strikeStats.length;
  const avgPerStrike = strikeCount > 0 ? total / strikeCount : 0;

  for (const s of strikeStats) {
    s.pctOfTotal = total > 0 ? (s.notional / total) * 100 : 0;
    s.side = s.callNotional >= s.putNotional ? "calls" : "puts";
    s.dominancePct = s.notional > 0
      ? (Math.max(s.callNotional, s.putNotional) / s.notional) * 100
      : 0;
    s.dominant = s.notional > 0 && s.dominancePct >= STRIKE_DOMINANCE_PCT;
  }

  // ── 2. Dominio de strikes: entre los de MAYOR NOCIONAL, en cuántos domina
  // claramente un lado (calls sobre puts o viceversa).
  const byNotional = [...strikeStats].sort((a, b) => b.notional - a.notional);
  const considered = byNotional.slice(0, TOP_STRIKES_CONSIDERED);
  const dominantCount = considered.filter((s) => s.dominant).length;
  const top = byNotional.slice(0, 10);

  // ── 3. Volumen vs Open Interest
  const activos = rows.filter((r) => r.openInterest > 0 || r.volume > 0);
  const exceeded = activos.filter((r) => r.volume > r.openInterest).length;
  const volPct = activos.length > 0 ? (exceeded / activos.length) * 100 : 0;

  const nPoints = notionalScore(avgPerStrike);
  const sPoints = dominantStrikesScore(dominantCount);
  const vPoints = volumeOverOIScore(volPct);

  const expirations = [...byExp.values()]
    .map((e) => ({ ...e, pctOfTotal: total > 0 ? (e.notional / total) * 100 : 0 }))
    .sort((a, b) => b.notional - a.notional)
    .slice(0, 10);

  return {
    score: Math.round((nPoints + sPoints + vPoints) / 3),
    notional: {
      avgPerStrike, total, strikeCount, points: nPoints,
      lowLiquidity: avgPerStrike < LOW_LIQUIDITY_NOTIONAL,
    },
    strikes: {
      dominantCount, consideredCount: considered.length, points: sPoints, top,
      callPct: total > 0 ? (callTotal / total) * 100 : 0,
      putPct: total > 0 ? (putTotal / total) * 100 : 0,
      dominantSide: callTotal >= putTotal ? "calls" : "puts",
    },
    volOI: { pct: volPct, exceeded, considered: activos.length, points: vPoints },
    expirations,
  };
}
