// Heatmap de GEX por strike × vencimiento.
//
// La gráfica de nodos resume el GEX en una sola dimensión (el strike). Este módulo
// lo abre en dos: cada celda es el GEX neto de un strike en un vencimiento concreto,
// que es donde se ve qué expiración está sosteniendo cada muro.
//
// Datos: cadena completa de Massive (strike, vencimiento, OI, tipo) + gamma calculada
// con Black-Scholes, anclada a la gamma real de MarketSnack donde el strike operó.

import { bsGamma } from "./gex";
import type { Row } from "./types";

export interface HeatTrade {
  strike: number | null;
  expiration: string | null;
  gamma: number;
  premium: number;
}

export interface HeatCell {
  strike: number;
  expiration: string;
  /** GEX neto en $ por 1% de movimiento (+ calls / − puts). */
  netGex: number;
  callGex: number;
  putGex: number;
  openInterest: number;
  /** Intensidad 0-1 dentro de la malla, para el color. */
  intensity: number;
}

export interface HeatExpiration {
  expiration: string;
  dte: number;
  /** GEX neto sumando todos los strikes de ese vencimiento. */
  netGex: number;
  openInterest: number;
}

export interface HeatStrike {
  strike: number;
  netGex: number;
  callGex: number;
  putGex: number;
  openInterest: number;
  /** Distancia al spot en %. */
  distancePct: number;
}

export interface GexHeatmap {
  spot: number;
  iv: number;
  strikes: HeatStrike[];       // de mayor a menor precio (como se pinta)
  expirations: HeatExpiration[]; // de más cercano a más lejano
  cells: HeatCell[];
  /** |GEX| máximo de una celda — referencia del color. */
  maxAbsCell: number;
  /** Celda con más gamma negativa y más positiva (los extremos que importan). */
  hottestPositive: HeatCell | null;
  hottestNegative: HeatCell | null;
  totalNetGex: number;
}

const EMPTY: GexHeatmap = {
  spot: 0, iv: 0, strikes: [], expirations: [], cells: [],
  maxAbsCell: 0, hottestPositive: null, hottestNegative: null, totalNetGex: 0,
};

export interface HeatmapInput {
  rows: Row[];
  spot: number;
  iv: number;
  trades?: HeatTrade[];
  now: Date;
  /** Cuántos strikes a cada lado del spot. */
  strikeRadius?: number;
  /** Cuántos vencimientos (los más cercanos). */
  maxExpirations?: number;
  /** Greeks REALES de Schwab por contrato (`${strike}|${expiration}|${type}`). */
  schwabGreeks?: Map<string, { gamma?: number; iv?: number }>;
}

function dteOf(expiration: string, now: Date): number {
  const ms = new Date(`${expiration}T21:00:00Z`).getTime() - now.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function gexHeatmap(input: HeatmapInput): GexHeatmap {
  const { rows, spot, iv, trades = [], now, strikeRadius = 18, maxExpirations = 8, schwabGreeks } = input;
  if (!(spot > 0) || rows.length === 0) return EMPTY;

  // Gamma real de MarketSnack por (strike, vencimiento) para anclar la estimación.
  const realGamma = new Map<string, { sum: number; n: number }>();
  for (const t of trades) {
    if (t.strike == null || !t.expiration || !(t.gamma > 0)) continue;
    const k = `${t.strike}|${t.expiration}`;
    const e = realGamma.get(k) ?? { sum: 0, n: 0 };
    e.sum += t.gamma; e.n += 1;
    realGamma.set(k, e);
  }

  // Vencimientos más cercanos con contratos vivos.
  const expSet = new Map<string, number>();
  for (const r of rows) {
    if (!r.expiration || r.openInterest <= 0) continue;
    expSet.set(r.expiration, (expSet.get(r.expiration) ?? 0) + r.openInterest);
  }
  const expirations = [...expSet.keys()]
    .sort()
    .filter((e) => dteOf(e, now) >= 0)
    .slice(0, maxExpirations);
  if (expirations.length === 0) return EMPTY;
  const expSelected = new Set(expirations);

  // Strikes alrededor del spot: los `strikeRadius` más cercanos por cada lado.
  const allStrikes = [...new Set(rows.filter((r) => expSelected.has(r.expiration)).map((r) => r.strike))]
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  const above = allStrikes.filter((s) => s >= spot).slice(0, strikeRadius);
  const below = allStrikes.filter((s) => s < spot).slice(-strikeRadius);
  const strikeSet = new Set([...below, ...above]);
  if (strikeSet.size === 0) return EMPTY;

  // Acumulación por celda.
  const cellMap = new Map<string, HeatCell>();
  for (const r of rows) {
    if (!expSelected.has(r.expiration) || !strikeSet.has(r.strike)) continue;
    if (r.openInterest <= 0) continue;

    const dte = dteOf(r.expiration, now);
    const T = Math.max(dte, 1) / 365;
    // 1º Schwab (gamma real de mercado) → 2º Black-Scholes anclado a MarketSnack.
    const sg = schwabGreeks?.get(`${r.strike}|${r.expiration}|${r.contractType}`);
    let gamma: number;
    if (sg?.gamma != null && sg.gamma > 0) {
      gamma = sg.gamma;
    } else {
      const contractIv = sg?.iv != null && sg.iv > 0 ? sg.iv : iv;
      gamma = bsGamma(spot, r.strike, T, contractIv);
      const anchor = realGamma.get(`${r.strike}|${r.expiration}`);
      if (anchor && anchor.n > 0) gamma = (gamma + anchor.sum / anchor.n) / 2;
    }

    // GEX = Γ · OI · 100 · S² · 0.01 — dólares por 1% de movimiento.
    const gex = gamma * r.openInterest * 100 * spot * spot * 0.01;
    const key = `${r.strike}|${r.expiration}`;
    const cell = cellMap.get(key) ?? {
      strike: r.strike, expiration: r.expiration,
      netGex: 0, callGex: 0, putGex: 0, openInterest: 0, intensity: 0,
    };
    if (r.contractType === "call") { cell.callGex += gex; cell.netGex += gex; }
    else { cell.putGex += gex; cell.netGex -= gex; }
    cell.openInterest += r.openInterest;
    cellMap.set(key, cell);
  }

  const cells = [...cellMap.values()];
  if (cells.length === 0) return EMPTY;

  const maxAbsCell = Math.max(...cells.map((c) => Math.abs(c.netGex)), 1);
  for (const c of cells) c.intensity = Math.min(1, Math.abs(c.netGex) / maxAbsCell);

  // Totales por strike (fila) y por vencimiento (columna).
  const byStrike = new Map<number, HeatStrike>();
  for (const c of cells) {
    const s = byStrike.get(c.strike) ?? {
      strike: c.strike, netGex: 0, callGex: 0, putGex: 0, openInterest: 0,
      distancePct: ((c.strike - spot) / spot) * 100,
    };
    s.netGex += c.netGex; s.callGex += c.callGex; s.putGex += c.putGex;
    s.openInterest += c.openInterest;
    byStrike.set(c.strike, s);
  }

  const byExp = new Map<string, HeatExpiration>();
  for (const c of cells) {
    const e = byExp.get(c.expiration) ?? {
      expiration: c.expiration, dte: dteOf(c.expiration, now), netGex: 0, openInterest: 0,
    };
    e.netGex += c.netGex; e.openInterest += c.openInterest;
    byExp.set(c.expiration, e);
  }

  const sortedCells = [...cells].sort((a, b) => b.netGex - a.netGex);

  return {
    spot, iv,
    // Precio alto arriba, como en cualquier tabla de opciones.
    strikes: [...byStrike.values()].sort((a, b) => b.strike - a.strike),
    expirations: [...byExp.values()].sort((a, b) => a.expiration.localeCompare(b.expiration)),
    cells,
    maxAbsCell,
    hottestPositive: sortedCells[0]?.netGex > 0 ? sortedCells[0] : null,
    hottestNegative: sortedCells[sortedCells.length - 1]?.netGex < 0
      ? sortedCells[sortedCells.length - 1] : null,
    totalNetGex: cells.reduce((s, c) => s + c.netGex, 0),
  };
}
