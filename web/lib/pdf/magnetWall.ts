// "Contratos vecinos 2.0" — combina el IMÁN del GEX (dirección) con el net
// premium real de MarketSnack en un vecindario ancho (10 strikes por lado del
// spot) para dar targets hacia el imán + targets de ruptura en contra, cada
// uno con una probabilidad de toque — 4 targets por lado (pedido explícito
//, ago 2026). "Hacia el imán" son 3 strikes vecinos confirmados +
// el imán mismo como 4to; "ruptura" son los 4 strikes confirmados del lado
// contrario.
//
// Reglas de clasificación por contrato en cada strike (dadas por el usuario):
//  - netPremium(call) > 0 → ejecutado en el ASK → compra agresiva de calls → direccional ALCISTA
//  - netPremium(put)  > 0 → ejecutado en el ASK → compra agresiva de puts  → direccional BAJISTA
//  - netPremium(call) < 0 → ejecutado en el BID → venta de calls → RESISTENCIA (probable techo)
//  - netPremium(put)  < 0 → ejecutado en el BID → venta de puts  → SOPORTE/HEDGE (probable rebote)
//
// La dirección la fija el imán del GEX (`lib/zerodte.ts` → `zeroDteGex`, con
// griegos reales de tastytrade — no estimados por Black-Scholes). Este módulo
// es PURO: no toca red ni disco, solo combina lo que ya trajeron las rutas.

import { candidateStrikesForSide } from "./backtest";
import { probTouch } from "./expectedMove";
import {
  biggestWallAmong, profitSideOf, WALL_NEIGHBOR_COUNT,
  type StrikePremiums, type WallLevel, type WallTarget,
} from "./neighborContracts";

/** "Al menos 10 contratos arriba y abajo" — pedido explícito. */
export const MAGNET_WALL_NEIGHBOR_COUNT = 10;

/**
 * "Lateral" ya NO se mide en % del spot (pedido explícito, ago
 * 2026: un umbral de 0.2% descartaba como "ruido" un imán a 3 puntos de
 * distancia — en opciones, con el apalancamiento del strike, esos 3 puntos
 * pueden valer mucho dinero). Se mide contra la GRILLA REAL de strikes: solo
 * es lateral si el imán cae en el mismo strike que el precio actual (o no hay
 * imán) — cualquier strike distinto ya es una dirección real y operable.
 */
export function strikeStep(strikes: number[]): number {
  const uniq = [...new Set(strikes)].sort((a, b) => a - b);
  const gaps = uniq.slice(1).map((s, i) => s - uniq[i]).filter((g) => g > 0);
  if (gaps.length === 0) return 5; // sin datos suficientes: fallback al paso típico de SPX 0DTE
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]; // mediana — no se deja arrastrar por un hueco raro
}

/** Probabilidad nunca se muestra como 0% o 100% — sigue la convención del resto del agente de no afirmar certezas. */
const MIN_PROB = 0.03;
const MAX_PROB = 0.95;

/** Los targets de RUPTURA (contra el imán) llevan un castigo adicional: van contra el régimen que ancla el GEX. */
const COUNTER_DISCOUNT = 0.65;

/**
 * Con γ NEGATIVA los dealers amplifican el movimiento en vez de anclarlo — la
 * tesis "el precio gravita al imán" es empíricamente más débil ahí (mismo
 * principio que ya usa `closingForecast`, lib/zerodte.ts: confianza "baja"
 * fuera de γ positiva). Antes esto no se usaba acá — pedido explícito de
 * el usuario ("cómo podríamos mejorar esto... para tener menos probabilidades de
 * un trader perdedor"). Solo pega en los targets HACIA el imán — con γ
 * negativa, un movimiento en CONTRA del imán (ruptura) es, si acaso, más
 * plausible, no menos, así que ese lado no se toca.
 */
const REGIME_DISCOUNT = 0.75;

/**
 * Cuando el mercado de acciones/índice está abierto, MarketSnack SÍ cubre el
 * índice hermano de ES/NQ (SPX/NDX) aunque no cubra CME directo — pedido
 * explícito: "cuando abre el mercado combina MarketSnack y
 * tastytrade para futuros, para mayor precisión". `crossMarketFlow` es esa
 * confirmación: si el flujo real de SPX/NDX COINCIDE con la dirección del
 * imán y no había otra confirmación, sube a "entrar" con un boost moderado
 * (no tan fuerte como una pared confirmada en el propio instrumento). Si
 * CONTRADICE la dirección, es una alerta real — se descuenta.
 */
const CROSS_MARKET_BOOST = 1.15;
const CROSS_MARKET_CONFLICT_DISCOUNT = 0.6;

/** 4 targets por lado (pedido explícito): 3 strikes vecinos confirmados + el imán mismo como el 4to. */
const MAX_STEP_TARGETS = 3;
/** 4 targets de ruptura del lado contrario — sin imán ahí, así que son los 4 directos. */
const MAX_BREAKOUT_TARGETS = 4;

/**
 * Solo cuenta como "pared" real el top 30% de gamma del propio vecindario —
 * mismo principio que `lib/levels.ts` (percentil 70 de OI para no llenar la
 * lista de ruido). Hace falta acá porque, a diferencia del net premium (que
 * es $0 cuando de verdad no hubo operaciones), el Open Interest real casi
 * nunca es exactamente cero — sin este filtro, CUALQUIER strike vecino
 * "confirmaba" algo aunque fuera ruido chico. Pedido explícito.
 */
export const POSITIONING_WALL_PERCENTILE = 0.7;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function clampProb(n: number): number {
  return Math.min(MAX_PROB, Math.max(MIN_PROB, n));
}

/** Valor en el percentil `p` (0-1) de una lista — interpolación simple por índice, alcanza para un umbral de ruido. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

/**
 * Probabilidad de toque: parte de la estadística pura (`probTouch`, distancia
 * + IV + tiempo) y la ajusta según qué tan agresivo fue el flujo real en ese
 * strike (0-1, normalizado dentro del propio vecindario) — pedido explícito
 * ("puedes guiarte con la agresividad de los contratos"). Un target
 * de RUPTURA (contra el imán) lleva además el castigo `COUNTER_DISCOUNT`: es
 * el escenario que va contra el régimen que ancla el GEX, no solo contra la
 * distancia. Un target HACIA el imán con `regimeReliable: false` (γ negativa)
 * lleva el castigo `REGIME_DISCOUNT` — la tesis de anclaje es menos fiable
 * ahí. Los dos castigos son mutuamente excluyentes (un target es hacia el
 * imán O de ruptura, nunca ambos).
 */
export function targetProbability(
  baseTouch: number,
  aggressiveness01: number,
  isCounterMove: boolean,
  regimeReliable: boolean = true,
): number {
  const boosted = baseTouch * (0.7 + 0.6 * clamp01(aggressiveness01));
  if (isCounterMove) return clampProb(boosted * COUNTER_DISCOUNT);
  if (!regimeReliable) return clampProb(boosted * REGIME_DISCOUNT);
  return clampProb(boosted);
}

export interface MagnetLevel {
  strike: number;
  callNet: number;
  putNet: number;
  callSignal: "bullish" | "resistance" | "none";
  putSignal: "bearish" | "support" | "none";
  /** + = presión alcista neta en este strike, − = presión bajista neta. */
  netBias: number;
  /** "flow" = net premium real de MarketSnack; "positioning" = Open Interest × gamma real (sin flujo, ver classifyPositioning). */
  source: "flow" | "positioning";
}

/** Clasifica un strike según las 4 reglas y resume en un único sesgo direccional. */
export function classifyLevel(strike: number, sp: StrikePremiums | null): MagnetLevel {
  const callNet = sp?.call?.netPremium ?? 0;
  const putNet = sp?.put?.netPremium ?? 0;
  const callSignal: MagnetLevel["callSignal"] = callNet > 0 ? "bullish" : callNet < 0 ? "resistance" : "none";
  const putSignal: MagnetLevel["putSignal"] = putNet > 0 ? "bearish" : putNet < 0 ? "support" : "none";
  // Compra de calls Y venta de puts (soporte) son ambas alcistas; compra de
  // puts Y venta de calls (resistencia) son ambas bajistas — se combinan en
  // un solo sesgo neto por strike en vez de exigir que ambos lados coincidan.
  const bullishForce = Math.max(callNet, 0) + Math.max(0, -putNet);
  const bearishForce = Math.max(putNet, 0) + Math.max(0, -callNet);
  return { strike, callNet, putNet, callSignal, putSignal, netBias: bullishForce - bearishForce, source: "flow" };
}

export interface PositioningLevel {
  strike: number;
  /** Gamma exposure real (OI × gamma real de tastytrade) del lado calls en este strike, ≥0. */
  callGex: number;
  /** Ídem puts, ≥0. */
  putGex: number;
}

/**
 * Clasifica un strike por POSICIONAMIENTO real (Open Interest × gamma real de
 * tastytrade) en vez de flujo ejecutado — para productos sin cobertura de
 * MarketSnack (ej. futuros ES/NQ, pedido explícito: "ahí puedes
 * usar la data de tastytrade... para poder ver los targets"). Misma
 * convención de dominio que el resto del agente (ver tabla de
 * Interpretación de flujo en CLAUDE.md): mucho OI/gamma en CALLS por encima
 * del spot funciona como RESISTENCIA (los dealers cortos en gamma venden el
 * subyacente al acercarse, frenando la subida); mucho OI/gamma en PUTS por
 * debajo funciona como SOPORTE. No hay lectura "alcista"/"bajista" agresiva
 * posible acá (eso requiere saber si el flujo fue de compra o venta, que
 * MarketSnack no da para CME) — solo techo/piso estructural.
 *
 * `minMagnitude` (default 0) es el piso de ruido: solo cuenta como pared real
 * la gamma que lo supera — ver `POSITIONING_WALL_PERCENTILE`. Sin piso,
 * cualquier strike con Open Interest (casi todos) "confirmaría" algo.
 */
export function classifyPositioning(strike: number, level: PositioningLevel | null, minMagnitude = 0): MagnetLevel {
  const callGex = level?.callGex ?? 0;
  const putGex = level?.putGex ?? 0;
  const callSignal: MagnetLevel["callSignal"] = callGex > minMagnitude ? "resistance" : "none";
  const putSignal: MagnetLevel["putSignal"] = putGex > minMagnitude ? "support" : "none";
  const netCall = callSignal === "resistance" ? callGex : 0;
  const netPut = putSignal === "support" ? putGex : 0;
  return { strike, callNet: -netCall, putNet: -netPut, callSignal, putSignal, netBias: netPut - netCall, source: "positioning" };
}

// No extiende WallEntrySignal a propósito: acá target1 puede ser `null`
// (pedido explícito — ver más abajo, los targets NUNCA pueden ser
// el mismo strike que resistencia/soporte), cosa que WallEntrySignal no
// permite (ese contrato es de la pared de flujo real, ya validada en
// producción — no se toca).
export interface PositioningWallEntrySignal {
  type: "call" | "put";
  wallStrike: number;
  wallMagnitude: number;
  resistance: WallTarget | null;
  support: WallTarget | null;
  target1: WallTarget | null;
  target2: WallTarget | null;
  levels: WallLevel[];
  reason: string;
  /** Marca que esta "Mejor entrada" salió de Open Interest × gamma real (sin flujo de MarketSnack), no de net premium ejecutado — para que la UI aclare que es estructura, no compra/venta confirmada. */
  source: "positioning";
}

/**
 * "Mejor entrada" para productos SIN cobertura de MarketSnack (ES/NQ, CME) —
 * pedido explícito: "en futuros ES y NQ puedes usar tastytrade y
 * darme la mejor entrada, según la información dada". Mismo concepto que
 * `wallEntrySignal` (lib/neighborContracts.ts, "SPX vecinos"): la pared de
 * dinero más fuerte del vecindario fija la dirección, independiente de dónde
 * esté el imán del GEX. Acá "pared" es Open Interest × gamma real de
 * tastytrade (`PositioningLevel`, los mismos nodos que ya calcula
 * `zeroDteGex`) en vez de net premium ejecutado — mismo convenio de signo que
 * ya usa `classifyPositioning`/`magnetWallSignal` para el respaldo de ES/NQ
 * del panel del imán: más Open Interest de PUTS que de CALLS en un strike =
 * soporte estructural = sesgo alcista (CALL); más Open Interest de CALLS que
 * de PUTS = resistencia estructural = sesgo bajista (PUT). Mismo piso de
 * ruido por percentil que ya usa esa ruta (`POSITIONING_WALL_PERCENTILE`) —
 * sin él, cualquier strike con algo de Open Interest (casi todos) "confirma".
 *
 * NO reusa `wallGeometryFromLevels` para los targets (a diferencia de la
 * pared de flujo real) — bug real encontrado en vivo (reportado por el usuario:
 * "COMPRÁ CALL $7750" con el precio en $7774, target por DEBAJO del spot). La
 * caminata de `wallEntrySignal` confirma targets por MISMO SIGNO que la pared
 * (tiene sentido con flujo: más compra agresiva del mismo lado más lejos =
 * momentum). Con posicionamiento no hay compra/venta — un chain normal SIEMPRE
 * tiene más gamma de calls arriba del spot y de puts abajo, así que ese mismo
 * chequeo casi nunca encuentra confirmación en el lado de la ganancia, y caía
 * al respaldo de usar la pared misma como target — que puede estar del lado
 * CONTRARIO al de la ganancia (el soporte que arma la tesis alcista, por
 * definición, queda abajo del spot). Acá el target es la PRÓXIMA pared real
 * (de cualquier lado — call o put, lo que importa es que haya fricción real
 * ahí) caminando en el lado de la ganancia — nunca puede salir del lado
 * contrario al spot.
 */
export function wallEntrySignalFromPositioning(input: {
  strikes: number[];
  spot: number;
  positioningLevels: Map<number, PositioningLevel>;
  count?: number;
}): PositioningWallEntrySignal | null {
  const { strikes, spot, positioningLevels } = input;
  const count = input.count ?? WALL_NEIGHBOR_COUNT;
  if (strikes.length === 0) return null;

  const above = candidateStrikesForSide(strikes, spot, "above", count);
  const below = candidateStrikesForSide(strikes, spot, "below", count);
  const neighborhood = [...new Set([...above, ...below])];
  if (neighborhood.length === 0) return null;

  const magnitudes = neighborhood
    .map((s) => positioningLevels.get(s))
    .filter((p): p is PositioningLevel => p != null)
    .flatMap((p) => [p.callGex, p.putGex])
    .filter((v) => v > 0);
  const threshold = percentile(magnitudes, POSITIONING_WALL_PERCENTILE);

  const levels: WallLevel[] = neighborhood.map((strike) => {
    const level = positioningLevels.get(strike) ?? null;
    const callGex = (level?.callGex ?? 0) > threshold ? level!.callGex : 0;
    const putGex = (level?.putGex ?? 0) > threshold ? level!.putGex : 0;
    // Mismo convenio de signo que classifyPositioning: callNet/putNet negativos
    // (como si fueran "venta") porque OI no dice compra/venta real, solo pared
    // estructural. `imbalance = putGex - callGex` > 0 → soporte de puts domina → alcista.
    return { strike, callNet: -callGex, putNet: -putGex, imbalance: putGex - callGex };
  });

  let wall = levels[0];
  for (const l of levels) if (Math.abs(l.imbalance) > Math.abs(wall.imbalance)) wall = l;
  if (wall.imbalance === 0) return null;
  const type: "call" | "put" = wall.imbalance > 0 ? "call" : "put";

  const strictlyAbove = neighborhood.filter((s) => s > spot).sort((a, b) => a - b);
  const strictlyBelow = neighborhood.filter((s) => s < spot).sort((a, b) => b - a);
  const resistance = biggestWallAmong(strictlyAbove, levels);
  const support = biggestWallAmong(strictlyBelow, levels);

  const profitSide = profitSideOf(type);
  const sideStrikesOutward = profitSide === "above" ? strictlyAbove : strictlyBelow;
  // El strike de resistencia/soporte NUNCA puede ser también un target —
  // pedido explícito ("no quiero que los targets sean los soportes
  // y resistencias... quiero que los targets estén entre ellos"). Se excluye
  // de la caminata: solo cuenta una pared REALMENTE intermedia, entre el spot
  // y esa frontera.
  const boundaryStrike = profitSide === "above" ? resistance?.strike : support?.strike;
  const checkpoints: WallLevel[] = [];
  for (const strike of sideStrikesOutward) {
    if (strike === boundaryStrike) continue;
    const l = levels.find((x) => x.strike === strike);
    if (!l || l.imbalance === 0) continue; // sin pared real ahí (por debajo del piso de ruido)
    checkpoints.push(l);
    if (checkpoints.length >= 2) break;
  }

  // Sin pared intermedia real, `null` — mejor decir "sin target confirmado"
  // que reusar resistencia/soporte como si fuera otra cosa (eso es justo lo
  // que se pidió sacar).
  const target1: WallTarget | null = checkpoints[0]
    ? { strike: checkpoints[0].strike, netPremium: Math.abs(checkpoints[0].imbalance) }
    : null;
  const target2: WallTarget | null = checkpoints[1]
    ? { strike: checkpoints[1].strike, netPremium: Math.abs(checkpoints[1].imbalance) }
    : null;

  const wallLabel = type === "call" ? "Open Interest de puts (soporte)" : "Open Interest de calls (resistencia)";
  const reason =
    `La pared de posicionamiento (Open Interest × gamma real de tastytrade) más fuerte del vecindario está en ` +
    `$${wall.strike} (${wallLabel}, gamma $${Math.abs(wall.imbalance).toFixed(0)}). ` +
    (target1
      ? `Próxima pared real camino a la ganancia: $${target1.strike} (gamma $${target1.netPremium.toFixed(0)})` +
        (target2 ? `, y más allá $${target2.strike} (gamma $${target2.netPremium.toFixed(0)}).` : ".")
      : "Sin ninguna pared real entre el spot y ese nivel — no hay target intermedio confirmado todavía.") +
    ` Sin flujo real de MarketSnack en CME — esto es estructura de Open Interest, no compra/venta confirmada.`;

  return {
    type, wallStrike: wall.strike, wallMagnitude: Math.abs(wall.imbalance),
    resistance, support, target1, target2, levels, reason,
    source: "positioning",
  };
}

function reasonFor(lvl: MagnetLevel, dir: "call" | "put"): string {
  if (lvl.source === "positioning") {
    if (dir === "call" && lvl.putSignal === "support") {
      return `Open Interest real de puts en $${lvl.strike} — soporte estructural (gamma $${Math.abs(lvl.putNet).toFixed(0)})`;
    }
    if (dir === "put" && lvl.callSignal === "resistance") {
      return `Open Interest real de calls en $${lvl.strike} — resistencia estructural (gamma $${Math.abs(lvl.callNet).toFixed(0)})`;
    }
    return `strike vecino en $${lvl.strike}`;
  }
  if (dir === "call") {
    if (lvl.callSignal === "bullish") {
      return `compra agresiva de calls en $${lvl.strike} (net premium $${lvl.callNet.toFixed(0)})`;
    }
    if (lvl.putSignal === "support") {
      return `venta de puts en $${lvl.strike} — soporte (net premium $${lvl.putNet.toFixed(0)})`;
    }
  } else {
    if (lvl.putSignal === "bearish") {
      return `compra agresiva de puts en $${lvl.strike} (net premium $${lvl.putNet.toFixed(0)})`;
    }
    if (lvl.callSignal === "resistance") {
      return `venta de calls en $${lvl.strike} — resistencia (net premium $${lvl.callNet.toFixed(0)})`;
    }
  }
  return `strike vecino en $${lvl.strike}`;
}

export type TradeAdvice = "entrar" | "esperar_breakout" | "lateral";

export interface MagnetTarget {
  strike: number;
  /** Magnitud (en $) del net premium que respalda este target — 0 para el imán mismo. */
  netPremium: number;
  probability: number;
  reason: string;
}

export interface MagnetWallSignal {
  type: "call" | "put" | null;
  spot: number;
  magnetStrike: number | null;
  magnetProbability: number;
  /** Hacia el imán: hasta 3 strikes vecinos que confirman + el imán como 4to y último target. */
  towardTargets: MagnetTarget[];
  /** Ruptura / contra el imán: hasta 4 strikes vecinos del lado opuesto. */
  breakoutTargets: MagnetTarget[];
  advice: TradeAdvice;
  levels: MagnetLevel[];
  reason: string;
  /** Régimen de gamma que se usó para descontar (o no) los targets hacia el imán. `null` si no se pasó. */
  regime: "positive" | "negative" | null;
  /** Confirmación cruzada del índice hermano (SPX/NDX) que se usó, si la hubo. `null` si no se pasó o no aplicó. */
  crossMarketFlow: CrossMarketFlow | null;
}

export interface CrossMarketFlow {
  direction: "call" | "put";
  /** Ticker del índice hermano cuyo flujo real de MarketSnack se usó (ej. "SPX" para /ES). */
  underlying: string;
}

export interface MagnetWallInput {
  spot: number;
  /** Todos los strikes del vencimiento (para armar el vecindario y caminar hacia el imán). */
  strikes: number[];
  /** Net premium de MarketSnack por strike — solo hace falta cubrir el vecindario. */
  strikePremiums: Map<number, StrikePremiums>;
  /**
   * Respaldo de POSICIONAMIENTO (Open Interest × gamma real de tastytrade)
   * por strike, para cuando `strikePremiums` no tiene datos ahí — solo se usa
   * en los strikes donde el flujo no dio señal (netBias 0), nunca pisa una
   * lectura de flujo real que sí exista. Pensado para `hasFlowCoverage: false`.
   */
  positioningLevels?: Map<number, PositioningLevel>;
  /** kingStrike del GEX (lib/zerodte.ts → zeroDteGex, griegos reales de tastytrade). */
  magnetStrike: number | null;
  /** Concentración del nodo imán (0-1) — qué tan dominante es frente al resto de la cadena. */
  magnetConcentration: number;
  iv: number;
  /** Horizonte hasta el cierre, en fracción de día (horas/24). */
  daysToClose: number;
  /** `false` para productos sin cobertura de MarketSnack (ej. futuros ES/NQ — CME no está cubierto). Default `true`. */
  hasFlowCoverage?: boolean;
  /** Régimen de gamma (lib/zerodte.ts → zeroDteGex / lib/gex.ts → gexAnalysis). Con "negative" se descuentan los targets hacia el imán — ver REGIME_DISCOUNT. */
  regime?: "positive" | "negative";
  /** Confirmación cruzada del índice hermano (SPX/NDX) — ver CrossMarketFlow. Solo tiene sentido con el mercado de acciones abierto. */
  crossMarketFlow?: CrossMarketFlow | null;
  count?: number;
}

function directionFromMagnet(spot: number, magnetStrike: number | null, halfStep: number): "call" | "put" | null {
  if (magnetStrike == null || !(spot > 0)) return null;
  const dist = magnetStrike - spot;
  if (Math.abs(dist) <= halfStep) return null; // mismo strike que el spot: sin dirección real
  return dist > 0 ? "call" : "put";
}

/**
 * Señal combinada imán + contratos vecinos. `null` solo sin spot o sin
 * strikes (sin datos). Con imán pegado al spot o ausente, devuelve `advice:
 * "lateral"` (no `null`) — la UI necesita el mensaje de "no operar ahora".
 */
export function magnetWallSignal(input: MagnetWallInput): MagnetWallSignal | null {
  const { spot, strikes, strikePremiums, magnetStrike, magnetConcentration, iv, daysToClose } = input;
  const hasFlowCoverage = input.hasFlowCoverage ?? true;
  const regime = input.regime ?? null;
  const regimeReliable = regime !== "negative";
  const count = input.count ?? MAGNET_WALL_NEIGHBOR_COUNT;
  if (!(spot > 0) || strikes.length === 0) return null;

  const above = candidateStrikesForSide(strikes, spot, "above", count);
  const below = candidateStrikesForSide(strikes, spot, "below", count);
  const neighborhood = [...new Set([...above, ...below])];

  // Umbral de "pared real" para el posicionamiento: el Open Interest casi
  // nunca es exactamente cero, así que sin este piso cualquier strike vecino
  // "confirmaría" algo — ver POSITIONING_WALL_PERCENTILE.
  const positioningMagnitudes = neighborhood
    .map((s) => input.positioningLevels?.get(s))
    .filter((p): p is PositioningLevel => p != null)
    .flatMap((p) => [p.callGex, p.putGex])
    .filter((v) => v > 0);
  const positioningThreshold = percentile(positioningMagnitudes, POSITIONING_WALL_PERCENTILE);

  const levels = neighborhood.map((s) => {
    const flowLevel = classifyLevel(s, strikePremiums.get(s) ?? null);
    if (flowLevel.netBias !== 0) return flowLevel; // el flujo real manda cuando existe
    const positioning = input.positioningLevels?.get(s);
    return positioning ? classifyPositioning(s, positioning, positioningThreshold) : flowLevel;
  });
  const levelByStrike = new Map(levels.map((l) => [l.strike, l] as const));
  const maxAbsBias = Math.max(...levels.map((l) => Math.abs(l.netBias)), 0);

  const halfStep = strikeStep(strikes) / 2;
  const direction = directionFromMagnet(spot, magnetStrike, halfStep);

  if (direction == null) {
    const reason =
      magnetStrike == null
        ? "Sin imán claro del GEX todavía — sin dirección definida, no operar."
        : `El imán ($${magnetStrike}) cae en el mismo strike que el precio actual ($${spot.toFixed(2)}) — sin ` +
          `dirección real todavía. No hacer entradas ahora; esperar a que el imán se despegue a otro strike o a una ruptura confirmada.`;
    return {
      type: null, spot, magnetStrike, magnetProbability: 0,
      towardTargets: [], breakoutTargets: [], advice: "lateral", levels, reason, regime,
      crossMarketFlow: input.crossMarketFlow ?? null,
    };
  }

  const towardSide = direction === "call" ? "above" : "below";
  const breakoutSide = towardSide === "above" ? "below" : "above";
  const confirmSign = direction === "call" ? 1 : -1;

  const crossMarketFlow = input.crossMarketFlow ?? null;
  const crossMarketAgrees = crossMarketFlow != null && crossMarketFlow.direction === direction;
  const crossMarketConflicts = crossMarketFlow != null && crossMarketFlow.direction !== direction;
  const applyConflict = (p: number) => (crossMarketConflicts ? clampProb(p * CROSS_MARKET_CONFLICT_DISCOUNT) : p);

  const orderOutward = (side: "above" | "below") =>
    strikes
      .filter((s) => (side === "above" ? s > spot : s < spot))
      .sort((a, b) => (side === "above" ? a - b : b - a));

  const towardSteps: MagnetTarget[] = [];
  for (const s of orderOutward(towardSide)) {
    if (s === magnetStrike) continue; // el imán se agrega aparte, siempre al final
    const lvl = levelByStrike.get(s);
    if (!lvl || Math.sign(lvl.netBias) !== confirmSign) continue;
    const aggressiveness = maxAbsBias > 0 ? Math.abs(lvl.netBias) / maxAbsBias : 0;
    towardSteps.push({
      strike: s,
      netPremium: Math.abs(lvl.netBias),
      probability: applyConflict(targetProbability(probTouch(spot, s, iv, daysToClose), aggressiveness, false, regimeReliable)),
      reason: reasonFor(lvl, direction),
    });
    if (towardSteps.length >= MAX_STEP_TARGETS) break;
  }

  let magnetProbability = targetProbability(
    probTouch(spot, magnetStrike!, iv, daysToClose),
    clamp01(magnetConcentration),
    false,
    regimeReliable,
  );
  if (crossMarketConflicts) magnetProbability = clampProb(magnetProbability * CROSS_MARKET_CONFLICT_DISCOUNT);
  // El boost de flujo cruzado solo tiene sentido cuando NO hay ninguna otra
  // confirmación en el propio instrumento — si ya hay una pared real, esa
  // manda y el cruzado se queda solo como una nota extra en el texto.
  else if (crossMarketAgrees && towardSteps.length === 0) magnetProbability = clampProb(magnetProbability * CROSS_MARKET_BOOST);

  const magnetTarget: MagnetTarget = {
    strike: magnetStrike!,
    netPremium: 0,
    probability: magnetProbability,
    reason: "imán del GEX (mayor concentración de gamma real) — el precio tiende a gravitar hacia acá",
  };
  const towardTargets = [...towardSteps, magnetTarget];

  const breakoutTargets: MagnetTarget[] = [];
  const counterDirection = direction === "call" ? "put" : "call";
  for (const s of orderOutward(breakoutSide)) {
    const lvl = levelByStrike.get(s);
    if (!lvl || Math.sign(lvl.netBias) !== -confirmSign) continue;
    const aggressiveness = maxAbsBias > 0 ? Math.abs(lvl.netBias) / maxAbsBias : 0;
    breakoutTargets.push({
      strike: s,
      netPremium: Math.abs(lvl.netBias),
      probability: targetProbability(probTouch(spot, s, iv, daysToClose), aggressiveness, true),
      reason: reasonFor(lvl, counterDirection),
    });
    if (breakoutTargets.length >= MAX_BREAKOUT_TARGETS) break;
  }

  const advice: TradeAdvice = towardSteps.length > 0 || crossMarketAgrees ? "entrar" : "esperar_breakout";
  const sideWord = direction === "call" ? "CALL" : "PUT";
  const confirmedByPositioning = towardSteps.some((t) => levelByStrike.get(t.strike)?.source === "positioning");
  const confirmationWord = confirmedByPositioning
    ? "posicionamiento real (Open Interest × gamma de tastytrade, sin flujo — MarketSnack no cubre este producto)"
    : "net premium real";
  const regimeCaveat = !regimeReliable
    ? " ⚠ γ negativa: los dealers amplifican el movimiento en vez de anclarlo al imán — la tesis de acá es menos " +
      "fiable que con γ positiva, las probabilidades hacia el imán ya vienen descontadas por eso."
    : "";
  const crossMarketNote = crossMarketFlow
    ? crossMarketAgrees
      ? ` Confirmado además por el flujo real de ${crossMarketFlow.underlying} (mercado de acciones abierto) — mismo sesgo ${sideWord}.`
      : ` ⚠ El flujo real de ${crossMarketFlow.underlying} apunta al lado CONTRARIO (mercado de acciones abierto) — señal en conflicto, ya descontada.`
    : "";
  const reason =
    advice === "entrar"
      ? towardSteps.length > 0
        ? `Imán en $${magnetStrike} (${direction === "call" ? "arriba" : "abajo"} del spot $${spot.toFixed(2)}) — ` +
          `sesgo ${sideWord}, confirmado por ${confirmationWord} en ${towardSteps.length} strike(s) vecino(s) en el camino.` +
          regimeCaveat + crossMarketNote
        : `Imán en $${magnetStrike} (${direction === "call" ? "arriba" : "abajo"} del spot $${spot.toFixed(2)}) — ` +
          `sesgo ${sideWord}. Sin pared propia en el vecindario, pero el flujo real de ${crossMarketFlow?.underlying} ` +
          `confirma la misma dirección (mercado de acciones abierto) — entrada posible, aunque con menos respaldo ` +
          `que una pared confirmada en el propio instrumento.` + regimeCaveat
      : !hasFlowCoverage
        ? `Sin datos de flujo real para este producto (MarketSnack no cubre CME) — la dirección sale solo del imán ` +
          `del GEX, sin confirmar por net premium. El imán en $${magnetStrike} (sesgo ${sideWord}) es una posible ` +
          `entrada, pero tratala como sin confirmar, no como una señal fuerte.` + crossMarketNote
        : `El GEX apunta a $${magnetStrike} (sesgo ${sideWord}) pero el net premium de hoy todavía no confirma ningún ` +
          `strike vecino en el camino — mejor esperar a que el flujo confirme (o a un cambio de tendencia) antes de entrar.` +
          crossMarketNote;

  return {
    type: direction, spot, magnetStrike, magnetProbability: magnetTarget.probability,
    towardTargets, breakoutTargets, advice, levels, reason, regime, crossMarketFlow,
  };
}
