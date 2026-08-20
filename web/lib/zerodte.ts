// ============================================================================
// Motor 0DTE — cadena del día (cero días al vencimiento) para índices/ETFs.
//
// Reúne, para el vencimiento de HOY (o el más cercano si hoy no cotiza), la
// cadena de MarketSnack (greeks/IV/OI/volumen REALES por contrato) en una vista
// enfocada al intradía:
//   · histograma de volumen call vs put por strike (espejo)
//   · muros MAX CALL / MAX PUT (por Open Interest)
//   · imán del GEX (gamma real, sin Black-Scholes) y régimen γ+/γ−
//   · sesgo del día (alcista/bajista/lateral) + confianza
//   · escenarios de cierre bear/base/bull acotados al cono de 1σ intradía
//
// Reglas de dominio (CLAUDE.md): comprar calls = alcista, vender calls =
// resistencia, comprar puts = cobertura/bajista, vender puts = soporte.
//
// Todo aquí es PURO y testeable. La I/O vive en app/api/0dte/*.
// ============================================================================

import type { Chain2Contract } from "./optionChain2";
import { gexByStrike, totalGex } from "./optionChain2";
import { estimateIV } from "./gex";
import { expectedMove } from "./expectedMove";
import type { FlowRow } from "./flow";

/** Solo strikes dentro de ±este % del spot entran a la vista 0DTE. */
export const NEAR_SPOT_PCT = 0.04;
/** Tope de strikes a cada lado del spot (para no saturar el histograma). */
export const MAX_STRIKES_PER_SIDE = 14;

export interface ZeroDteLeg {
  optionSymbol: string;
  volume: number;
  openInterest: number;
  /** Precio de referencia del contrato: mid → último → bid → ask. */
  price: number | null;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  gamma: number | null;
  iv: number | null;
  /** Open Premium = OI × precio(bid) × 100 (fórmula del Proceso Principal). */
  openPremium: number;
  /** Notional = OI × 100 × strike. */
  notional: number;
  /** Prima negociada HOY en ese contrato (de MarketSnack). */
  premiumTraded: number;
}

export interface ZeroDteStrike {
  strike: number;
  call: ZeroDteLeg | null;
  put: ZeroDteLeg | null;
  callVolume: number;
  putVolume: number;
  totalVolume: number;
  /** GEX neto del strike (calls +, puts −). */
  netGex: number;
  /** Lado ITM del strike respecto al spot (call si strike<spot, put si strike>spot). */
  itm: "call" | "put" | null;
}

export interface ZeroDteWall {
  strike: number;
  openInterest: number;
  volume: number;
  side: "call" | "put";
}

export interface ZeroDteScenario {
  kind: "bear" | "base" | "bull";
  target: number;
  changePct: number;
  driver: string;
}

export interface ZeroDteAnalysis {
  spot: number;
  /** IV representativa (decimal) usada para el cono intradía. */
  iv: number;
  strikes: ZeroDteStrike[];
  /** Volumen máximo por strike (call o put) para escalar el histograma. */
  maxVolume: number;
  /** Imán del GEX = strike de mayor |gamma neta| cerca del spot. */
  magnet: number | null;
  /** Zona de inversión gamma más cercana al spot. */
  flipStrike: number | null;
  regime: "positive" | "negative";
  totalGex: number;
  maxCall: ZeroDteWall | null;
  maxPut: ZeroDteWall | null;
  lean: "alcista" | "bajista" | "lateral";
  /** Confianza del sesgo, 0-100. */
  confidence: number;
  /** Puntuación firmada del sesgo (−100 bajista … +100 alcista). */
  leanScore: number;
  /** % de la prima negociada HOY que está en calls. */
  callPct: number | null;
  scenarios: { bear: ZeroDteScenario; base: ZeroDteScenario; bull: ZeroDteScenario };
  /** Rango esperado de cierre (1σ intradía). */
  expectedRange: { low: number; high: number; sigmaPct: number };
  /** Días (fracción) usados para el movimiento esperado intradía. */
  horizonDays: number;
}

/** Mid de un contrato: mid → (bid+ask)/2 → último. null si no hay nada usable. */
function midOf(c: Chain2Contract): number | null {
  if (c.mid != null && c.mid > 0) return c.mid;
  if (c.bid != null && c.ask != null && c.bid >= 0 && c.ask > 0) return (c.bid + c.ask) / 2;
  if (c.lastPrice != null && c.lastPrice > 0) return c.lastPrice;
  return null;
}

/**
 * Estima el precio del subyacente a partir de la cadena por paridad put-call:
 * para 0DTE, S ≈ K + C − P (tasas/dividendos despreciables). Se toma la MEDIANA de
 * las estimaciones por strike (robusta a quotes rancias en alas ITM/OTM). Es la
 * fuente de spot para índices como SPX, que Massive no cotiza con el ticker pelón.
 * PURA. Devuelve null si no hay suficientes pares call/put utilizables.
 */
export function estimateSpotFromChain(contracts: Chain2Contract[]): number | null {
  const byStrike = new Map<number, { call: Chain2Contract | null; put: Chain2Contract | null }>();
  for (const c of contracts) {
    const e = byStrike.get(c.strike) ?? { call: null, put: null };
    if (c.type === "call") e.call = c;
    else e.put = c;
    byStrike.set(c.strike, e);
  }
  const estimates: number[] = [];
  for (const [strike, e] of byStrike) {
    if (!e.call || !e.put) continue;
    const cm = midOf(e.call), pm = midOf(e.put);
    if (cm == null || pm == null) continue;
    const s = strike + cm - pm;
    if (Number.isFinite(s) && s > 0) estimates.push(s);
  }
  if (estimates.length === 0) return null;
  estimates.sort((a, b) => a - b);
  const mid = estimates.length >> 1;
  return estimates.length % 2 ? estimates[mid] : (estimates[mid - 1] + estimates[mid]) / 2;
}

function legOf(c: Chain2Contract): ZeroDteLeg {
  const price = c.mid ?? c.lastPrice ?? c.bid ?? c.ask ?? null;
  // Open Premium usa el bid (venta) por el Proceso Principal; si no hay, el mid.
  const premiumPrice = c.bid ?? c.mid ?? price ?? 0;
  return {
    optionSymbol: c.symbol,
    volume: c.volume,
    openInterest: c.openInterest,
    price,
    bid: c.bid,
    ask: c.ask,
    delta: c.delta,
    gamma: c.gamma,
    iv: c.iv,
    openPremium: c.openInterest * premiumPrice * 100,
    notional: c.openInterest * 100 * c.strike,
    premiumTraded: c.premiumTraded,
  };
}

/** IV representativa (decimal): media ATM de la cadena; si no hay, vol realizada. */
export function representativeIv(contracts: Chain2Contract[], closes: number[]): number {
  const atm = contracts.filter(
    (c) => c.iv != null && c.iv > 0 && c.iv <= 3 && c.delta != null && Math.abs(c.delta) >= 0.35 && Math.abs(c.delta) <= 0.65,
  );
  const pool = atm.length > 0 ? atm : contracts.filter((c) => c.iv != null && c.iv > 0 && c.iv <= 3);
  if (pool.length > 0) {
    const sum = pool.reduce((s, c) => s + (c.iv as number), 0);
    return sum / pool.length;
  }
  return estimateIV(closes);
}

export interface ZeroDteInput {
  contracts: Chain2Contract[];
  spot: number;
  closes: number[];
  now: Date;
  /** Días (fracción) que restan de la sesión, para el cono de cierre. */
  horizonDays: number;
}

/** Construye la vista 0DTE a partir de la cadena normalizada de MarketSnack. */
export function buildZeroDte(input: ZeroDteInput): ZeroDteAnalysis {
  const { contracts, spot, closes, horizonDays } = input;
  const iv = representativeIv(contracts, closes);
  const em = expectedMove(spot, iv, Math.max(horizonDays, 0.01));

  // ── GEX real por strike (gamma de MarketSnack, sin Black-Scholes) ──
  const gexStrikes = gexByStrike(contracts, spot);
  const gexBy = new Map<number, number>();
  for (const g of gexStrikes) gexBy.set(g.strike, g.gex);
  const total = totalGex(gexStrikes);

  // ── Agrupa contratos por strike (call/put) ──
  const byStrike = new Map<number, { call: Chain2Contract | null; put: Chain2Contract | null }>();
  for (const c of contracts) {
    const e = byStrike.get(c.strike) ?? { call: null, put: null };
    if (c.type === "call") e.call = c;
    else e.put = c;
    byStrike.set(c.strike, e);
  }

  const lo = spot * (1 - NEAR_SPOT_PCT);
  const hi = spot * (1 + NEAR_SPOT_PCT);

  const near = [...byStrike.entries()]
    .filter(([strike]) => strike >= lo && strike <= hi)
    .sort((a, b) => a[0] - b[0]);

  // Recorta a ±MAX_STRIKES_PER_SIDE alrededor del spot.
  const belowIdx = near.filter(([s]) => s <= spot).length;
  const start = Math.max(0, belowIdx - MAX_STRIKES_PER_SIDE);
  const end = Math.min(near.length, belowIdx + MAX_STRIKES_PER_SIDE);
  const windowed = near.slice(start, end);

  const strikes: ZeroDteStrike[] = windowed.map(([strike, e]) => {
    const call = e.call ? legOf(e.call) : null;
    const put = e.put ? legOf(e.put) : null;
    return {
      strike,
      call,
      put,
      callVolume: call?.volume ?? 0,
      putVolume: put?.volume ?? 0,
      totalVolume: (call?.volume ?? 0) + (put?.volume ?? 0),
      netGex: gexBy.get(strike) ?? 0,
      itm: strike < spot ? "call" : strike > spot ? "put" : null,
    };
  });

  const maxVolume = strikes.reduce((m, s) => Math.max(m, s.callVolume, s.putVolume), 0);

  // ── Muros por Open Interest (concepto de "muro" del Proceso Principal) ──
  let maxCall: ZeroDteWall | null = null;
  let maxPut: ZeroDteWall | null = null;
  for (const s of strikes) {
    if (s.call && (!maxCall || s.call.openInterest > maxCall.openInterest)) {
      maxCall = { strike: s.strike, openInterest: s.call.openInterest, volume: s.call.volume, side: "call" };
    }
    if (s.put && (!maxPut || s.put.openInterest > maxPut.openInterest)) {
      maxPut = { strike: s.strike, openInterest: s.put.openInterest, volume: s.put.volume, side: "put" };
    }
  }

  // ── Imán del GEX: strike de mayor |gamma neta| cerca del spot ──
  let magnet: number | null = null;
  let bestMag = 0;
  for (const s of strikes) {
    const mag = Math.abs(s.netGex);
    if (mag > bestMag) { bestMag = mag; magnet = s.strike; }
  }

  // ── Zona de inversión gamma más cercana al spot ──
  let flipStrike: number | null = null;
  let bestDist = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const a = strikes[i - 1], b = strikes[i];
    if ((a.netGex < 0 && b.netGex >= 0) || (a.netGex > 0 && b.netGex <= 0)) {
      const span = Math.abs(a.netGex) + Math.abs(b.netGex);
      const cross = span > 0 ? a.strike + (b.strike - a.strike) * (Math.abs(a.netGex) / span) : (a.strike + b.strike) / 2;
      const dist = Math.abs(cross - spot);
      if (dist < bestDist) { bestDist = dist; flipStrike = cross; }
    }
  }

  const regime: "positive" | "negative" = total >= 0 ? "positive" : "negative";

  // ── Dirección del dinero HOY: % de la prima negociada que está en calls ──
  let callTraded = 0, putTraded = 0;
  for (const s of strikes) {
    callTraded += s.call?.premiumTraded ?? 0;
    putTraded += s.put?.premiumTraded ?? 0;
  }
  const tradedTotal = callTraded + putTraded;
  const callPct = tradedTotal > 0 ? Math.round((callTraded / tradedTotal) * 100) : null;

  // ── Sesgo del día (−100 bajista … +100 alcista) ──
  let leanScore = 0;
  if (callPct != null) leanScore += (callPct - 50) * 1.2; // dinero direccional
  if (magnet != null && spot > 0) {
    const pull = ((magnet - spot) / spot) * 100; // % del imán respecto al spot
    // En γ+ el imán ATRAE (revierte hacia él); en γ− el precio se aleja del imán.
    leanScore += (regime === "positive" ? pull : -pull) * 8;
  }
  leanScore = Math.max(-100, Math.min(100, Math.round(leanScore)));
  const lean: ZeroDteAnalysis["lean"] =
    leanScore > 20 ? "alcista" : leanScore < -20 ? "bajista" : "lateral";

  // Confianza: nitidez del imán (share del |GEX|) + extremidad del dinero.
  const sumMag = strikes.reduce((s, k) => s + Math.abs(k.netGex), 0);
  const sharpness = sumMag > 0 ? bestMag / sumMag : 0;
  const moneyExtremity = callPct != null ? Math.min(1, Math.abs(callPct - 50) / 30) : 0;
  const confidence = Math.round(100 * Math.min(1, 0.6 * sharpness + 0.4 * moneyExtremity));

  // ── Escenarios de cierre (acotados al cono de 1σ intradía) ──
  const clip1 = (x: number) => Math.min(Math.max(x, em.lower1), em.upper1);
  const baseTarget = magnet != null ? clip1(magnet) : spot;
  const bullTarget = Math.max(maxCall ? maxCall.strike : em.upper1, baseTarget, em.upper1 * 0.999);
  const bearTarget = Math.min(maxPut ? maxPut.strike : em.lower1, baseTarget, em.lower1 * 1.001);
  const clip = (x: number) => Math.min(Math.max(x, em.lower2), em.upper2);

  const pctChange = (t: number) => (spot > 0 ? ((t - spot) / spot) * 100 : 0);
  const scenarios = {
    base: {
      kind: "base" as const,
      target: baseTarget,
      changePct: pctChange(baseTarget),
      driver: magnet != null
        ? `Imán del GEX en $${baseTarget.toFixed(2)} — ${regime === "positive" ? "el dealer estabiliza (γ+): tiende a frenar ahí" : "el dealer amplifica (γ−): si llega, acelera"}`
        : "Sin gamma suficiente para fijar un imán; se toma el spot",
    },
    bull: {
      kind: "bull" as const,
      target: clip(bullTarget),
      changePct: pctChange(clip(bullTarget)),
      driver: maxCall
        ? `Muro de calls (MAX CALL) en $${maxCall.strike.toFixed(2)}: resistencia del día`
        : "Techo de 1σ intradía",
    },
    bear: {
      kind: "bear" as const,
      target: clip(bearTarget),
      changePct: pctChange(clip(bearTarget)),
      driver: maxPut
        ? `Muro de puts (MAX PUT) en $${maxPut.strike.toFixed(2)}: soporte del día`
        : "Suelo de 1σ intradía",
    },
  };

  return {
    spot,
    iv,
    strikes,
    maxVolume,
    magnet,
    flipStrike,
    regime,
    totalGex: total,
    maxCall,
    maxPut,
    lean,
    confidence,
    leanScore,
    callPct,
    scenarios,
    expectedRange: { low: em.lower1, high: em.upper1, sigmaPct: em.sigmaPct },
    horizonDays,
  };
}

// ============================================================================
// Lecturas de agresor (flow del día) por strike + lado.
// Regla de dominio: comprar call = alcista, vender put = soporte,
// comprar put = cobertura/bajista, vender call = resistencia.
// ============================================================================

export type AggressorSide = "compra" | "venta" | "mixto";

export interface AggressorRead {
  key: string;          // `${type}:${strike}` p. ej. "call:745"
  type: "call" | "put";
  strike: number;
  side: AggressorSide;
  /** % de la prima del contrato que domina el lado (0-100). */
  pct: number;
  premium: number;
  trades: number;
  /** Interpretación en lenguaje llano según la tabla del Proceso Principal. */
  meaning: string;
}

function meaningOf(type: "call" | "put", side: AggressorSide): string {
  if (side === "mixto") return "";
  if (type === "call") return side === "compra" ? "direccional alcista" : "resistencia / muro";
  return side === "compra" ? "cobertura o bajista" : "soporte";
}

/**
 * Agrega el flujo (Time & Sales clasificado) por contrato del vencimiento 0DTE y
 * decide el lado dominante (compra al ask, venta al bid). PURA.
 */
export function aggressorReads(rows: FlowRow[], expiration: string): AggressorRead[] {
  const groups = new Map<string, { type: "call" | "put"; strike: number; ask: number; bid: number; trades: number }>();
  for (const r of rows) {
    if (r.expiration !== expiration) continue;
    if ((r.type !== "call" && r.type !== "put") || r.strike == null) continue;
    if (r.aggression !== "ask" && r.aggression !== "bid") continue;
    const key = `${r.type}:${r.strike}`;
    const g = groups.get(key) ?? { type: r.type, strike: r.strike, ask: 0, bid: 0, trades: 0 };
    if (r.aggression === "ask") g.ask += r.premium;
    else g.bid += r.premium;
    g.trades += 1;
    groups.set(key, g);
  }

  const reads: AggressorRead[] = [];
  for (const [key, g] of groups) {
    const premium = g.ask + g.bid;
    if (premium <= 0) continue;
    const dominant = Math.max(g.ask, g.bid);
    const pct = Math.round((dominant / premium) * 100);
    const side: AggressorSide = pct < 60 ? "mixto" : g.ask >= g.bid ? "compra" : "venta";
    reads.push({
      key,
      type: g.type,
      strike: g.strike,
      side,
      pct,
      premium,
      trades: g.trades,
      meaning: meaningOf(g.type, side),
    });
  }

  return reads.sort((a, b) => b.premium - a.premium);
}
