// Piloto automático (Fase 2). Lógica PURA: convierte SEÑALES ya calculadas (flujo swing y
// GEX intradía) en CANDIDATOS de paper trade y aplica el filtrado (umbral + una entrada por
// ticker). El I/O (escanear el mercado, cotizar cadenas) vive en la ruta; aquí solo decidimos.
//
// Recordatorio de honestidad: "probabilidad" = FUERZA del setup, jamás una garantía. Nada
// de esto mueve dinero real: los candidatos se abren como paper trades marcados AUTO.

import type { Direction, OptionType } from "./paperTrade";
import { dteOf } from "./optionChain2";

// --- Umbrales y parámetros (tuneables) -------------------------------------
export const MIN_PROB = 60; // no se toma un setup por debajo de esto
/**
 * Contratos con los que NACE un plan pendiente. Es un marcador de posición, no un
 * tamaño: un pendiente todavía no tiene prima, así que no hay con qué dimensionar.
 * El tamaño de verdad lo fija `sizeForSwing` AL ENTRAR (ver `evaluate` en
 * lib/paperTrade). Hasta el 2026-08-28 este 1 era el tamaño definitivo y la bitácora
 * acabó con un put de $29.620 en una cuenta de $10.000.
 */
export const DEFAULT_CONTRACTS = 1;

// Swing: niveles derivados del precio del subyacente al momento del flujo.
export const SWING_TRIGGER_PCT = 0.3; // gatillo = pequeño breakout de confirmación
export const SWING_TARGET_PCT = 4; // objetivo (%)
export const SWING_STOP_PCT = 2; // stop (%) → riesgo:recompensa ~1:2
/**
 * Banda de vida del contrato para un swing, en días.
 *
 * Hace falta porque el strike y el vencimiento del swing **no los elige el agente**:
 * se copian del contrato que operó la institución en el flujo de MarketSnack, así
 * que llegan de todo — se han visto desde 2 días hasta LEAPS de diciembre de 2028.
 * El plan swing siempre es el mismo (±4% objetivo, ∓2% stop sobre el subyacente),
 * un movimiento de días o pocas semanas, y ese plan no encaja ni con un contrato de
 * dos días (el theta se lo come antes de llegar al objetivo) ni con uno de dos años
 * (delta ~1: la prima apenas se mueve en % ante un 4% del subyacente).
 */
export const SWING_DTE_MIN = 7;
export const SWING_DTE_MAX = 120;

/**
 * Ticker del plan → símbolo con el que SE COTIZA el subyacente, cuando no coinciden.
 *
 * POR QUÉ EXISTE. El piloto copia el `underlying` que le da el flujo de MarketSnack, y
 * para las opciones semanales de índice eso NO es un ticker: es la **raíz de la opción**
 * (`SPXW`, `NDXP`, `SPXPM`, `VIXW`). Ninguna cotiza — verificado el 2026-08-28 contra el
 * streamer: `SPXW`, `NDXP`, `SPXPM` y `VIXW` devuelven `null`, mientras `SPX`, `NDX` y
 * `VIX` cotizan sin problema. Como `evaluate` necesita el precio del subyacente para
 * cruzar el gatillo, esos planes **no podían activarse nunca**: nacían, bloqueaban su
 * ticker siete días por la regla de "una entrada por ticker" y morían caducados. En el
 * libro son **8 de 8 planes de índice sin una sola entrada**, 7 de ellos caducados.
 *
 * Solo se traduce PARA COTIZAR. El `ticker` del plan se queda como está a propósito,
 * porque es lo que identifica el contrato: la cadena resuelve igual por las dos vías
 * (comprobado, `SPXW` y `SPX` devuelven los mismos 2.500 contratos), así que renombrar
 * no arreglaría nada y sí arriesgaría perder la correspondencia con el flujo original.
 * Mismo criterio que `STREAMER_UNDERLYING` en lib/tastytrade.
 *
 * OJO — `RUTW` NO está aquí: su subyacente `RUT` **tampoco cotiza**, así que traducirlo
 * no serviría de nada. Ese caso lo tapa el filtro de cotizables del escaneo, que es la
 * red de seguridad general; esta tabla solo cubre lo que sí tiene traducción buena.
 */
export const QUOTE_UNDERLYING: Record<string, string> = {
  SPXW: "SPX",
  SPXPM: "SPX",
  NDXP: "NDX",
  VIXW: "VIX",
};

/** Símbolo con el que pedir el precio del subyacente de un plan. */
export function quoteSymbolFor(ticker: string): string {
  const clean = ticker.trim().toUpperCase();
  return QUOTE_UNDERLYING[clean] ?? clean;
}

// Intradía: objetivo = imán del GEX; stop = fracción de la distancia al imán.
export const INTRADAY_TRIGGER_PCT = 0.1;
export const INTRADAY_STOP_FRACTION = 0.5;

// --- Señales de entrada (adaptadas en la ruta desde Idea / GexAnalysis) -----
export interface SwingSignal {
  ticker: string;
  optionType: OptionType;
  strike: number;
  expiration: string; // YYYY-MM-DD
  assetPrice: number; // precio del subyacente al momento del flujo
  unusualScore: number; // 0-~30 (sub-agente de inusualidad)
  hitRate: number | null; // 0-100, acierto histórico del ticker (sub-agente 6)
}

export interface IntradaySignal {
  ticker: string;
  spot: number;
  direction: Direction | "flat" | null;
  kingStrike: number | null; // nodo imán del GEX = objetivo
  confidence: number; // 0-100 del GEX
  strike: number; // contrato ATM elegido
  expiration: string; // vencimiento cercano elegido
}

export interface Candidate {
  source: "swing" | "intraday";
  ticker: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  direction: Direction;
  trigger: number;
  target: number;
  stop: number;
  probability: number; // 0-100
  note: string; // "Swing" | "Day Trading"
  refPrice: number; // subyacente de referencia al escanear
}

function clampProb(n: number): number {
  return Math.max(0, Math.min(99, Math.round(n)));
}

/** Probabilidad heurística del swing: mezcla el acierto histórico con la inusualidad. */
export function swingProbability(s: SwingSignal): number {
  const unusualComponent = Math.min(100, 40 + s.unusualScore * 2); // 24 pts → 88
  const p = s.hitRate != null ? 0.5 * s.hitRate + 0.5 * unusualComponent : unusualComponent;
  return clampProb(p);
}

/** Un candidato swing desde una señal de flujo. null si el plan no queda coherente. */
export function swingCandidate(s: SwingSignal, now: Date): Candidate | null {
  if (!(s.assetPrice > 0)) return null;

  // El contrato tiene que durar lo que dura el plan (ver SWING_DTE_MIN/MAX).
  const dte = dteOf(s.expiration, now);
  if (dte < SWING_DTE_MIN || dte > SWING_DTE_MAX) return null;

  const direction: Direction = s.optionType === "put" ? "down" : "up";
  const sign = direction === "up" ? 1 : -1;
  const ref = s.assetPrice;
  const trigger = ref * (1 + (sign * SWING_TRIGGER_PCT) / 100);
  const target = ref * (1 + (sign * SWING_TARGET_PCT) / 100);
  const stop = ref * (1 - (sign * SWING_STOP_PCT) / 100);
  if (!validPlan(direction, ref, trigger, target, stop)) return null;
  return {
    source: "swing",
    ticker: s.ticker,
    optionType: s.optionType,
    strike: s.strike,
    expiration: s.expiration,
    direction,
    trigger: round2(trigger),
    target: round2(target),
    stop: round2(stop),
    probability: swingProbability(s),
    note: "Swing",
    refPrice: round2(ref),
  };
}

/** Un candidato intradía desde el GEX. null si no hay dirección clara o el imán no ayuda. */
export function intradayCandidate(s: IntradaySignal): Candidate | null {
  if (s.direction !== "up" && s.direction !== "down") return null;
  if (s.kingStrike == null || !(s.spot > 0)) return null;
  const direction = s.direction;
  const sign = direction === "up" ? 1 : -1;
  const ref = s.spot;
  const target = s.kingStrike;
  // El imán tiene que estar en la dirección del trade (arriba si up, abajo si down).
  if (sign > 0 && !(target > ref)) return null;
  if (sign < 0 && !(target < ref)) return null;
  const trigger = ref * (1 + (sign * INTRADAY_TRIGGER_PCT) / 100);
  const stop = ref - sign * Math.abs(target - ref) * INTRADAY_STOP_FRACTION;
  if (!validPlan(direction, ref, trigger, target, stop)) return null;
  return {
    source: "intraday",
    ticker: s.ticker,
    optionType: direction === "up" ? "call" : "put",
    strike: s.strike,
    expiration: s.expiration,
    direction,
    trigger: round2(trigger),
    target: round2(target),
    stop: round2(stop),
    probability: clampProb(s.confidence),
    note: "Day Trading",
    refPrice: round2(ref),
  };
}

/** El plan es coherente si, en su dirección, objetivo va más allá del gatillo y el stop al otro lado. */
function validPlan(dir: Direction, ref: number, trigger: number, target: number, stop: number): boolean {
  if (dir === "up") return target > trigger && trigger >= ref * 0.99 && stop < ref;
  return target < trigger && trigger <= ref * 1.01 && stop > ref;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface SelectOptions {
  minProb?: number;
  /** Tickers que ya tienen un trade abierto → no se abre otro (una entrada por ticker). */
  blockedTickers?: Set<string>;
}

/**
 * Filtra y ordena candidatos: descarta bajo umbral, respeta "una entrada por ticker"
 * (gana el de mayor probabilidad) y salta los tickers ya ocupados. El intradía rompe
 * empates sobre el swing a igualdad de probabilidad (señal más fresca).
 */
export function selectCandidates(cands: Candidate[], opts: SelectOptions = {}): Candidate[] {
  const minProb = opts.minProb ?? MIN_PROB;
  const blocked = opts.blockedTickers ?? new Set<string>();
  const ranked = [...cands]
    .filter((c) => c.probability >= minProb)
    .sort((a, b) => b.probability - a.probability || (a.source === "intraday" ? -1 : 1));
  const taken = new Set<string>(blocked);
  const out: Candidate[] = [];
  for (const c of ranked) {
    if (taken.has(c.ticker)) continue;
    taken.add(c.ticker);
    out.push(c);
  }
  return out;
}
