// "Soportes y Resistencias en vivo — SPX" (el usuario, 2026-07-30): combina el
// net premium call vs put por strike (mismo concepto que lib/neighborContracts.ts,
// "contratos vecinos") con el GEX REAL de MarketSnack por strike (gamma real,
// no la aproximación Black-Scholes de lib/gex.ts/lib/gexHeatmap.ts) para marcar
// confluencia/conflicto entre flujo y posicionamiento de dealers. PURO — el
// fetch a MarketSnack vive en lib/marketsnack.ts.
//
// Fuente: `GET /api/assets/{ticker}/option_chain_extended?expiration_date=`
// trae, para TODOS los strikes de una expiración en una sola llamada, greeks
// reales (incluida gamma) y `premium_breakdown: {bid, mid, ask}` — el mismo
// net premium de hoy que ya usamos vía trade_summaries, pero sin tener que
// pedir contrato por contrato. `GET /api/assets/{ticker}/gex_stats_chart`
// trae el GEX agregado ya calculado por MarketSnack (call_wall, put_wall,
// magnet, gamma_flip, net_gex) — el "GEX de MarketSnack" que pidió el usuario,
// no algo que debamos recalcular nosotros.

import {
  dominantSideAt,
  type ContractPremiumSummary,
  type DominantSide,
  type StrikePremiums,
} from "./neighborContracts";

export interface GexStatsBucket {
  t: string;
  net_gex: number;
  call_wall: number;
  put_wall: number;
  magnet: number;
  max_pain: number;
  // MarketSnack devuelve null cuando el bucket todavía no tiene un flip real
  // que reportar (visto en vivo, 2026-08-01) — no siempre es un number.
  gamma_flip: number | null;
  asset_price: number;
}

export interface ExtendedChainContract {
  symbol: string;
  strike: number;
  type: "call" | "put";
  expiration: string;
  open_interest: number;
  volume: number;
  price: number | null;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  implied_volatility: number | null;
  premium_breakdown: { bid: number; mid: number; ask: number };
}

export interface SpxLevelRow {
  strike: number;
  call: ContractPremiumSummary | null;
  put: ContractPremiumSummary | null;
  dominant: DominantSide;
  callGex: number;
  putGex: number;
  netGex: number;
  badge: "call_wall" | "put_wall" | null;
  /** El lado dominante en net premium coincide con el signo del GEX en ese strike. */
  confluence: boolean;
  /** Se contradicen: net premium apunta a un lado, el GEX al contrario. */
  conflict: boolean;
  lectura: string;
}

/** Reduce `premium_breakdown` (bid/mid/ask) por contrato a `StrikePremiums`
 *  agrupado por strike — mismo shape que consume `dominantSideAt`, pero sin
 *  pasar por `trade_summaries`/símbolos OCC: acá strike y tipo ya vienen como
 *  campos directos en cada contrato. */
export function toStrikePremiumsFromExtendedChain(
  contracts: ExtendedChainContract[],
): Map<number, StrikePremiums> {
  const out = new Map<number, StrikePremiums>();
  for (const c of contracts) {
    const summary: ContractPremiumSummary = {
      netPremium: c.premium_breakdown.ask - c.premium_breakdown.bid,
      askPremium: c.premium_breakdown.ask,
      bidPremium: c.premium_breakdown.bid,
      // option_chain_extended no desglosa volumen por lado (solo premium) —
      // sin uso hoy en esta tarjeta, en 0 para no inventar un dato que no viene.
      askVolume: 0,
      bidVolume: 0,
    };
    const level = out.get(c.strike) ?? { strike: c.strike, call: null, put: null };
    if (c.type === "call") level.call = summary; else level.put = summary;
    out.set(c.strike, level);
  }
  return out;
}

/**
 * GEX real por strike: MISMA fórmula y signo que `lib/gexHeatmap.ts`
 * (`gamma * openInterest * 100 * spot² * 0.01`, calls suman, puts restan del
 * neto) — la única diferencia real es que acá `gamma` es la real de
 * MarketSnack (`contracts[i].greeks.gamma`), no una estimación Black-Scholes.
 */
export function computeStrikeGex(
  contracts: ExtendedChainContract[],
  spot: number,
): Map<number, { callGex: number; putGex: number; netGex: number }> {
  const out = new Map<number, { callGex: number; putGex: number; netGex: number }>();
  for (const c of contracts) {
    if (!(c.open_interest > 0) || !(c.greeks.gamma > 0)) continue;
    const gex = c.greeks.gamma * c.open_interest * 100 * spot * spot * 0.01;
    const entry = out.get(c.strike) ?? { callGex: 0, putGex: 0, netGex: 0 };
    if (c.type === "call") { entry.callGex += gex; entry.netGex += gex; }
    else { entry.putGex += gex; entry.netGex -= gex; }
    out.set(c.strike, entry);
  }
  return out;
}

/** El strike de referencia (call_wall/put_wall) más cercano, dentro de medio
 *  paso de grilla ($2.50, strikes de SPX cerca del spot vienen cada $5). */
function badgeFor(strike: number, gexStats: GexStatsBucket | null): SpxLevelRow["badge"] {
  if (!gexStats) return null;
  const HALF_STEP = 2.5;
  if (Math.abs(strike - gexStats.call_wall) <= HALF_STEP) return "call_wall";
  if (Math.abs(strike - gexStats.put_wall) <= HALF_STEP) return "put_wall";
  return null;
}

/**
 * Arma la tabla de niveles, strike por strike, dentro de `radius` (default
 * $25) del spot. Camina desde el spot hacia afuera en cada dirección para
 * encontrar el primer strike donde la dominancia de net premium se invierte
 * respecto al lado "natural" de ese lado (arriba se espera call, abajo se
 * espera put) — ese strike es la resistencia/soporte; más allá de ahí,
 * "imán"; entre el spot y ahí, "piso/techo". Primera pasada de esta
 * clasificación (el usuario, 2026-07-30) — pensada para ajustarse viéndola en
 * vivo, no hay un precedente exacto de este texto en el resto del agente.
 */
export function buildSpxLevelsTable(input: {
  contracts: ExtendedChainContract[];
  spot: number;
  gexStats: GexStatsBucket | null;
  radius?: number;
}): SpxLevelRow[] {
  const { contracts, spot, gexStats } = input;
  const radius = input.radius ?? 25;

  const strikePremiums = toStrikePremiumsFromExtendedChain(contracts);
  const gexByStrike = computeStrikeGex(contracts, spot);

  const strikes = [...strikePremiums.keys()]
    .filter((s) => Math.abs(s - spot) <= radius)
    .sort((a, b) => b - a); // de mayor a menor precio, como cualquier tabla de opciones

  const aboveAsc = strikes.filter((s) => s > spot).sort((a, b) => a - b); // más cerca del spot primero
  const belowDesc = strikes.filter((s) => s < spot).sort((a, b) => b - a); // más cerca del spot primero

  const findFlip = (ordered: number[], naturalSide: DominantSide): number | null => {
    for (const s of ordered) {
      const level = strikePremiums.get(s);
      const dominant = level ? dominantSideAt(level) : "tie";
      if (dominant !== naturalSide) return s;
    }
    return null;
  };
  const aboveFlip = findFlip(aboveAsc, "call");
  const belowFlip = findFlip(belowDesc, "put");

  return strikes.map((strike) => {
    const level = strikePremiums.get(strike) ?? { strike, call: null, put: null };
    const dominant = dominantSideAt(level);
    const gex = gexByStrike.get(strike) ?? { callGex: 0, putGex: 0, netGex: 0 };
    const gexSide: DominantSide = gex.netGex === 0 ? "tie" : gex.netGex > 0 ? "call" : "put";
    const confluence = dominant !== "tie" && dominant === gexSide;
    const conflict = dominant !== "tie" && gexSide !== "tie" && dominant !== gexSide;
    const badge = badgeFor(strike, gexStats);

    let lectura: string;
    if (strike > spot) {
      if (strike === aboveFlip) lectura = "Resistencia — el flujo de puts toma el control acá";
      else if (aboveFlip != null && strike > aboveFlip) lectura = "Imán alcista más allá de la resistencia";
      else lectura = "Techo — calls dominan, no sube fácil";
    } else if (strike < spot) {
      if (strike === belowFlip) lectura = "Soporte — el flujo de calls toma el control acá";
      else if (belowFlip != null && strike < belowFlip) lectura = "Imán bajista más allá del soporte";
      else lectura = "Piso — puts dominan, no baja fácil";
    } else {
      lectura = "Spot";
    }
    if (conflict) lectura = "Flujo vs GEX en conflicto — nivel poco fiable";
    else if (confluence) lectura += " · FUERTE (confluencia con GEX)";

    return {
      strike, call: level.call, put: level.put, dominant,
      callGex: gex.callGex, putGex: gex.putGex, netGex: gex.netGex,
      badge, confluence, conflict, lectura,
    };
  });
}

export interface TopVolumeContract {
  strike: number;
  type: "call" | "put";
  volume: number;
  netPremium: number;
  dominantSideHere: DominantSide;
}

/**
 * Panel APARTE, informativo (el usuario, 2026-08-01): los 10 calls y los 10 puts
 * de mayor volumen del día — "dónde está la acción hoy". NO toca ni alimenta
 * `buildSpxLevelsTable` (flip strike/confluencia) — es solo un ranking por
 * `.volume` sobre la MISMA cadena 0DTE que ya trae `option_chain_extended`,
 * separado por lado, 10+10 (no 10 combinados).
 */
export function topByVolume(
  contracts: ExtendedChainContract[],
  count = 10,
): { calls: TopVolumeContract[]; puts: TopVolumeContract[] } {
  const strikePremiums = toStrikePremiumsFromExtendedChain(contracts);

  const toRow = (c: ExtendedChainContract): TopVolumeContract => {
    const level = strikePremiums.get(c.strike) ?? null;
    return {
      strike: c.strike,
      type: c.type,
      volume: c.volume,
      netPremium: c.premium_breakdown.ask - c.premium_breakdown.bid,
      dominantSideHere: level ? dominantSideAt(level) : "tie",
    };
  };

  const bySide = (type: "call" | "put"): TopVolumeContract[] =>
    contracts
      .filter((c) => c.type === type)
      .map(toRow)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, count);

  return { calls: bySide("call"), puts: bySide("put") };
}
