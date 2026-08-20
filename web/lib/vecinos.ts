// ============================================================================
// CONTRATOS VECINOS 2.0 — señal de entrada 0DTE que combina DOS fuentes:
//   (1) hacia dónde "gravita" el precio según el GEX real (el IMÁN), y
//   (2) si el dinero REAL ejecutado en los strikes vecinos confirma esa dirección.
//
// La dirección SIEMPRE la fija el imán del GEX; el flujo real solo CONFIRMA o no.
// Por eso hay tres desenlaces posibles y no dos: entrar, esperar_breakout y lateral.
//
// Datos que necesita (los sirve app/api/vecinos/route.ts):
//   · Cadena 0DTE con GRIEGOS REALES (gamma de MarketSnack, NO Black-Scholes) + OI.
//   · Net premium real ejecutado hoy por strike/tipo, distinguiendo la compra
//     agresiva (al ASK) de la venta agresiva (al BID) — no el volumen total.
//     Donde no hay flujo, se cae al respaldo estructural OI × gamma (Paso 2b).
//
// Todo aquí es PURO y testeable (tests en vecinos.test.ts). La I/O vive en la ruta.
// ============================================================================

import type { Chain2Contract } from "./optionChain2";
import { gexByStrike, totalGex } from "./optionChain2";
import { probTouch } from "./expectedMove";
import type { FlowRow } from "./flow";

// ---------------------------------------------------------------------------
// Constantes del método (todas del documento; aisladas para poder afinarlas)
// ---------------------------------------------------------------------------

/** Paso 2: strikes a cada lado del spot que forman el "vecindario". */
export const NEIGHBORS_PER_SIDE = 10;
/** Paso 3: targets hacia el imán ANTES de añadir el imán como último. */
export const MAX_TOWARD_TARGETS = 3;
/** Paso 4: targets de ruptura del lado contrario. */
export const MAX_BREAKOUT_TARGETS = 4;
/**
 * Paso 2b: piso de ruido. El Open Interest casi nunca es exactamente cero, así que
 * sin este piso CUALQUIER strike "confirmaría" algo. Solo el TOP 30% de gamma del
 * propio vecindario cuenta como pared real → percentil 70.
 *
 * Se ordena por el posicionamiento NETO del strike (|puts − calls|), no por la gamma
 * total: lo que se busca es una pared con LADO. Un strike con muchísimo OI en calls
 * Y en puts a la vez es un imán, pero no inclina hacia ningún lado, así que cae por
 * debajo del piso y se queda sin lectura — que es lo correcto para una señal
 * direccional.
 *
 * La comparación contra el piso es ESTRICTA (`>`), no `>=`. En un vecindario plano
 * —lo normal: casi todos los strikes con el mismo OI de fondo— el percentil 70 CAE
 * sobre ese mismo valor de fondo, así que con `>=` los 20 strikes lo igualarían y
 * el piso no filtraría nada. Con `>` solo pasa lo que sobresale de verdad, y si
 * todos los strikes son iguales no hay ninguna pared (que es la lectura correcta).
 */
export const STRUCTURAL_GAMMA_PERCENTILE = 0.7;
/**
 * Margen que hay que sacarle al piso para contar como pared (5%). No es un filtro
 * de verdad —una pared real supera el percentil 70 por 10× o más—, es el guardia
 * contra el empate: un strike que se cancela (mucho OI en calls Y en puts) da un
 * neto del orden del ruido de coma flotante, y con un `>` pelado se colaba por un
 * ULP por encima del piso. Con el margen, empatar con el fondo del vecindario no
 * basta: hay que destacar.
 */
export const WALL_MARGIN = 1.05;
/** Paso 5: los targets de RUPTURA van contra el régimen que ancla el GEX. */
export const BREAKOUT_DISCOUNT = 0.65;
/** Paso 5: en γ− los dealers amplifican en vez de anclar → la tesis del imán vale menos. */
export const NEGATIVE_GAMMA_DISCOUNT = 0.75;
/** EXTRA: el índice hermano confirma (menos que una pared del propio instrumento). */
export const SIBLING_BOOST = 1.15;
/** EXTRA: el índice hermano contradice → descuento fuerte. */
export const SIBLING_PENALTY = 0.6;
/** Paso 5: nunca mostrar 0% ni 100%. */
export const PROB_MIN = 0.03;
export const PROB_MAX = 0.95;
/**
 * Paso 5: banda del ajuste por agresividad del flujo. Con agresividad 0 la
 * probabilidad estadística se recorta a 0.75×; con agresividad 1 sube a 1.25×.
 * El flujo MODULA la estadística, no la sustituye.
 */
export const AGGRESSION_FLOOR = 0.75;
export const AGGRESSION_SPAN = 0.5;
/** Minutos de una sesión regular (9:30–16:00 ET); piso del horizonte. */
const TRADING_MINUTES = 390;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Dirección que fija el imán del GEX. "lateral" = imán pegado al spot. */
export type VecinoDirection = "call" | "put" | "lateral";
export type VecinoDecision = "entrar" | "esperar_breakout" | "lateral";
/** De dónde salió el sesgo del strike: dinero real, posicionamiento, o nada. */
export type BiasSource = "flujo" | "estructura" | "ninguna";

export interface StrikeNetPremium {
  /** Net premium de CALLS: + ejecutado al ASK, − ejecutado al BID. */
  call: number;
  /** Net premium de PUTS: + ejecutado al ASK, − ejecutado al BID. */
  put: number;
  /** Nº de operaciones con agresor identificable que entraron en la suma. */
  trades: number;
}

export interface NeighborStrike {
  strike: number;
  callNet: number;
  putNet: number;
  /** max(callNet,0) + max(0,−putNet) — compra de calls + venta de puts. */
  bullForce: number;
  /** max(putNet,0) + max(0,−callNet) — compra de puts + venta de calls. */
  bearForce: number;
  /** bullForce − bearForce. >0 alcista, <0 bajista, 0 sin sesgo. */
  netBias: number;
  source: BiasSource;
  /** |gamma real| × OI de las CALLS del strike (posicionamiento, Paso 2b). */
  callGammaOi: number;
  /** |gamma real| × OI de los PUTS del strike. */
  putGammaOi: number;
  /**
   * Posicionamiento NETO del strike = putGammaOi − callGammaOi. >0 predominan los
   * puts (soporte, alcista); <0 predominan las calls (resistencia, bajista).
   */
  netGammaOi: number;
  /** ¿|netGammaOi| superó el piso del TOP 30% del vecindario? */
  isWall: boolean;
  /** GEX neto del strike (calls +, puts −). */
  netGex: number;
  /** Agresividad normalizada dentro del vecindario y dentro de su fuente, 0-1. */
  aggression: number;
  /** Lectura en lenguaje llano según la tabla del Proceso Principal. */
  reading: string;
}

export type TargetKind = "hacia_iman" | "iman" | "ruptura";

export interface VecinoTarget {
  strike: number;
  kind: TargetKind;
  /** Probabilidad final 0-1, ya recortada a [PROB_MIN, PROB_MAX]. */
  probability: number;
  /** Probabilidad estadística de toque antes de los ajustes. */
  baseProbability: number;
  netBias: number;
  source: BiasSource;
  /** Distancia al spot en % (firmada). */
  distancePct: number;
  note: string;
}

export interface SiblingInput {
  /** Símbolo del índice hermano (SPX para ES, NDX para NQ). */
  symbol: string;
  /** Dirección que da el hermano con SU flujo real. */
  direction: VecinoDirection;
}

export interface SiblingConfirmation extends SiblingInput {
  effect: "confirma" | "contradice" | "neutral";
  /** Multiplicador aplicado a los targets hacia el imán. */
  factor: number;
}

export interface VecinosSignal {
  spot: number;
  /** Strike de la GRILLA REAL más cercano al spot (Paso 1). */
  spotStrike: number | null;
  magnet: number | null;
  direction: VecinoDirection;
  decision: VecinoDecision;
  regime: "positive" | "negative";
  totalGex: number;
  iv: number;
  horizonDays: number;
  /** Vecindario ordenado por strike ascendente. */
  neighbors: NeighborStrike[];
  towardTargets: VecinoTarget[];
  breakoutTargets: VecinoTarget[];
  /** Strikes que confirmaron la dirección CAMINO al imán, por fuente. */
  confirmations: { flow: number; structural: number };
  /** ¿Hubo algún net premium real utilizable en el vecindario? */
  hasRealFlow: boolean;
  sibling: SiblingConfirmation | null;
  warnings: string[];
  summary: string;
}

export interface VecinosInput {
  contracts: Chain2Contract[];
  spot: number;
  /** IV representativa en decimal (0.16 = 16%) para la probabilidad de toque. */
  iv: number;
  /** Días (fracción) hasta el cierre — las "horas restantes" del Paso 5. */
  horizonDays: number;
  /** Net premium real por strike. Vacío = sin cobertura de flujo → Paso 2b. */
  flow: Map<number, StrikeNetPremium>;
  /** EXTRA: confirmación cruzada del índice hermano (solo futuros). */
  sibling?: SiblingInput | null;
}

// ---------------------------------------------------------------------------
// Net premium real por strike (la fuente 2 del método)
// ---------------------------------------------------------------------------

/**
 * Net premium REAL ejecutado HOY por strike y tipo, para UN vencimiento.
 * Suma el premium ejecutado al ASK (compra agresiva, +) y resta el ejecutado al
 * BID (venta agresiva, −). Los `mid` y los agresores desconocidos NO cuentan: no
 * dicen quién cruzó el spread, y el método entero se apoya en esa distinción. PURA.
 */
export function netPremiumByStrike(
  rows: FlowRow[],
  expiration: string,
): Map<number, StrikeNetPremium> {
  const out = new Map<number, StrikeNetPremium>();
  for (const r of rows) {
    if (r.expiration !== expiration) continue;
    if (r.strike == null) continue;
    if (r.type !== "call" && r.type !== "put") continue;
    if (r.aggression !== "ask" && r.aggression !== "bid") continue;
    const signed = r.aggression === "ask" ? r.premium : -r.premium;
    const e = out.get(r.strike) ?? { call: 0, put: 0, trades: 0 };
    if (r.type === "call") e.call += signed;
    else e.put += signed;
    e.trades += 1;
    out.set(r.strike, e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

/** Percentil por interpolación lineal sobre una copia ordenada. */
export function percentile(values: number[], q: number): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  if (v.length === 1) return v[0];
  const idx = Math.min(Math.max(q, 0), 1) * (v.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** Lectura llana de un strike a partir de su net premium (tabla de dominio). */
function readingOf(callNet: number, putNet: number, netBias: number): string {
  const parts: string[] = [];
  if (callNet > 0) parts.push("compra agresiva de calls (alcista)");
  if (callNet < 0) parts.push("venta de calls (resistencia)");
  if (putNet > 0) parts.push("compra agresiva de puts (bajista)");
  if (putNet < 0) parts.push("venta de puts (soporte)");
  if (parts.length === 0) return "sin dinero real con agresor identificable";
  const dir = netBias > 0 ? "→ neto ALCISTA" : netBias < 0 ? "→ neto BAJISTA" : "→ se cancelan";
  return `${parts.join(" + ")} ${dir}`;
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

/** Construye la señal de Contratos Vecinos 2.0. PURA. */
export function buildVecinos(input: VecinosInput): VecinosSignal {
  const { contracts, spot, flow } = input;
  const iv = Math.max(input.iv, 0.01);
  const horizonDays = Math.max(input.horizonDays, 1 / TRADING_MINUTES);
  const warnings: string[] = [];

  // ── Paso 1 — Dirección: la fija el IMÁN DEL GEX, no el dinero real ──
  const gex = gexByStrike(contracts, spot);
  const total = totalGex(gex);
  const regime: "positive" | "negative" = total >= 0 ? "positive" : "negative";
  const gexBy = new Map<number, number>();
  for (const g of gex) gexBy.set(g.strike, g.gex);

  // Grilla REAL de strikes de la cadena (no un % fijo alrededor del spot).
  const grid = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);

  // Imán = strike de mayor concentración de |GEX|. La gamma real cae a cero en las
  // alas, así que la búsqueda se auto-limita cerca del dinero sin recortar a mano.
  let magnet: number | null = null;
  let bestMag = 0;
  for (const g of gex) {
    const mag = Math.abs(g.gex);
    if (mag > bestMag) { bestMag = mag; magnet = g.strike; }
  }

  // Strike de la grilla más cercano al spot: es contra ÉSTE que se compara el imán.
  let spotStrike: number | null = null;
  let bestDist = Infinity;
  for (const s of grid) {
    const d = Math.abs(s - spot);
    if (d < bestDist) { bestDist = d; spotStrike = s; }
  }

  let direction: VecinoDirection;
  if (magnet == null || spotStrike == null) {
    direction = "lateral";
    warnings.push("Sin gamma real utilizable en la cadena: no se puede fijar un imán.");
  } else if (magnet === spotStrike) {
    direction = "lateral";
  } else {
    direction = magnet > spotStrike ? "call" : "put";
  }
  const dirSign = direction === "call" ? 1 : direction === "put" ? -1 : 0;

  // ── Paso 2 — Vecindario: 10 strikes por lado del spot ──
  const below = grid.filter((s) => s <= spot).slice(-NEIGHBORS_PER_SIDE);
  const above = grid.filter((s) => s > spot).slice(0, NEIGHBORS_PER_SIDE);
  const hood = [...below, ...above];

  // Gamma real × OI por lado y por strike: es el insumo del respaldo estructural
  // (Paso 2b). El lado que hace pared lo decide la DOMINANCIA dentro del propio
  // strike (mucha call = resistencia, mucho put = soporte), no la posición respecto
  // al spot: así el posicionamiento también puede CONFIRMAR el imán y no solo
  // invalidarlo. Es además la misma convención +call/−put del GEX que usa el resto
  // de la app, con lo que el signo estructural es el contrario al del netGex.
  const callGammaOiBy = new Map<number, number>();
  const putGammaOiBy = new Map<number, number>();
  for (const c of contracts) {
    if (c.gamma == null || c.openInterest <= 0) continue;
    const target = c.type === "call" ? callGammaOiBy : putGammaOiBy;
    target.set(c.strike, (target.get(c.strike) ?? 0) + Math.abs(c.gamma) * c.openInterest);
  }
  const netGammaOiOf = (s: number) => (putGammaOiBy.get(s) ?? 0) - (callGammaOiBy.get(s) ?? 0);

  // Piso de ruido: TOP 30% del posicionamiento NETO del propio vecindario.
  const gammaFloor = percentile(hood.map((s) => Math.abs(netGammaOiOf(s))), STRUCTURAL_GAMMA_PERCENTILE);

  let hasRealFlow = false;
  const neighbors: NeighborStrike[] = hood.map((strike) => {
    const f = flow.get(strike);
    const callNet = f?.call ?? 0;
    const putNet = f?.put ?? 0;
    if (callNet !== 0 || putNet !== 0) hasRealFlow = true;

    const bullForce = Math.max(callNet, 0) + Math.max(0, -putNet);
    const bearForce = Math.max(putNet, 0) + Math.max(0, -callNet);
    let netBias = bullForce - bearForce;
    let source: BiasSource = netBias !== 0 ? "flujo" : "ninguna";

    const callGammaOi = callGammaOiBy.get(strike) ?? 0;
    const putGammaOi = putGammaOiBy.get(strike) ?? 0;
    const netGammaOi = putGammaOi - callGammaOi;
    // El piso es un percentil de valores absolutos, así que nunca es negativo:
    // superarlo (con margen) ya implica que el strike tiene un lado dominante.
    const isWall = Math.abs(netGammaOi) > Math.max(gammaFloor * WALL_MARGIN, Number.EPSILON);

    // ── Paso 2b — Respaldo sin flujo: clasificar por POSICIONAMIENTO ──
    // El flujo real SIEMPRE manda: esto solo entra donde el flujo dio netBias = 0.
    // Predominan los puts → soporte (alcista); predominan las calls → resistencia
    // (bajista). Vale en los dos lados del spot, así que un strike con OI de puts
    // por ENCIMA del precio sí puede confirmar un sesgo CALL.
    if (netBias === 0 && isWall) {
      netBias = netGammaOi;
      source = "estructura";
    }

    const reading =
      source === "estructura"
        ? netGammaOi > 0
          ? "sin flujo: predomina el OI de PUTS por posicionamiento (soporte)"
          : "sin flujo: predomina el OI de CALLS por posicionamiento (resistencia)"
        : readingOf(callNet, putNet, netBias);

    return {
      strike, callNet, putNet, bullForce, bearForce, netBias, source,
      callGammaOi, putGammaOi, netGammaOi, isWall,
      netGex: gexBy.get(strike) ?? 0, aggression: 0, reading,
    };
  });

  // Agresividad normalizada 0-1 DENTRO del vecindario y DENTRO de su fuente: el
  // premium ($) y el posicionamiento (OI × gamma) no comparten unidades, así que
  // normalizarlos juntos daría escalas sin sentido.
  for (const src of ["flujo", "estructura"] as const) {
    const group = neighbors.filter((n) => n.source === src);
    const max = group.reduce((m, n) => Math.max(m, Math.abs(n.netBias)), 0);
    if (max > 0) for (const n of group) n.aggression = Math.abs(n.netBias) / max;
  }

  // ── Paso 5 (motor) — probabilidad de un target ──
  const probOf = (strike: number, aggression: number, kind: TargetKind, siblingFactor: number) => {
    const base = probTouch(spot, strike, iv, horizonDays);
    let p = base * (AGGRESSION_FLOOR + AGGRESSION_SPAN * Math.min(Math.max(aggression, 0), 1));
    if (kind === "ruptura") {
      p *= BREAKOUT_DISCOUNT;
    } else {
      if (regime === "negative") p *= NEGATIVE_GAMMA_DISCOUNT;
      p *= siblingFactor;
    }
    return {
      base,
      probability: Math.min(PROB_MAX, Math.max(PROB_MIN, p)),
    };
  };

  const byStrike = new Map(neighbors.map((n) => [n.strike, n]));
  const distPct = (s: number) => (spot > 0 ? ((s - spot) / spot) * 100 : 0);

  // ── Paso 3 — Targets HACIA el imán (hasta 3 confirmados + el imán) ──
  const confirmed: NeighborStrike[] = [];
  if (direction !== "lateral" && magnet != null) {
    const path = neighbors
      .filter((n) => (dirSign > 0 ? n.strike > spot && n.strike < magnet : n.strike < spot && n.strike > magnet))
      .sort((a, b) => (dirSign > 0 ? a.strike - b.strike : b.strike - a.strike));
    for (const n of path) {
      if (confirmed.length >= MAX_TOWARD_TARGETS) break;
      if (sign(n.netBias) === dirSign) confirmed.push(n);
    }
  }

  // El desglose importa: una confirmación por posicionamiento es más débil que una
  // con dinero ejecutado hoy (el OI dice dónde hay posiciones abiertas, no que
  // alguien esté empujando el precio ahora). La UI y el aviso lo distinguen.
  const confirmations = {
    flow: confirmed.filter((n) => n.source === "flujo").length,
    structural: confirmed.filter((n) => n.source === "estructura").length,
  };
  const totalConfirmations = confirmations.flow + confirmations.structural;

  // ── EXTRA — Confirmación cruzada del índice hermano ──
  let sibling: SiblingConfirmation | null = null;
  let siblingFactor = 1;
  if (input.sibling && direction !== "lateral") {
    const sd = input.sibling.direction;
    if (sd === direction) {
      // Solo sube la entrada si NO había otra confirmación en el propio instrumento.
      const applies = totalConfirmations === 0;
      siblingFactor = applies ? SIBLING_BOOST : 1;
      sibling = { ...input.sibling, effect: "confirma", factor: siblingFactor };
    } else if (sd === "call" || sd === "put") {
      siblingFactor = SIBLING_PENALTY;
      sibling = { ...input.sibling, effect: "contradice", factor: siblingFactor };
      warnings.push(
        `${input.sibling.symbol} apunta ${sd === "call" ? "al alza" : "a la baja"}, en contra del imán: la entrada queda descontada ×${SIBLING_PENALTY}.`,
      );
    } else {
      sibling = { ...input.sibling, effect: "neutral", factor: 1 };
    }
  }

  const towardTargets: VecinoTarget[] = confirmed.map((n) => {
    const { base, probability } = probOf(n.strike, n.aggression, "hacia_iman", siblingFactor);
    return {
      strike: n.strike,
      kind: "hacia_iman",
      probability,
      baseProbability: base,
      netBias: n.netBias,
      source: n.source,
      distancePct: distPct(n.strike),
      note: n.reading,
    };
  });

  // El imán SIEMPRE se agrega como último target (el 4º), confirmado o no.
  if (direction !== "lateral" && magnet != null) {
    const mn = byStrike.get(magnet);
    const { base, probability } = probOf(magnet, mn?.aggression ?? 0, "hacia_iman", siblingFactor);
    towardTargets.push({
      strike: magnet,
      kind: "iman",
      probability,
      baseProbability: base,
      netBias: mn?.netBias ?? 0,
      source: mn?.source ?? "ninguna",
      distancePct: distPct(magnet),
      note:
        regime === "positive"
          ? "Imán del GEX: el dealer estabiliza (γ+) y tiende a anclar el precio ahí."
          : "Imán del GEX en régimen γ−: el dealer amplifica, así que el anclaje es menos fiable.",
    });
  }

  // ── Paso 4 — Targets de RUPTURA (lado contrario al imán) ──
  const breakoutTargets: VecinoTarget[] = [];
  if (direction !== "lateral") {
    const opposite = neighbors
      .filter((n) => (dirSign > 0 ? n.strike < spot : n.strike > spot))
      .sort((a, b) => (dirSign > 0 ? b.strike - a.strike : a.strike - b.strike));
    for (const n of opposite) {
      if (breakoutTargets.length >= MAX_BREAKOUT_TARGETS) break;
      if (sign(n.netBias) !== -dirSign) continue;
      const { base, probability } = probOf(n.strike, n.aggression, "ruptura", 1);
      breakoutTargets.push({
        strike: n.strike,
        kind: "ruptura",
        probability,
        baseProbability: base,
        netBias: n.netBias,
        source: n.source,
        distancePct: distPct(n.strike),
        note: `${n.reading} — si el precio rompe aquí, invalida la tesis del imán.`,
      });
    }
  }

  // ── Paso 6 — Decisión final ──
  const decision: VecinoDecision =
    direction === "lateral" ? "lateral" : totalConfirmations >= 1 ? "entrar" : "esperar_breakout";

  if (!hasRealFlow) {
    warnings.push(
      "Sin net premium real en el vecindario: los strikes se clasificaron por posicionamiento (OI × gamma real), no por dinero ejecutado.",
    );
  }
  if (decision === "entrar" && confirmations.flow === 0) {
    warnings.push(
      "La confirmación viene SOLO del posicionamiento (OI × gamma), no de dinero ejecutado hoy: hay posiciones abiertas a favor, pero nadie está empujando el precio todavía.",
    );
  }

  const dirWord = direction === "call" ? "CALL" : direction === "put" ? "PUT" : "lateral";
  const summary =
    direction === "lateral"
      ? magnet == null
        ? "Sin imán del GEX: no hay dirección que operar."
        : `El imán del GEX cae en el mismo strike que el spot ($${magnet}): LATERAL, no operar.`
      : decision === "entrar"
        ? `Imán en $${magnet} → sesgo ${dirWord}; ${totalConfirmations} strike${totalConfirmations === 1 ? "" : "s"} vecino${totalConfirmations === 1 ? "" : "s"} lo confirma${totalConfirmations === 1 ? "" : "n"} (${confirmations.flow} con dinero real, ${confirmations.structural} por posicionamiento).`
        : `Imán en $${magnet} → sesgo ${dirWord}, pero NINGÚN strike vecino lo confirma todavía: esperar la ruptura.`;

  return {
    spot,
    spotStrike,
    magnet,
    direction,
    decision,
    regime,
    totalGex: total,
    iv,
    horizonDays,
    neighbors,
    towardTargets,
    breakoutTargets,
    confirmations,
    hasRealFlow,
    sibling,
    warnings,
    summary,
  };
}
