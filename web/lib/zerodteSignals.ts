// ============================================================================
// Señales tácticas del 0DTE — todo PURO (tests en zerodteSignals.test.ts).
//
// Encima del motor de `lib/zerodte.ts` (cadena, GEX, imán, régimen) se apoyan
// cinco capas que el agente muestra en vivo:
//
//   1. GEX Trade · original  → "vuelta al imán". Solo en γ+, donde el dealer
//      estabiliza y devuelve el precio al strike de más gamma.
//   2. GEX Trade · alterno   → "MOMENTUM γ−". En γ− el dealer AMPLIFICA, así que
//      la vuelta no sirve: se opera la ruptura en la dirección del flip.
//   3. GEX Ticket            → traduce el trade a un CONTRATO concreto de la
//      cadena (strike, delta, mid, coste y ganancia estimada en el objetivo).
//   4. GEX Bias (5 min)      → cono de 1σ a muy corto plazo, con una variante
//      "alterna" que desplaza el centro con el peso del flujo (agresor).
//   5. GEX Pinning           → strike de cierre más probable; solo se publica en
//      la ventana 15:00-16:00 ET, que es cuando el pin de verdad manda.
//
// Nada de esto es una orden ni un consejo: el agente calcula y muestra.
// ============================================================================

import type { ZeroDteAnalysis, ZeroDteStrike } from "./zerodte";
import { expectedMove } from "./expectedMove";

/** Colchón del stop = 0.2% del spot (scalp intradía). */
export const STOP_PCT = 0.002;
/** Separación mínima al objetivo para que haya recorrido que operar. */
export const MIN_EDGE_PCT = 0.0004;
/** Ratio beneficio/riesgo mínimo para publicar una idea. */
export const MIN_RR = 1;
/** Minuto ET en que abre la ventana de pinning (15:00). */
export const PIN_START_MIN = 15 * 60;

export type TradeModel = "magnet" | "momentum";

export interface ZeroDteTrade {
  model: TradeModel;
  side: "LONG" | "SHORT";
  entry: number;
  target: number;
  stop: number;
  reward: number;
  risk: number;
  rr: number;
  rationale: string;
}

export interface ZeroDteTradeCard {
  model: TradeModel;
  /** Etiqueta corta del modelo, para la cabecera de la tarjeta. */
  label: string;
  trade: ZeroDteTrade | null;
  /** Por qué NO hay trade (vacío si sí lo hay). */
  note: string;
}

// ---------------------------------------------------------------------------
// 1. GEX Trade original — vuelta al imán (solo γ+)
// ---------------------------------------------------------------------------

/**
 * Reversión al imán del GEX. En γ+ el dealer compra debilidad y vende fuerza,
 * así que el precio tiende a volver al strike de mayor gamma. En γ− NO se
 * sugiere nada: ahí el dealer acelera y la vuelta deja de ser fiable.
 */
export function magnetTrade(a: ZeroDteAnalysis): ZeroDteTradeCard {
  const label = "vuelta al imán";
  const { spot, magnet, regime } = a;
  if (magnet == null || !(spot > 0)) {
    return { model: "magnet", label, trade: null, note: "Sin imán del GEX claro por ahora." };
  }
  const dist = magnet - spot; // + = imán por encima del precio
  const absPts = Math.abs(dist);
  if (absPts / spot < MIN_EDGE_PCT) {
    return {
      model: "magnet", label, trade: null,
      note: `El precio ya está pegado al imán ${fmt(magnet)} — sin recorrido para operar la vuelta.`,
    };
  }
  if (regime !== "positive") {
    return {
      model: "magnet", label, trade: null,
      note: "γ− amplifica: el dealer acelera los movimientos, así que la vuelta al imán no es fiable. Mira el modelo alterno (momentum).",
    };
  }
  const side: ZeroDteTrade["side"] = dist > 0 ? "LONG" : "SHORT";
  const stopBuf = spot * STOP_PCT;
  const stop = side === "LONG" ? spot - stopBuf : spot + stopBuf;
  const above = dist < 0;
  return {
    model: "magnet", label,
    trade: {
      model: "magnet", side, entry: spot, target: magnet, stop,
      reward: absPts, risk: stopBuf, rr: absPts / stopBuf,
      rationale: `γ+ y el precio está ${absPts.toFixed(0)} pts ${above ? "por encima" : "por debajo"} del imán ${fmt(magnet)}; se apuesta a la vuelta al imán.`,
    },
    note: "",
  };
}

// ---------------------------------------------------------------------------
// 2. GEX Trade alterno — momentum en γ−
// ---------------------------------------------------------------------------

/**
 * Momentum en gamma negativa. Cuando el GEX total es negativo el dealer cubre A
 * FAVOR del movimiento: vende abajo y compra arriba. La zona de flip es la
 * bisagra — por encima acelera al alza, por debajo a la baja — así que se opera
 * en esa dirección con el stop justo al otro lado del flip y el objetivo en el
 * muro de volumen siguiente (acotado al cono de 1σ).
 */
export function momentumTrade(a: ZeroDteAnalysis): ZeroDteTradeCard {
  const label = "momentum · γ−";
  const { spot, regime, flipStrike, expectedRange } = a;
  if (!(spot > 0)) {
    return { model: "momentum", label, trade: null, note: "Sin precio utilizable." };
  }
  if (regime !== "negative") {
    return {
      model: "momentum", label, trade: null,
      note: "γ+ estabiliza: el dealer frena los movimientos, así que el momentum no tiene combustible. Mira el modelo original (vuelta al imán).",
    };
  }

  // Dirección: el flip manda; si no hay flip, decide el sesgo del día.
  let side: ZeroDteTrade["side"];
  let why: string;
  if (flipStrike != null) {
    side = spot >= flipStrike ? "LONG" : "SHORT";
    why = `γ− y el precio está ${spot >= flipStrike ? "por encima" : "por debajo"} del flip ${fmt(flipStrike)}: el dealer cubre a favor y acelera`;
  } else if (Math.abs(a.leanScore) >= 15) {
    side = a.leanScore > 0 ? "LONG" : "SHORT";
    why = `γ− sin zona de flip clara; manda el sesgo del día (${a.leanScore > 0 ? "alcista" : "bajista"})`;
  } else {
    return {
      model: "momentum", label, trade: null,
      note: "γ− pero sin flip ni sesgo claro: no hay dirección que perseguir.",
    };
  }

  // Objetivo: muro de volumen a favor; si no lo hay o queda detrás, el borde de 1σ.
  const wall = side === "LONG" ? a.topVolumeCall?.strike : a.topVolumePut?.strike;
  const edge = side === "LONG" ? expectedRange.high : expectedRange.low;
  const wallOk = wall != null && (side === "LONG" ? wall > spot : wall < spot);
  const rawTarget = wallOk ? (wall as number) : edge;
  // Nunca más allá de 1σ: en lo que queda de sesión el precio no llega a donde la vol no da.
  const target = side === "LONG"
    ? Math.min(rawTarget, expectedRange.high)
    : Math.max(rawTarget, expectedRange.low);

  const reward = Math.abs(target - spot);
  if (reward / spot < MIN_EDGE_PCT) {
    return {
      model: "momentum", label, trade: null,
      note: `El objetivo (${fmt(target)}) está pegado al precio — sin recorrido para perseguir la ruptura.`,
    };
  }

  // Stop: al otro lado del flip si está cerca; si no, el colchón fijo.
  const buf = spot * STOP_PCT;
  const flipStop = flipStrike != null && Math.abs(spot - flipStrike) <= spot * 0.006
    ? (side === "LONG" ? flipStrike - buf * 0.25 : flipStrike + buf * 0.25)
    : null;
  const stop = flipStop ?? (side === "LONG" ? spot - buf : spot + buf);
  const risk = Math.abs(spot - stop);
  if (!(risk > 0)) {
    return { model: "momentum", label, trade: null, note: "Stop degenerado (riesgo cero); sin idea publicable." };
  }
  const rr = reward / risk;
  if (rr < MIN_RR) {
    return {
      model: "momentum", label, trade: null,
      note: `El recorrido hasta ${fmt(target)} no paga el riesgo (R/B ${rr.toFixed(1)}:1). Se descarta.`,
    };
  }

  return {
    model: "momentum", label,
    trade: {
      model: "momentum", side, entry: spot, target, stop, reward, risk, rr,
      rationale: `${why}; objetivo en ${wallOk ? `el muro de volumen ${fmt(target)}` : `el borde de 1σ ${fmt(target)}`}.`,
    },
    note: "",
  };
}

// ---------------------------------------------------------------------------
// 3. GEX Ticket — el contrato concreto
// ---------------------------------------------------------------------------

export interface ZeroDteTicket {
  optionSymbol: string;
  type: "call" | "put";
  strike: number;
  delta: number | null;
  bid: number | null;
  ask: number | null;
  mid: number;
  /** Horquilla como % del mid — por encima de ~15% el ticket se come el edge. */
  spreadPct: number | null;
  volume: number;
  openInterest: number;
  /** Coste de 1 contrato ($). */
  cost: number;
  /** Precio estimado del contrato si el subyacente llega al objetivo (delta lineal). */
  targetPrice: number;
  /** Ganancia estimada por contrato en el objetivo ($). */
  targetGain: number;
  /** Pérdida estimada por contrato si salta el stop ($, negativa). */
  stopLoss: number;
  liquidity: "buena" | "justa" | "pobre";
  rationale: string;
}

/** |delta| útil para un 0DTE direccional: mueve de verdad sin pagar ITM. */
const DELTA_LO = 0.25;
const DELTA_HI = 0.60;

interface TicketCand {
  s: ZeroDteStrike;
  mid: number;
  delta: number;
  spreadPct: number | null;
  vol: number;
  oi: number;
}

/**
 * Traduce un trade del GEX en el contrato de la cadena que mejor lo expresa:
 * delta en la zona útil, horquilla sana y volumen/OI que garanticen salida.
 * Devuelve null (con nota) si no hay trade o si la cadena no ofrece nada líquido.
 */
export function gexTicket(
  a: ZeroDteAnalysis,
  trade: ZeroDteTrade | null,
): { ticket: ZeroDteTicket | null; note: string } {
  if (!trade) return { ticket: null, note: "Sin trade activo — no hay contrato que sugerir." };
  const type: "call" | "put" = trade.side === "LONG" ? "call" : "put";

  const cands: TicketCand[] = [];
  for (const s of a.strikes) {
    const leg = type === "call" ? s.call : s.put;
    if (!leg) continue;
    const mid = leg.price != null && leg.price > 0 ? leg.price : null;
    if (mid == null) continue;
    const d = leg.delta != null ? Math.abs(leg.delta) : null;
    if (d == null || d < DELTA_LO || d > DELTA_HI) continue;
    if (leg.volume <= 0 && leg.openInterest <= 0) continue;
    const spreadPct =
      leg.bid != null && leg.ask != null && mid > 0 ? ((leg.ask - leg.bid) / mid) * 100 : null;
    cands.push({ s, mid, delta: d, spreadPct, vol: leg.volume, oi: leg.openInterest });
  }
  if (cands.length === 0) {
    return {
      ticket: null,
      note: `La cadena no ofrece ${type === "call" ? "calls" : "puts"} con delta ${DELTA_LO}-${DELTA_HI} y precio utilizable.`,
    };
  }

  // Puntuación: liquidez (volumen + OI) castigada por la horquilla y por alejarse
  // del delta ideal (0.40), que es donde mejor paga el movimiento en un 0DTE.
  const maxVol = Math.max(1, ...cands.map((c) => c.vol));
  const maxOi = Math.max(1, ...cands.map((c) => c.oi));
  const score = (c: TicketCand) =>
    0.45 * (c.vol / maxVol) +
    0.25 * (c.oi / maxOi) +
    0.20 * (1 - Math.min(1, Math.abs(c.delta - 0.4) / 0.2)) +
    0.10 * (c.spreadPct == null ? 0.3 : Math.max(0, 1 - c.spreadPct / 15));
  const best = cands.reduce((b, c) => (score(c) > score(b) ? c : b), cands[0]);

  const leg = (type === "call" ? best.s.call : best.s.put)!;
  const signedDelta = leg.delta ?? (type === "call" ? best.delta : -best.delta);
  const targetPrice = Math.max(0, best.mid + signedDelta * (trade.target - trade.entry));
  const stopPrice = Math.max(0, best.mid + signedDelta * (trade.stop - trade.entry));
  const liquidity: ZeroDteTicket["liquidity"] =
    best.spreadPct == null ? "justa" : best.spreadPct <= 6 ? "buena" : best.spreadPct <= 15 ? "justa" : "pobre";

  return {
    ticket: {
      optionSymbol: leg.optionSymbol,
      type,
      strike: best.s.strike,
      delta: leg.delta,
      bid: leg.bid,
      ask: leg.ask,
      mid: best.mid,
      spreadPct: best.spreadPct,
      volume: leg.volume,
      openInterest: leg.openInterest,
      cost: best.mid * 100,
      targetPrice,
      targetGain: (targetPrice - best.mid) * 100,
      stopLoss: (stopPrice - best.mid) * 100,
      liquidity,
      rationale: `${type === "call" ? "CALL" : "PUT"} ${fmt(best.s.strike)} con delta ${signedDelta.toFixed(2)}: si el subyacente llega a ${fmt(trade.target)}, el contrato vale ≈ $${targetPrice.toFixed(2)} (delta lineal, sin contar theta ni cambios de IV).`,
    },
    note: "",
  };
}

// ---------------------------------------------------------------------------
// 4. GEX Bias — cono de 5 minutos (original + alterno con flujo)
// ---------------------------------------------------------------------------

/** Minutos de un día natural — la IV se anualiza sobre 365 días naturales. */
const MINUTES_PER_DAY = 1440;

export type BiasDir = "up" | "down" | "flat";

export interface ZeroDteBias {
  model: "original" | "alterno";
  minutes: number;
  spot: number;
  /** Centro proyectado (spot + deriva del GEX y, en el alterno, del flujo). */
  center: number;
  low: number;
  high: number;
  /** 1σ en puntos del subyacente para ese horizonte. */
  sigmaPts: number;
  dir: BiasDir;
  confidence: "baja" | "media" | "alta";
  /** Lectura de régimen: qué pasa si rompe el nivel clave. */
  note: string;
  /** Solo en el alterno: cómo pesó el flujo. */
  flowNote: string | null;
}

function confidenceOf(n: number): ZeroDteBias["confidence"] {
  return n >= 65 ? "alta" : n >= 35 ? "media" : "baja";
}

/**
 * Proyección a `minutes` minutos: cono de 1σ centrado en el spot y desplazado
 * por la deriva. La deriva del GEX vale como mucho media sigma (el sesgo empuja,
 * no teletransporta) y el flujo añade otra media sigma en el modelo alterno.
 *
 * `flowWeight` va de −1 (todo el agresor vendiendo) a +1 (todo comprando); null
 * o 0 = flujo neutral, y entonces el alterno coincide con el original.
 */
export function gexBias(
  a: ZeroDteAnalysis,
  minutes: number,
  opts: { model?: "original" | "alterno"; flowWeight?: number | null } = {},
): ZeroDteBias {
  const model = opts.model ?? "original";
  const m = Math.max(1, minutes);
  const em = expectedMove(a.spot, a.iv, m / MINUTES_PER_DAY);
  const sigmaPts = em.sigma;

  const gexDrift = clamp(a.leanScore / 100, -1, 1) * 0.5 * sigmaPts;
  // Un peso que redondea a 0.00 en pantalla ES flujo neutral: dejarlo empujar
  // producía el sinsentido "presión vendedora (peso −0.00) → centro abajo 0.00 pts".
  const rawW = opts.flowWeight == null ? 0 : clamp(opts.flowWeight, -1, 1);
  const w = Math.abs(rawW) < 0.005 ? 0 : rawW;
  const flowDrift = model === "alterno" ? w * 0.5 * sigmaPts : 0;
  const center = a.spot + gexDrift + flowDrift;

  const drift = center - a.spot;
  const dir: BiasDir = drift > 0.25 * sigmaPts ? "up" : drift < -0.25 * sigmaPts ? "down" : "flat";

  const note = a.regime === "negative"
    ? a.flipStrike != null
      ? `Gamma negativa: los movimientos se amplifican. Si rompe ${fmt(a.flipStrike)}, puede acelerar.`
      : "Gamma negativa: el dealer cubre a favor del movimiento, así que los impulsos se amplifican."
    : a.magnet != null
      ? `Gamma positiva: el dealer amortigua. Cerca del imán ${fmt(a.magnet)} el precio tiende a frenarse.`
      : "Gamma positiva: el dealer amortigua los movimientos, el rango tiende a comprimirse.";

  const flowNote = model !== "alterno"
    ? null
    : w === 0
      ? "flujo neutral (peso 0.00) → sin cambio"
      : `${w > 0 ? "presión compradora" : "presión vendedora"} (peso ${signedStr(w, 2)}) → centro ${w > 0 ? "arriba" : "abajo"} ${Math.abs(flowDrift).toFixed(2)} pts`;

  return {
    model, minutes: m, spot: a.spot, center,
    low: center - sigmaPts, high: center + sigmaPts,
    sigmaPts, dir, confidence: confidenceOf(a.confidence), note, flowNote,
  };
}

// ---------------------------------------------------------------------------
// 5. GEX Pinning — strike de cierre más probable
// ---------------------------------------------------------------------------

export interface ZeroDtePinning {
  /** Minutos hasta las 15:00 ET (0 si ya estamos dentro o pasó). */
  minutesToPin: number;
  /** true cuando estamos en la ventana 15:00-16:00 ET con mercado abierto. */
  inWindow: boolean;
  /** Strike publicado — solo dentro de la ventana; fuera va null. */
  strike: number | null;
  /** El candidato que el motor ve AHORA (se publica al entrar en la ventana). */
  candidate: number | null;
  /** GEX neto = fuerza del pin. Positivo ancla; negativo repele. */
  strength: number;
  regime: "positive" | "negative";
  note: string;
}

/**
 * Strike de cierre más probable por anclaje de dealers. El candidato es el strike
 * de mayor |gamma neta| DENTRO del cono de 1σ (fuera de ahí el precio no llega),
 * y solo se publica entre las 15:00 y las 16:00 ET: antes de esa hora el gamma
 * del 0DTE todavía se mueve demasiado como para fijar un cierre.
 */
export function pinning(
  a: ZeroDteAnalysis,
  etMinuteOfDay: number | null,
  minutesLeft: number,
): ZeroDtePinning {
  const lo = a.expectedRange.low;
  const hi = a.expectedRange.high;
  let candidate: number | null = null;
  let best = 0;
  for (const s of a.strikes) {
    if (s.strike < lo || s.strike > hi) continue;
    const mag = Math.abs(s.netGex);
    if (mag > best) { best = mag; candidate = s.strike; }
  }
  if (candidate == null) candidate = a.magnet;

  const min = etMinuteOfDay;
  const minutesToPin = min == null ? 0 : Math.max(0, PIN_START_MIN - min);
  const inWindow = min != null && min >= PIN_START_MIN && minutesLeft > 0;

  const note = a.regime === "positive"
    ? "γ+ : el dealer compra debilidad y vende fuerza, así que el cierre tiende a imantarse al strike de más gamma."
    : "γ− : el dealer cubre a favor del movimiento, así que el pin es débil y el cierre puede escaparse.";

  return {
    minutesToPin,
    inWindow,
    strike: inWindow ? candidate : null,
    candidate,
    strength: a.totalGex,
    regime: a.regime,
    note,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

function signedStr(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

/** Formato corto de precio para los textos del motor (sin símbolo de moneda). */
function fmt(n: number): string {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toFixed(2);
}
