// Contratos vecinos — reemplaza el ladder de volumen≥N×OI por comparar el NET
// PREMIUM real (ask_premium - bid_premium, sumado en la sesión de hoy) de call
// vs put en cada strike vecino real, caminando desde el strike más cercano al
// spot hacia afuera. Mientras el mismo lado siga dominando, el precio "tiene
// espacio" para llegar ahí; el primer strike donde domina el lado contrario es
// el soporte/resistencia real — ahí se frena, no sigue. PURO — el fetch a
// MarketSnack (trade_summaries por contrato) vive en lib/marketsnack.ts.
//
// Ejemplo real que dio el usuario (2026-07-30): SPX en 7428, strikes vecinos
// 7410/7415/7420/7425/7430/7435/7440. Si en 7420 dominan los puts, el precio
// probablemente llega a 7420; si en 7420 ya dominan los calls, probablemente
// se frena antes, en 7425.

import type { Row } from "./types";
import { candidateStrikesForSide, closestStrike } from "./backtest";
import { buildOccSymbol, daysToExpiration, resolveOccRoot } from "./occ";

// Strike más cercano al spot + 3 vecinos por lado (7 strikes reales totales)
// — mismo tamaño que el ejemplo (7410..7440 alrededor de 7428).
export const NEIGHBOR_WALK_COUNT = 4;

export interface TradeSummaryBucket {
  t: string;
  ask_volume: number;
  bid_volume: number;
  mid_volume: number;
  ask_premium: number;
  bid_premium: number;
  mid_premium: number;
  single_leg_premium: number;
  multi_leg_premium: number;
  other_premium: number;
}

export interface ContractPremiumSummary {
  netPremium: number; // sum(ask_premium) - sum(bid_premium)
  askPremium: number;
  bidPremium: number;
  askVolume: number; // señal secundaria de agresión (bid vs ask) que pidió el usuario
  bidVolume: number;
}

/** Reduce los buckets de 5 min de `trade_summaries` a un único net premium
 *  por contrato — mismo cálculo que el widget "Net Premium" de MarketSnack
 *  (verificado en vivo: coincide al dólar). El mid queda afuera a propósito. */
export function summarizeTradeBuckets(buckets: TradeSummaryBucket[]): ContractPremiumSummary {
  let askPremium = 0;
  let bidPremium = 0;
  let askVolume = 0;
  let bidVolume = 0;
  for (const b of buckets) {
    askPremium += b.ask_premium;
    bidPremium += b.bid_premium;
    askVolume += b.ask_volume;
    bidVolume += b.bid_volume;
  }
  return { netPremium: askPremium - bidPremium, askPremium, bidPremium, askVolume, bidVolume };
}

export interface StrikePremiums {
  strike: number;
  call: ContractPremiumSummary | null; // null = sin contrato real en ese strike o sin trades hoy
  put: ContractPremiumSummary | null;
}

export type DominantSide = "call" | "put" | "tie";

/** Quién domina en un strike: mayor net premium gana. "tie" solo con
 *  igualdad exacta (incluye ambos lados en null/0) — sin piso arbitrario de
 *  dólares, comparación directa tal como lo describió el usuario. */
export function dominantSideAt(level: StrikePremiums): DominantSide {
  const callNet = level.call?.netPremium ?? 0;
  const putNet = level.put?.netPremium ?? 0;
  if (callNet === putNet) return "tie";
  return callNet > putNet ? "call" : "put";
}

/** Dirección de ganancia de un tipo de contrato: arriba del strike para un
 *  call, abajo para un put — mismo lado que hoy que se camina la escalera. */
export function profitSideOf(type: "call" | "put"): "above" | "below" {
  return type === "call" ? "above" : "below";
}

export interface NeighborContractLevel {
  strike: number;
  dominant: DominantSide;
  call: ContractPremiumSummary | null;
  put: ContractPremiumSummary | null;
}

export interface NeighborWalkResult {
  side: "above" | "below";
  initialType: "call" | "put";
  /** Centro → afuera, hasta el strike de flip inclusive (o hasta agotar el tope). */
  levels: NeighborContractLevel[];
  /** Strike donde domina por primera vez el lado contrario. null = nunca volteó. */
  flipStrike: number | null;
}

/**
 * Primitivo compartido: dado un orden de strikes YA elegido (centro→afuera,
 * un solo lado), camina strike por strike mientras `initialType` siga
 * dominando; se detiene (incluyendo ese nivel en `levels`) en el primer
 * strike donde domina el lado contrario o hay empate.
 */
export function walkNeighborContracts(
  strikesInOrder: number[],
  strikePremiums: Map<number, StrikePremiums>,
  side: "above" | "below",
  initialType: "call" | "put",
): NeighborWalkResult {
  const levels: NeighborContractLevel[] = [];
  let flipStrike: number | null = null;
  for (const strike of strikesInOrder) {
    const level = strikePremiums.get(strike) ?? null;
    const dominant = level ? dominantSideAt(level) : "tie";
    levels.push({ strike, dominant, call: level?.call ?? null, put: level?.put ?? null });
    if (dominant !== initialType) {
      flipStrike = strike;
      break;
    }
  }
  return { side, initialType, levels, flipStrike };
}

/** El último strike (centro→afuera) donde todavía domina `initialType`, antes
 *  del flip — ese es el nivel real al que el precio "tiene espacio" de llegar. */
function lastConfirmingStrike(walk: NeighborWalkResult, center: number): number {
  const confirming = walk.flipStrike != null ? walk.levels.slice(0, -1) : walk.levels;
  return confirming[confirming.length - 1]?.strike ?? center;
}

export interface NeighborEntrySignal {
  type: "call" | "put";
  side: "above" | "below";
  flipStrike: number | null;
  target: number;
  levels: NeighborContractLevel[];
  reason: string;
  reversalWarning: string | null;
}

/**
 * Caso 1 — dirección auto-detectada desde el strike más cercano al spot: mira
 * quién domina ahí (calls → sesgo alcista, puts → bajista) y camina en esa
 * dirección hasta el flip. `null` si el strike central empata (misma regla
 * "ante la duda, no operar" del resto del agente).
 */
export function neighborContractsEntrySignal(input: {
  strikes: number[];
  spot: number;
  strikePremiums: Map<number, StrikePremiums>;
  count?: number;
}): NeighborEntrySignal | null {
  const { strikes, spot, strikePremiums } = input;
  const count = input.count ?? NEIGHBOR_WALK_COUNT;
  if (strikes.length === 0) return null;

  const center = closestStrike(strikes, spot);
  const centerLevel = strikePremiums.get(center) ?? null;
  const dominant = centerLevel ? dominantSideAt(centerLevel) : "tie";
  if (dominant === "tie") return null;

  const type = dominant;
  const side = profitSideOf(type);
  const strikesInOrder = candidateStrikesForSide(strikes, spot, side, count);
  const walk = walkNeighborContracts(strikesInOrder, strikePremiums, side, type);
  const target = lastConfirmingStrike(walk, center);
  const sideWord = type === "call" ? "calls" : "puts";

  let reason: string;
  let reversalWarning: string | null = null;
  if (walk.flipStrike != null) {
    reason =
      `Net premium real de ${sideWord} domina desde $${center} hasta $${target} — en $${walk.flipStrike} ` +
      `se invierte hacia el lado contrario: ahí está la resistencia real, probablemente no siga más allá.`;
    if (target === center) {
      reversalWarning = `Ojo: la reversión real está apenas un strike más allá ($${walk.flipStrike}) — muy poco recorrido.`;
    }
  } else {
    reason =
      `Net premium real de ${sideWord} domina en todos los strikes vecinos revisados (hasta $${target}) — ` +
      `sin señal de reversión todavía dentro del rango revisado.`;
  }

  return { type, side, flipStrike: walk.flipStrike, target, levels: walk.levels, reason, reversalWarning };
}

/**
 * Caso 2 — dirección ya conocida (posición abierta o candidato de Búsqueda de
 * contratos) desde un strike dado: camina el mismo recorrido pero sin decidir
 * el lado, ya viene dado por `type`.
 */
export function neighborContractsWalk(input: {
  centerStrike: number;
  type: "call" | "put";
  chainStrikes: number[];
  strikePremiums: Map<number, StrikePremiums>;
  count?: number;
}): NeighborWalkResult | null {
  const { centerStrike, type, chainStrikes, strikePremiums } = input;
  const count = input.count ?? NEIGHBOR_WALK_COUNT;
  const side = profitSideOf(type);
  const strikesInOrder = candidateStrikesForSide(chainStrikes, centerStrike, side, count);
  if (strikesInOrder.length === 0) return null;
  return walkNeighborContracts(strikesInOrder, strikePremiums, side, type);
}

/**
 * ¿El flujo de HOY en los strikes vecinos a una posición YA ABIERTA sigue
 * confirmando la misma dirección? Confirma salvo que la dominancia YA volteó
 * justo en el propio strike de la posición (el primer nivel del recorrido) —
 * reemplaza a la vieja `neighborFlowConfirms` (lib/dayTrade.ts).
 */
export function neighborContractsConfirmPosition(input: {
  position: { type: "call" | "put"; strike: number };
  chainStrikes: number[];
  strikePremiums: Map<number, StrikePremiums>;
  count?: number;
}): boolean {
  const walk = neighborContractsWalk({
    centerStrike: input.position.strike,
    type: input.position.type,
    chainStrikes: input.chainStrikes,
    strikePremiums: input.strikePremiums,
    count: input.count,
  });
  if (!walk || walk.levels.length === 0) return false;
  return walk.flipStrike !== walk.levels[0].strike;
}

// ── Señal por "pared" (magnitud de dinero, no solo quién domina localmente) ──
//
// Pedido explícito (2026-08-03), tras corregir a mano un backtest real:
// el walk de arriba (`neighborContractsEntrySignal`) solo mira quién gana en el
// strike CENTRO y camina hasta el primer volteo — nunca compara CUÁNTO dinero hay
// en juego entre strikes. Ejemplo real de ese backtest (SPX, 31-jul-2026, 09:45 ET,
// spot $7456.64): el centro ($7455) daba CALL por apenas +$60,824, mientras
// $7460 —un solo strike más allá— tenía +$471,794 en puts, casi 8x más grande.
// El walk vio "CALL gana en el centro" y operó CALL $7455 (perdió -10.2% en 5 min);
// mirando la MAGNITUD, la pared real estaba en el put de $7460, y el lado
// dominante del vecindario era bajista — confirmado por la operación siguiente
// (PUT $7440, +33.7%).
//
// `wallEntrySignal` busca la pared más grande (mayor |call−put| en dólares) en
// TODO el vecindario (no solo el centro), esa pared fija la dirección, y el
// target es el primer strike —caminando desde el spot hacia el lado de
// ganancia— que confirma esa misma dirección (mismo signo que la pared). PURO,
// sin fetch. Validado contra el walk de siempre sobre el mismo día real (SPX,
// viernes 31-jul-2026, 6 strikes por lado en vez de los 4 de NEIGHBOR_WALK_COUNT,
// 1 contrato por operación sin sizing): 27 operaciones (67% de aciertos, +$4,586)
// vs. 33 operaciones (58% de aciertos, +$2,656) del walk de dominancia local.

/** 6 strikes por lado a propósito (no 4, distinto de NEIGHBOR_WALK_COUNT): con
 *  pesos por magnitud hace falta mirar un vecindario más ancho para encontrar la
 *  pared real, no solo el primer volteo cerca del centro. */
export const WALL_NEIGHBOR_COUNT = 6;

export interface WallLevel {
  strike: number;
  callNet: number;
  putNet: number;
  /** callNet - putNet: el signo dice el lado, la magnitud dice qué tan fuerte. */
  imbalance: number;
}

/** Un nivel de precio con la plata real (en $) que lo respalda. */
export interface WallTarget {
  strike: number;
  netPremium: number;
}

export interface WallEntrySignal {
  type: "call" | "put";
  wallStrike: number;
  /** |imbalance| de la pared que decidió la dirección. */
  wallMagnitude: number;
  /** Pared más grande del lado de ARRIBA del vecindario — el techo. `null` sin datos de ese lado. */
  resistance: WallTarget | null;
  /** Pared más grande del lado de ABAJO del vecindario — el piso. `null` sin datos de ese lado. */
  support: WallTarget | null;
  /** Primer strike que confirma la dirección caminando desde el spot — el objetivo más cercano. */
  target1: WallTarget;
  /** Segundo strike que confirma, más allá del primero — a dónde puede seguir si rompe target1. `null` si no hay uno. */
  target2: WallTarget | null;
  levels: WallLevel[];
  reason: string;
}

export function biggestWallAmong(strikes: number[], levels: WallLevel[]): WallTarget | null {
  let best: WallLevel | null = null;
  for (const strike of strikes) {
    const l = levels.find((x) => x.strike === strike);
    if (!l || l.imbalance === 0) continue;
    if (!best || Math.abs(l.imbalance) > Math.abs(best.imbalance)) best = l;
  }
  return best ? { strike: best.strike, netPremium: Math.abs(best.imbalance) } : null;
}

export interface WallGeometry {
  type: "call" | "put";
  wallStrike: number;
  wallMagnitude: number;
  resistance: WallTarget | null;
  support: WallTarget | null;
  target1: WallTarget;
  target2: WallTarget | null;
}

/**
 * La parte PURAMENTE geométrica de `wallEntrySignal`: dada una lista de
 * `WallLevel` ya armada (de donde sea que salga el desbalance — net premium
 * real de MarketSnack, u Open Interest × gamma real para productos sin
 * cobertura de flujo como ES/NQ), encuentra la pared más grande, la dirección
 * que fija, y camina hacia afuera confirmando hasta 2 targets. Extraído para
 * que `wallEntrySignal` (flujo) y `wallEntrySignalFromPositioning` (posición,
 * lib/magnetWall.ts) compartan exactamente la misma lógica de caminata — solo
 * cambia CÓMO se arma `levels`, no qué se hace con ella. `null` sin
 * vecindario o si la pared más grande tiene desbalance $0 (sin datos).
 */
export function wallGeometryFromLevels(neighborhood: number[], spot: number, levels: WallLevel[]): WallGeometry | null {
  if (neighborhood.length === 0 || levels.length === 0) return null;

  let wall = levels[0];
  for (const l of levels) if (Math.abs(l.imbalance) > Math.abs(wall.imbalance)) wall = l;
  if (wall.imbalance === 0) return null;

  const type: "call" | "put" = wall.imbalance > 0 ? "call" : "put";
  const profitSide = profitSideOf(type);
  // `above`/`below` de candidateStrikesForSide son relativos al STRIKE MÁS
  // CERCANO, no al spot real: siempre incluyen ese strike central aunque quede
  // del lado contrario del spot (p. ej. spot $7666.86, strike más cercano
  // $7665 — sigue "abajo" del spot real). Para resistencia/soporte/targets
  // ("techo"/"piso"/"a dónde puede seguir") el lado SÍ importa de verdad: acá
  // se filtra contra el spot real para que nunca salga, p. ej., un target de
  // CALL por debajo del precio actual.
  const strictlyAbove = neighborhood.filter((s) => s > spot).sort((a, b) => a - b);
  const strictlyBelow = neighborhood.filter((s) => s < spot).sort((a, b) => b - a);
  const sideStrikesOutward = profitSide === "above" ? strictlyAbove : strictlyBelow;

  // Camina desde el spot hacia afuera juntando hasta 2 strikes que confirmen la
  // misma dirección — el primero es el objetivo más cercano, el segundo a dónde
  // puede seguir si el precio rompe el primero.
  const confirmed: WallLevel[] = [];
  for (const strike of sideStrikesOutward) {
    const l = levels.find((x) => x.strike === strike);
    if (!l) continue;
    const sameSign = type === "call" ? l.imbalance > 0 : l.imbalance < 0;
    if (sameSign) {
      confirmed.push(l);
      if (confirmed.length >= 2) break;
    }
  }
  // Respaldo: si nada confirma caminando hacia afuera, target1 es la pared misma.
  const target1: WallTarget = confirmed[0]
    ? { strike: confirmed[0].strike, netPremium: Math.abs(confirmed[0].imbalance) }
    : { strike: wall.strike, netPremium: Math.abs(wall.imbalance) };
  const target2: WallTarget | null = confirmed[1]
    ? { strike: confirmed[1].strike, netPremium: Math.abs(confirmed[1].imbalance) }
    : null;

  const resistance = biggestWallAmong(strictlyAbove, levels);
  const support = biggestWallAmong(strictlyBelow, levels);

  return {
    type, wallStrike: wall.strike, wallMagnitude: Math.abs(wall.imbalance),
    resistance, support, target1, target2,
  };
}

/**
 * Dirección y targets por la pared de dinero más grande del vecindario, no por
 * quién gana en el strike centro. `null` sin vecindario o si la pared más
 * grande tiene desbalance $0 (sin datos) — misma regla de "ante la duda, no
 * operar" que el resto del agente.
 */
export function wallEntrySignal(input: {
  strikes: number[];
  spot: number;
  strikePremiums: Map<number, StrikePremiums>;
  count?: number;
}): WallEntrySignal | null {
  const { strikes, spot, strikePremiums } = input;
  const count = input.count ?? WALL_NEIGHBOR_COUNT;
  if (strikes.length === 0) return null;

  const above = candidateStrikesForSide(strikes, spot, "above", count);
  const below = candidateStrikesForSide(strikes, spot, "below", count);
  const neighborhood = [...new Set([...above, ...below])];
  if (neighborhood.length === 0) return null;

  const levels: WallLevel[] = neighborhood.map((strike) => {
    const level = strikePremiums.get(strike) ?? null;
    const callNet = level?.call?.netPremium ?? 0;
    const putNet = level?.put?.netPremium ?? 0;
    return { strike, callNet, putNet, imbalance: callNet - putNet };
  });

  const geo = wallGeometryFromLevels(neighborhood, spot, levels);
  if (!geo) return null;
  const { type, wallStrike, wallMagnitude, resistance, support, target1, target2 } = geo;

  const sideWord = type === "call" ? "calls" : "puts";
  const sideLabel = type === "call" ? "call" : "put";
  const reason =
    `La pared más grande del vecindario está en $${wallStrike} (${sideLabel} domina con ` +
    `$${wallMagnitude.toFixed(0)} de desbalance real). Primer strike que confirma ${sideWord}: ` +
    `$${target1.strike} ($${target1.netPremium.toFixed(0)})` +
    (target2 ? `, y si rompe eso, el siguiente es $${target2.strike} ($${target2.netPremium.toFixed(0)}).` : ".");

  return {
    type, wallStrike, wallMagnitude,
    resistance, support, target1, target2, levels, reason,
  };
}

/** Para un strike, el símbolo OCC real de call/put con la expiración más
 *  próxima disponible entre las filas ya filtradas por el llamador (por DTE
 *  o por una expiración exacta). `null` si ese strike no tiene ese tipo. */
function nearestExpirationSymbol(
  rows: Row[],
  strike: number,
  type: "call" | "put",
  now: Date,
  fallbackTicker: string,
): string | null {
  const matches = rows.filter((r) => r.strike === strike && r.contractType === type);
  if (matches.length === 0) return null;
  const nearest = matches.reduce((best, r) =>
    daysToExpiration(r.expiration, now) < daysToExpiration(best.expiration, now) ? r : best,
  );
  const occRoot = resolveOccRoot(nearest.optionTicker, fallbackTicker);
  return buildOccSymbol({ underlying: occRoot, expiration: nearest.expiration, type, strike });
}

/** Resuelve, para cada strike, el símbolo OCC real de call y put. */
export function resolveStrikeContracts(
  strikes: number[],
  rows: Row[],
  now: Date,
  fallbackTicker: string,
): Map<number, { call: string | null; put: string | null }> {
  const out = new Map<number, { call: string | null; put: string | null }>();
  for (const strike of strikes) {
    out.set(strike, {
      call: nearestExpirationSymbol(rows, strike, "call", now, fallbackTicker),
      put: nearestExpirationSymbol(rows, strike, "put", now, fallbackTicker),
    });
  }
  return out;
}

/** Combina el mapa strike→símbolos con el mapa símbolo→net premium (ya
 *  fetcheado) en el shape que consume el resto de este módulo. */
export function toStrikePremiums(
  strikeContracts: Map<number, { call: string | null; put: string | null }>,
  premiumsBySymbol: Map<string, ContractPremiumSummary>,
): Map<number, StrikePremiums> {
  const out = new Map<number, StrikePremiums>();
  for (const [strike, { call, put }] of strikeContracts) {
    out.set(strike, {
      strike,
      call: call ? premiumsBySymbol.get(call) ?? null : null,
      put: put ? premiumsBySymbol.get(put) ?? null : null,
    });
  }
  return out;
}
