// Motor de la "Tarjeta de Decisión" (framework The Scout / FLOW). PURO.
//
// Sintetiza los signals que el agente YA calcula (GEX, predicción, niveles,
// noticias, flujo) en una respuesta única a "¿Puedo tomar posición?":
//   - Scorecard de CONFLUENCIA 0–14 (7 factores × 2 pts) — distinto del scorecard
//     de 100 pts (que mide sentimiento); éste mide PERMISO DE TRADE.
//   - Calidad de setup A/B/C con reglas de DEGRADACIÓN.
//   - Semáforo: EJECUTAR / ESPERAR TRIGGER / NO TRADE.
//   - Plan condicional: trigger, entrada, invalidación, T1, T2, R:R.
//
// Reglas innegociables del documento (§2): no inventa datos (marca
// `DATO NO DISPONIBLE` y baja la confianza), separa hechos de inferencias, y
// SIN invalidación objetiva → NO TRADE. GEX/walls son contexto, no dirección.
//
// No toca red ni disco: recibe los structs ya computados y devuelve la tarjeta.

import type { GexAnalysis } from "./gex";
import type { ProPrediction } from "./prediction";
import type { LevelsReport, Level } from "./levels";
import { contradictionFlag, flowBias, type NewsBias } from "./news";
import { expectedMove } from "./expectedMove";
import { sma } from "./sma";

// ── Tipos de salida ────────────────────────────────────────────────────

export type Bias = "ALCISTA" | "BAJISTA" | "NEUTRAL";
export type Setup = "A" | "B" | "C";
export type Decision = "EJECUTAR" | "ESPERAR TRIGGER" | "NO TRADE";

/** Un print del Institutional Flow Tape (ya clasificado). */
export interface FlowTapeRow {
  contract: string;
  side: "BUY" | "SELL" | "—";
  size: number;
  premium: number;
  spot: number | null;
  sentiment: "bull" | "bear" | "neu";
}

/** Un strike de la gamma ladder (para la tarjeta). */
export interface GammaRung {
  strike: number;
  gamma: number;
  /** true si es el call wall (nodo de mayor concentración). */
  isWall: boolean;
}

export interface ConfluenceFactor {
  key: string;
  label: string;
  /** 0, 1 (parcial) o 2 (pleno). */
  points: 0 | 1 | 2;
  status: "ok" | "partial" | "fail" | "na";
  why: string;
}

export interface DecisionPlan {
  trigger: string;
  entry: number | null;
  invalidation: number | null;
  t1: number | null;
  t2: number | null;
  /** Riesgo:beneficio a T1 y T2 (null si falta invalidación o target). */
  rr1: number | null;
  rr2: number | null;
  /** Espacio disponible a T2 en % del spot. */
  roomPct: number | null;
  riesgo: string;
}

export interface DecisionReadout {
  si: { title: string; desc: string };
  espera: { title: string; desc: string };
  no: { title: string; desc: string };
}

export interface DecisionCard {
  ticker: string;
  company: string;
  spot: number;
  stamp: string;
  bias: Bias;
  /** 0-100, heredada de la predicción. */
  confidence: number;
  setup: Setup;
  decision: Decision;
  decisionNote: string;
  factors: ConfluenceFactor[];
  scoreTotal: number; // 0-14
  plan: DecisionPlan;
  /** Régimen GEX en texto (compresión / aceleración). */
  gexRegimeText: string;
  /** IV Rank REAL (0-100) y su lectura en lenguaje llano. null si no hay dato. */
  ivRank: number | null;
  ivNote: string;
  gammaLadder: GammaRung[];
  flowTape: FlowTapeRow[];
  /** Motivos de degradación aplicados (auditoría §10). */
  degradations: string[];
  /** Campos marcados DATO NO DISPONIBLE (§2). */
  missingData: string[];
  readout: DecisionReadout;
}

// ── Entrada ────────────────────────────────────────────────────────────

export interface DecisionInput {
  ticker: string;
  company: string;
  spot: number;
  now: Date;
  horizonDays: number;
  /** Cierres diarios, del más viejo al más reciente. */
  closes: number[];
  /** Máximo/mínimo de la sesión previa (PDH/PDL). null si no hay 2 barras. */
  prevHigh: number | null;
  prevLow: number | null;
  gex: GexAnalysis;
  prediction: ProPrediction;
  levels: LevelsReport;
  news: NewsBias;
  /** % del premium notable en calls (dirección del dinero). null si no hay flow. */
  callPct: number | null;
  flowTape: FlowTapeRow[];
  gammaLadder: GammaRung[];
  /** IV Rank REAL de Tastytrade (0-100). Contexto de volatilidad; null si no hay. */
  ivRank?: number | null;
  /** ¿El premarket está disponible? Hoy la app no lo trae → false. */
  premarketAvailable?: boolean;
}

// ── Constantes ─────────────────────────────────────────────────────────

const TREND_FAST = 20;
const TREND_SLOW = 50;
/** Rango mínimo (a la siguiente pared/objetivo) para no estar "pegado a la pared". */
const MIN_ROOM_PCT = 1.5;
/** Fuerza mínima de un nivel para servir de invalidación fiable. */
const MIN_INVAL_STRENGTH = 30;

// ── Helpers ────────────────────────────────────────────────────────────

type ThesisDir = "long" | "short" | "none";

function trendOf(closes: number[]): "alcista" | "bajista" | "lateral" {
  const price = closes.length ? closes[closes.length - 1] : null;
  const fast = sma(closes, TREND_FAST);
  const slow = sma(closes, TREND_SLOW);
  if (price == null || fast == null || slow == null) return "lateral";
  if (price > fast && fast > slow) return "alcista";
  if (price < fast && fast < slow) return "bajista";
  return "lateral";
}

function biasFrom(prediction: ProPrediction): Bias {
  if (prediction.direction === "up") return "ALCISTA";
  if (prediction.direction === "down") return "BAJISTA";
  return "NEUTRAL";
}

function thesisDir(bias: Bias): ThesisDir {
  if (bias === "ALCISTA") return "long";
  if (bias === "BAJISTA") return "short";
  return "none";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Lectura del IV Rank real para el operador (compra direccional). */
function ivRankNote(rank: number | null): string {
  if (rank == null) return "IV Rank no disponible (Tastytrade no configurado o sin cobertura).";
  const r = Math.round(rank);
  if (rank >= 71) return `IV Rank ${r}: IV estirada — prima cara y riesgo de IV crush al comprar.`;
  if (rank >= 51) return `IV Rank ${r}: IV por encima de su media histórica.`;
  if (rank >= 31) return `IV Rank ${r}: IV en su media histórica.`;
  if (rank >= 16) return `IV Rank ${r}: IV comprimida — prima barata, buen terreno para direccional comprado.`;
  return `IV Rank ${r}: IV dormida — el mercado no espera movimiento; opciones baratas pero sin catalizador.`;
}

// ── Los 7 factores de confluencia ──────────────────────────────────────

/** 1. Estructura de precio clara: tendencia SMA20/SMA50 definida. */
function factorStructure(closes: number[]): ConfluenceFactor {
  const t = trendOf(closes);
  if (t === "lateral") {
    return {
      key: "structure",
      label: "Estructura de precio clara",
      points: 0,
      status: "fail",
      why: "Precio lateral (sin orden SMA20/SMA50): sin estructura clara para operar.",
    };
  }
  return {
    key: "structure",
    label: "Estructura de precio clara",
    points: 2,
    status: "ok",
    why: `Tendencia ${t} definida (precio, SMA20 y SMA50 alineados).`,
  };
}

/**
 * 2. Premarket + PDH/PDL alineados. El premarket puro NO se trae hoy → este
 * factor se DEGRADA a máx 1 pt y se marca DATO NO DISPONIBLE (§2). Con PDH/PDL
 * sí evaluamos si el precio rompe/rechaza el nivel a favor de la tesis.
 */
function factorPremarket(
  spot: number,
  prevHigh: number | null,
  prevLow: number | null,
  dir: ThesisDir,
  premarketAvailable: boolean,
): ConfluenceFactor {
  const base = {
    key: "premarket",
    label: "Premarket + PDH/PDL alineados",
  };
  if (prevHigh == null || prevLow == null || dir === "none") {
    return {
      ...base,
      points: 0,
      status: "na",
      why: "Sin PDH/PDL (o sin sesgo direccional) para confirmar. Premarket no disponible.",
    };
  }
  const aligned =
    (dir === "long" && spot > prevLow) || (dir === "short" && spot < prevHigh);
  const strongAligned =
    (dir === "long" && spot > prevHigh) || (dir === "short" && spot < prevLow);
  if (!aligned) {
    return {
      ...base,
      points: 0,
      status: "fail",
      why: `Precio ${round2(spot)} en contra del PDH ${round2(prevHigh)} / PDL ${round2(prevLow)} para la tesis.`,
    };
  }
  // Alineado. Sin premarket real el tope es 1 pt (confianza recortada).
  const cap = premarketAvailable ? 2 : 1;
  const pts = strongAligned ? cap : 1;
  return {
    ...base,
    points: Math.min(pts, cap) as 0 | 1 | 2,
    status: premarketAvailable ? "ok" : "partial",
    why: strongAligned
      ? `Rompe ${dir === "long" ? `PDH ${round2(prevHigh)}` : `PDL ${round2(prevLow)}`} a favor.${premarketAvailable ? "" : " (Premarket N/D → 1 pt.)"}`
      : `Alineado con PDH/PDL${premarketAvailable ? "" : ", pero premarket N/D → 1 pt"}.`,
  };
}

/** 3. Call/Put Wall + Magnet apoyan la tesis. */
function factorWalls(gex: GexAnalysis, spot: number, dir: ThesisDir): ConfluenceFactor {
  const base = { key: "walls", label: "Call/Put Wall + Magnet apoyan" };
  if (gex.kingStrike == null || gex.nodes.length === 0) {
    return { ...base, points: 0, status: "na", why: "Sin nodo imán / walls en el GEX." };
  }
  if (dir === "none") {
    return {
      ...base,
      points: 1,
      status: "partial",
      why: `Imán en ${round2(gex.kingStrike)}, pero sin sesgo direccional que apoyar.`,
    };
  }
  const magnetAbove = gex.kingStrike > spot;
  const supports = (dir === "long" && magnetAbove) || (dir === "short" && !magnetAbove);
  return {
    ...base,
    points: supports ? 2 : 0,
    status: supports ? "ok" : "fail",
    why: supports
      ? `Imán en ${round2(gex.kingStrike)} ${magnetAbove ? "por encima" : "por debajo"} del precio: tira a favor de la tesis.`
      : `Imán en ${round2(gex.kingStrike)} ${magnetAbove ? "arriba" : "abajo"}: tira EN CONTRA de la tesis.`,
  };
}

/**
 * 4. GEX apoya el tipo de movimiento. Régimen negativo (aceleración) apoya un
 * movimiento direccional; positivo (compresión) lo frena → pin/fade.
 */
function factorGex(gex: GexAnalysis, dir: ThesisDir): ConfluenceFactor {
  const base = { key: "gex", label: "GEX apoya el movimiento" };
  if (dir === "none") {
    return {
      ...base,
      points: gex.regime === "positive" ? 1 : 0,
      status: "partial",
      why:
        gex.regime === "positive"
          ? "Compresión (γ+): favorece rango/pin, coherente con sesgo neutral."
          : "Aceleración (γ−) sin sesgo direccional que aprovechar.",
    };
  }
  if (gex.regime === "negative") {
    return {
      ...base,
      points: 2,
      status: "ok",
      why: "Régimen γ− (aceleración): amplifica el movimiento direccional.",
    };
  }
  // Compresión con tesis direccional: la ruptura hay que ganársela.
  return {
    ...base,
    points: 1,
    status: "partial",
    why: "Régimen γ+ (compresión): frena el movimiento; la ruptura hay que ganársela.",
  };
}

/** 5. Catalizador compatible / riesgo controlado (noticias vs flujo). */
function factorCatalyst(news: NewsBias, callPct: number | null): ConfluenceFactor {
  const base = { key: "catalyst", label: "Catalizador / riesgo controlado" };
  const flow = callPct == null ? "neutral" : flowBias(callPct);
  const flag = contradictionFlag(flow, news);
  if (flag.kind === "confirm") {
    return { ...base, points: 2, status: "ok", why: flag.title + "." };
  }
  if (flag.kind === "conflict") {
    return { ...base, points: 0, status: "fail", why: flag.title + "." };
  }
  return {
    ...base,
    points: 1,
    status: "partial",
    why: "Sin catalizador dominante que confirme o contradiga (riesgo neutro).",
  };
}

/**
 * 6. Rango disponible suficiente: distancia del precio a la siguiente pared en
 * contra ≥ MIN_ROOM_PCT. Si el precio está pegado a la pared → 0 (degrada).
 */
function factorRange(
  levels: LevelsReport,
  spot: number,
  dir: ThesisDir,
): { factor: ConfluenceFactor; roomPct: number | null } {
  const base = { key: "range", label: "Rango disponible suficiente" };
  const barrier: Level | null =
    dir === "long"
      ? levels.resistances[0] ?? null
      : dir === "short"
        ? levels.supports[0] ?? null
        : null;
  if (dir === "none") {
    return {
      factor: { ...base, points: 0, status: "na", why: "Sin sesgo direccional: rango no aplica." },
      roomPct: null,
    };
  }
  if (!barrier || spot <= 0) {
    return {
      factor: { ...base, points: 1, status: "partial", why: "Sin pared clara en contra: rango abierto pero sin objetivo definido." },
      roomPct: null,
    };
  }
  const roomPct = Math.abs(barrier.price - spot) / spot * 100;
  if (roomPct < MIN_ROOM_PCT) {
    return {
      factor: {
        ...base,
        points: 0,
        status: "fail",
        why: `Precio pegado a la pared (${round2(barrier.price)}, ${round2(roomPct)}% < ${MIN_ROOM_PCT}%): sin rango.`,
      },
      roomPct,
    };
  }
  return {
    factor: {
      ...base,
      points: 2,
      status: "ok",
      why: `${round2(roomPct)}% de rango hasta la pared en ${round2(barrier.price)}.`,
    },
    roomPct,
  };
}

/** 7. Invalidación clara: nivel guardián con fuerza suficiente detrás de la tesis. */
function factorInvalidation(
  levels: LevelsReport,
  dir: ThesisDir,
): { factor: ConfluenceFactor; level: Level | null } {
  const base = { key: "invalidation", label: "Invalidación clara" };
  const guard: Level | null =
    dir === "long"
      ? levels.keySupport ?? levels.supports[0] ?? null
      : dir === "short"
        ? levels.keyResistance ?? levels.resistances[0] ?? null
        : null;
  if (dir === "none") {
    return { factor: { ...base, points: 0, status: "na", why: "Sin sesgo: no hay invalidación que definir." }, level: null };
  }
  if (!guard) {
    return { factor: { ...base, points: 0, status: "fail", why: "Sin nivel guardián para la invalidación → NO TRADE." }, level: null };
  }
  if (guard.strength < MIN_INVAL_STRENGTH) {
    return {
      factor: { ...base, points: 1, status: "partial", why: `Invalidación en ${round2(guard.price)} pero débil (fuerza ${Math.round(guard.strength)}).` },
      level: guard,
    };
  }
  return {
    factor: { ...base, points: 2, status: "ok", why: `Invalidación en ${round2(guard.price)} (fuerza ${Math.round(guard.strength)}).` },
    level: guard,
  };
}

// ── Clasificación A/B/C + semáforo ─────────────────────────────────────

function classify(total: number): Setup {
  if (total >= 11) return "A";
  if (total >= 8) return "B";
  return "C";
}

/** Baja una letra el setup (A→B→C). */
function degradeOne(s: Setup): Setup {
  return s === "A" ? "B" : s === "B" ? "C" : "C";
}

// ── Motor principal ────────────────────────────────────────────────────

export function buildDecisionCard(input: DecisionInput): DecisionCard {
  const { spot, gex, prediction, levels, news, callPct } = input;
  const bias = biasFrom(prediction);
  const dir = thesisDir(bias);
  const missingData: string[] = [];
  const degradations: string[] = [];

  if (!input.premarketAvailable) missingData.push("Premarket");
  if (gex.greeksSource === "estimated") missingData.push("Greeks reales (GEX estimado por Black-Scholes)");

  // Los 7 factores.
  const fStructure = factorStructure(input.closes);
  const fPremarket = factorPremarket(spot, input.prevHigh, input.prevLow, dir, input.premarketAvailable ?? false);
  const fWalls = factorWalls(gex, spot, dir);
  const fGex = factorGex(gex, dir);
  const fCatalyst = factorCatalyst(news, callPct);
  const { factor: fRange, roomPct } = factorRange(levels, spot, dir);
  const { factor: fInval, level: invalLevel } = factorInvalidation(levels, dir);

  const factors = [fStructure, fPremarket, fWalls, fGex, fCatalyst, fRange, fInval];
  const scoreTotal = factors.reduce((s, f) => s + f.points, 0);

  // Setup base por score, luego DEGRADACIÓN (§5).
  let setup = classify(scoreTotal);

  // Falta la capa de opciones (GEX/walls) → degrada.
  const optionsLayerMissing =
    gex.lowLiquidity || gex.greeksSource === "estimated" || gex.nodes.length === 0;
  if (optionsLayerMissing) {
    setup = degradeOne(setup);
    degradations.push("Capa de opciones incompleta (baja liquidez o greeks estimados): setup degradado.");
  }
  // Rango insuficiente (precio pegado a la pared) → degrada.
  if (fRange.status === "fail") {
    setup = degradeOne(setup);
    degradations.push("Rango insuficiente (precio pegado a la pared): setup degradado.");
  }
  // Sin invalidación clara → fuerza C (y NO TRADE abajo).
  const noInvalidation = fInval.points === 0;
  if (noInvalidation) {
    setup = "C";
    degradations.push("Sin invalidación objetiva: NO TRADE (regla §2).");
  }

  // Semáforo (§6).
  let decision: Decision;
  let decisionNote: string;
  const compressionPin = gex.regime === "positive" && dir !== "none";

  if (noInvalidation || setup === "C" || dir === "none" || gex.lowLiquidity) {
    decision = "NO TRADE";
    decisionNote = noInvalidation
      ? "Sin invalidación objetiva."
      : dir === "none"
        ? "Sin sesgo direccional dominante."
        : gex.lowLiquidity
          ? "Cadena ilíquida: datos no fiables."
          : "Confluencia insuficiente (setup C).";
  } else if (fRange.status === "fail" || compressionPin || fPremarket.points < 1) {
    decision = "ESPERAR TRIGGER";
    decisionNote = fRange.status === "fail"
      ? "Precio pegado a la pared: espera ruptura/rechazo."
      : compressionPin
        ? "Compresión γ+: la ruptura hay que ganársela."
        : "Falta que el precio confirme el nivel (trigger).";
  } else {
    decision = "EJECUTAR";
    decisionNote = "Setup " + setup + " con rango suficiente y estructura a favor.";
  }

  // Plan condicional.
  const plan = buildPlan(input, dir, invalLevel, roomPct);

  const gexRegimeText =
    gex.regime === "positive"
      ? "Compresión (γ+): dealers estabilizan; favorece rango/pin."
      : "Aceleración (γ−): dealers amplifican; favorece movimiento direccional.";

  const ivRank = input.ivRank ?? null;
  if (ivRank == null) missingData.push("IV Rank (Tastytrade)");

  const readout = buildReadout(bias, dir, levels, invalLevel, decision);

  return {
    ticker: input.ticker,
    company: input.company,
    spot,
    stamp: input.now.toISOString(),
    bias,
    confidence: prediction.confidence,
    setup,
    decision,
    decisionNote,
    factors,
    scoreTotal,
    plan,
    gexRegimeText,
    ivRank,
    ivNote: ivRankNote(ivRank),
    gammaLadder: input.gammaLadder,
    flowTape: input.flowTape,
    degradations,
    missingData,
    readout,
  };
}

function buildPlan(
  input: DecisionInput,
  dir: ThesisDir,
  invalLevel: Level | null,
  roomPct: number | null,
): DecisionPlan {
  const { spot, levels, prediction } = input;
  const invalidation = invalLevel?.price ?? null;

  // Trigger: romper/sostener la resistencia (long) o rechazar/perder soporte (short).
  let trigger = "DATO NO DISPONIBLE";
  const res0 = levels.resistances[0]?.price ?? null;
  const sup0 = levels.supports[0]?.price ?? null;
  if (dir === "long" && res0 != null) trigger = `Romper y sostener > ${round2(res0)}`;
  else if (dir === "short" && sup0 != null) trigger = `Perder y sostener < ${round2(sup0)}`;
  else if (dir === "none") trigger = "Sin sesgo: definir dirección antes de operar";

  // Targets desde los escenarios de la predicción (ya recortados al cono 2σ).
  const t1 = round2(prediction.base.target);
  const t2 = dir === "long" ? round2(prediction.bull.target) : dir === "short" ? round2(prediction.bear.target) : null;

  const entry = spot;
  const rr = (target: number | null): number | null => {
    if (target == null || invalidation == null) return null;
    const reward = Math.abs(target - entry);
    const risk = Math.abs(entry - invalidation);
    if (risk <= 0) return null;
    return round2(reward / risk);
  };

  // Espacio a T2 en %.
  const room = t2 != null && spot > 0 ? round2(Math.abs(t2 - spot) / spot * 100) : roomPct;

  const riesgo =
    invalidation == null
      ? "Sin invalidación: no dimensionar posición."
      : `Cierra si pierde ${round2(invalidation)}. Tamaño 2–3% del capital (se calcula en tu perfil).`;

  return {
    trigger,
    entry: round2(entry),
    invalidation,
    t1,
    t2,
    rr1: rr(t1),
    rr2: rr(t2),
    roomPct: room,
    riesgo,
  };
}

function buildReadout(
  bias: Bias,
  dir: ThesisDir,
  levels: LevelsReport,
  invalLevel: Level | null,
  decision: Decision,
): DecisionReadout {
  const res0 = levels.resistances[0]?.price;
  const sup0 = levels.supports[0]?.price;
  const inval = invalLevel?.price;

  const siTitle =
    dir === "long"
      ? "Confirma la ruptura al alza"
      : dir === "short"
        ? "Confirma la ruptura a la baja"
        : "Aparece un sesgo direccional";
  const siDesc =
    dir === "long" && res0 != null
      ? `El precio rompe y sostiene > ${round2(res0)} con volumen, y hay rango libre al target.`
      : dir === "short" && sup0 != null
        ? `El precio pierde y sostiene < ${round2(sup0)} con volumen, y hay rango libre al target.`
        : "Espera a que la estructura y el GEX marquen una dirección clara.";

  const esperaDesc =
    dir === "long"
      ? "El precio está bajo la resistencia o la compresión γ+ aún no cede: espera la ruptura, no entres pegado a la pared."
      : dir === "short"
        ? "El precio está sobre el soporte o la compresión γ+ aún no cede: espera el rechazo, no entres pegado a la pared."
        : "El sesgo aún no es dominante: espera confirmación de flujo y estructura.";

  const noDesc =
    inval == null
      ? "No hay invalidación objetiva: sin punto de salida definido, no hay trade."
      : `Se pierde la invalidación en ${round2(inval)}, la cadena se vuelve ilíquida, o el setup cae a C.`;

  return {
    si: { title: siTitle, desc: siDesc },
    espera: { title: decision === "ESPERAR TRIGGER" ? "Estás aquí" : "Espera el trigger", desc: esperaDesc },
    no: { title: "No operar", desc: noDesc },
  };
}
