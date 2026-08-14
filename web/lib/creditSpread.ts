// Motor del escáner de Credit Spreads — VENTA DE PRIMA (weekly del frente, 4–7 DTE
// — el vencimiento más cercano en esa banda). Traducción a código del documento
// del operador CREDIT SPREADS.txt (reafinado ago 2026 desde el perfil institucional
// anterior al perfil de venta de prima que de verdad opera el dueño).
//
// PURO — no toca red ni disco. La ruta SSE orquesta el I/O (MarketSnack chain +
// bars + niveles + earnings + macro) y llama aquí para DECIDIR.
//
// Filosofía de VENTA DE PRIMA (el edge NO es la alta tasa de acierto, sino vender
// prima cara lejos del dinero y GESTIONAR activamente): la DELTA es el selector
// principal. Se busca cobrar prima con ~85–90% de probabilidad de expirar sin valor
// y tomar ganancias temprano. Los rieles de LIQUIDEZ y ESTRUCTURA (OI, bid-ask,
// crédito>0, ancho, sizing) siguen siendo DUROS —son seguridad, no criterio— pero
// los filtros de CONTEXTO (1σ estricto, soporte/resistencia guardián, tendencia,
// macro) se degradan a AVISO en modo experto para que el dueño vea el candidato y
// decida él (petición explícita del operador). En modo seguro (estudiantes) siguen
// bloqueando.
//
// Criterio (doc CREDIT SPREADS.txt):
//   · Delta corto 0.10–0.15 (objetivo ~0.12). En 4–7 DTE, 0.30 es "demasiado riesgoso".
//   · Lado según sesgo: alcista → put credit spread · bajista → call credit spread.
//     La tendencia del precio (SMA20/50) CONFIRMA en modo seguro; en experto avisa.
//   · IV Rank / Percentile > 40–50 → SOLO etiqueta informativa (no descarta).
//   · Toma de ganancias al 50% del máximo; stop a 2.5× el crédito; roll por gamma.
//   · Buena liquidez: alto volumen, OI alto, bid-ask estrecho (elegibilidad + pata).
//
// Diferencias críticas vs. Wheel (no copiar a ciegas):
//   · El crédito se calcula sobre el MID, no sobre el bid con haircut.
//   · Son DOS patas emparejadas por ancho adaptativo $1–$5 (el más estrecho del grid).
//   · El delta es el REAL de MarketSnack (el prompt prohíbe estimarlo).
//   · No hay regla de crédito% por delta: la delta baja y el 1σ hacen ese trabajo.

import { expectedMove } from "./expectedMove";
import { realizedVolSeries, rankWithin } from "./ivcontext";
import type { EarningsFlag } from "./wheel";
import type { MacroEvent, MacroEventKind } from "./macroCalendar";

const MULTIPLIER = 100;

// ── Umbrales de elegibilidad (liquidez del subyacente/cadena) ────────────
// VENTA DE PRIMA: elegibilidad SUAVE. Ya NO se gatea por volumen del subyacente
// (excluía blue-chips) ni por OI total de cadena (un solo weekly rara vez llega a
// 10k). La liquidez real se juzga en la pata corta (ver MIN_LEG_OI). Se conservan
// cap (solo acciones), precio y volumen de opciones del día como criba mínima.
export const MIN_MARKET_CAP = 10_000_000_000; // $10B (no aplica a ETFs de índice)
export const MIN_PRICE = 30; // $30
export const MIN_CHAIN_VOLUME = 2_000; // contratos del día
// Bid-ask típico como FRACCIÓN del mid (no absoluto). Con datos de MarketSnack
// el spread absoluto de $0.05 rechazaba TODO el universo: en opciones baratas
// (deep-OTM) un spread de $0.06 es normal aunque sea >20% del mid, y en nombres
// caros $0.05 es imposible. La verdadera protección de edge sigue siendo el
// tope del 30% del crédito (MAX_SPREAD_CONSUMES_CREDIT). Aquí solo descartamos
// spreads groseramente anchos relativos al precio de la opción (≤25% del mid).
// Se midió a 0.20 y rechazaba megacaps líquidos (MSFT/AAPL/META en 22–24%) que
// solo se ven anchos porque esta muestra es deep-OTM (Δ0.10–0.19); a 0.25 pasan
// al juicio real, donde el bid-ask por pata (≤20%) y el tope del 30% del crédito
// —sobre los strikes que de verdad se operan— siguen filtrando la iliquidez.
export const MAX_TYPICAL_SPREAD_PCT = 0.25; // bid-ask típico ≤25% del mid
// Banda de delta donde se MIDE el bid-ask típico de elegibilidad. Se fija en
// Δ 0.10–0.19 (opciones lejanas y baratas, donde el mercado cotiza en centavos y
// el bid-ask relativo es representativo de la liquidez de la cadena). Coincide
// casi con la banda del strike corto de venta de prima (0.10–0.15); se mantiene
// hasta 0.19 para no medir con una sola muestra cuando el grid es escaso.
export const ELIG_SPREAD_DELTA_MIN = 0.10;
export const ELIG_SPREAD_DELTA_MAX = 0.19;

// ── Umbrales de selección/liquidez de contrato ──────────────────────────
// VENTA DE PRIMA (doc CREDIT SPREADS.txt): la DELTA es el selector principal y el
// objetivo es vender LEJOS del dinero, ~0.12, con banda 0.10–0.15. El doc es
// explícito: en semanales (4–7 DTE) una delta de 0.30 es "demasiado riesgosa"
// porque un movimiento pequeño mete el corto ITM. A delta ≤0.15 la probabilidad
// teórica de expirar sin valor ronda el 85–90%. Antes esta banda era 0.15–0.30
// (perfil institucional cerca del dinero) y, combinada con el filtro 1σ, se
// contradecía sola: un corto de 0.20–0.30 cae DENTRO de 1σ y el 1σ lo descartaba,
// así que el escáner casi nunca surtía los contratos de prima que pide el operador.
export const SHORT_DELTA_MIN = 0.10;
export const SHORT_DELTA_MAX = 0.15; // INCLUSIVO (venta de prima: banda 0.10–0.15)
export const SHORT_DELTA_TARGET = 0.12; // objetivo del doc (selector principal)
export const ELEVATED_DELTA = 0.14; // etiqueta ⚠ cerca del tope de la banda
export const LONG_DELTA_MIN = 0.02;
export const LONG_DELTA_MAX = 0.05;
// Ancho ADAPTATIVO al grid de strikes del subyacente (ago 2026). Antes el ancho
// era una banda RÍGIDA $1–$2; pero los subyacentes caros del universo (NVDA ~$220,
// MSFT ~$500, AMZN…) tienen los strikes OTM espaciados a $2.50 o $5, así que un
// spread de $1–$2 es geométricamente IMPOSIBLE de armar y el escáner descartaba
// ~78% de las patas cortas por "sin pata larga en el ancho" (medido ago 2026, no
// por 1σ ni macro). La regla real que pedía el operador es "el spread MÁS CEÑIDO":
// `pickLongLeg` elige la pata larga del strike OTM más CERCANO (ancho mínimo), y el
// techo sube a $5 solo para admitir el paso de grid más ancho ($5). En un nombre con
// grid de $1 sigue saliendo un spread de $1; el techo nunca fuerza un spread ancho,
// solo evita que un hueco de strikes arme algo absurdo. El riesgo por contrato sigue
// acotado aguas abajo por el sizing (2–3% del capital) del cliente.
export const WIDTH_MIN = 1.0;
export const WIDTH_MAX = 5.0;
// VENTA DE PRIMA (modelo del bot del operador): la liquidez se juzga en la PATA CORTA
// —la que vendes, donde importa el fill—, no en ambas. La pata larga es protección
// deep-OTM (Δ0.02–0.05) barata y naturalmente ilíquida: solo se le exige cotización
// válida. Antes se exigía OI≥500 y bid-ask≤20% en AMBAS patas, y la larga ilíquida
// mataba casi todos los spreads far-OTM (la queja del operador: "no me encuentra prima").
export const MAX_LEG_SPREAD_PCT = 0.20; // bid-ask de la PATA CORTA ≤20% del mid
export const MIN_LEG_OI = 250; // OI mínimo de la PATA CORTA (valor del bot Venta Prima)
export const MAX_SPREAD_CONSUMES_CREDIT = 0.30; // bid-ask de la CORTA / crédito
const EPS = 1e-6;

// ── Niveles (soporte/resistencia) ────────────────────────────────────────
// Un nivel "importante" pesa ≥35/100 en findLevels (mismo umbral que dibuja
// ProWallsCard). El strike corto debe quedar del lado protegido de uno de ellos.
export const MIN_LEVEL_STRENGTH = 35;

// ── IV Rank (solo etiqueta) ──────────────────────────────────────────────
// El operador quiere IV Rank/Percentile > 40–50. NO descarta: se muestra en la
// ficha y se marca cuando queda por debajo de este piso.
export const IV_RANK_LABEL_MIN = 40;

// ── Tendencia (SMA rápida/lenta sobre cierres diarios) ───────────────────
export const TREND_SMA_FAST = 20;
export const TREND_SMA_SLOW = 50;

// ── Ventana de vencimiento (weekly del frente) ───────────────────────────
// VENTA DE PRIMA: el doc CREDIT SPREADS.txt centra la estrategia en el semanal
// 4–7 DTE (rota capital rápido, decaimiento theta acelerado de mié→vie, gestión
// activa). Se toma el weekly MÁS CERCANO dentro de [4,7] DTE: evita el 0–3 DTE
// (zona gamma pura) y el 8+ (ya no es el decaimiento acelerado que busca el doc).
export const DTE_MIN = 4;
export const DTE_MAX = 7;

// ── Macro (Filtro 3) ──────────────────────────────────────────────────────
// Eventos macro DUROS: pueden cambiar el RÉGIMEN del subyacente (la Fed marca
// tendencia, el IPC/PCE repricean la curva de tasas) → descarte eliminatorio.
// El NFP es BLANDO: mueve el precio un día y suele revertir, así que NO descarta
// — se adjunta al candidato como aviso (mismo patrón de etiqueta que ivRankLow /
// elevatedDelta: se hace visible en vez de eliminatorio y el operador decide).
export const HARD_MACRO_KINDS: MacroEventKind[] = ["FOMC", "CPI", "PCE"];
export function isHardMacro(e: MacroEvent): boolean {
  return HARD_MACRO_KINDS.includes(e.kind);
}

// ── Gestión (reglas de oro del doc para 4–7 DTE) ──────────────────────────
// Toma de ganancias TEMPRANA al 50% del beneficio máximo: en semanales el
// decaimiento es muy rápido y exprimir el último 10–20% expone a riesgo gamma
// desproporcionado (el doc lo prohíbe explícitamente). Antes estaba en 85%, que
// hacía justo lo contrario. Stop estricto a 2.5× el crédito. Alerta de gamma /
// roll cuando el delta del corto supera 0.40 cerca del vencimiento.
export const TAKE_PROFIT_PCT = 0.50; // cerrar al 50% del beneficio máximo
export const STOP_LOSS_MULT = 2.5; // stop a 2.5× el crédito
export const DELTA_ROLL_ALERT = 0.40; // rolar/cerrar si Δ corto supera esto (gamma)
export const GAMMA_ALERT_DTE = 2; // 0–2 DTE = zona gamma

export type Bias = "alcista" | "bajista" | "neutral";
export type SpreadType = "put" | "call"; // Put Credit Spread / Call Credit Spread
export type Trend = "alcista" | "bajista" | "lateral";

/** Fila de cadena normalizada desde MarketSnack (delta/IV reales). */
export interface SpreadQuote {
  strike: number;
  type: "call" | "put";
  expiration: string; // YYYY-MM-DD
  dte: number;
  bid: number | null;
  ask: number | null;
  /** Delta REAL con signo (calls +, puts −). null si la fuente no lo dio. */
  delta: number | null;
  /** IV decimal (ya convertida de %). */
  iv: number | null;
  openInterest: number;
  volume: number;
}

/** Soporte o resistencia relevante (subconjunto de Level de lib/levels.ts). */
export interface SpreadLevel {
  price: number;
  strength: number; // 0-100
}

// ── PURO: helpers ──────────────────────────────────────────────────────

/** Precio medio. null si falta un lado o el bid supera al ask. */
export function mid(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || bid < 0 || ask <= 0 || ask < bid) return null;
  return (bid + ask) / 2;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sma(xs: number[], n: number): number | null {
  if (xs.length < n) return null;
  const slice = xs.slice(xs.length - n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

/**
 * Tendencia del subyacente a partir de los cierres diarios. Clara alcista =
 * precio > SMA20 > SMA50; clara bajista = precio < SMA20 < SMA50; cualquier otra
 * cosa (o falta de historia) es "lateral" → sin tendencia clara para operar.
 */
export function detectTrend(closes: number[]): Trend {
  const price = closes.length ? closes[closes.length - 1] : null;
  const fast = sma(closes, TREND_SMA_FAST);
  const slow = sma(closes, TREND_SMA_SLOW);
  if (price == null || fast == null || slow == null) return "lateral";
  if (price > fast && fast > slow) return "alcista";
  if (price < fast && fast < slow) return "bajista";
  return "lateral";
}

/** IV Rank aproximado por volatilidad realizada (proxy, solo etiqueta). */
export function ivRankProxy(closes: number[]): number | null {
  const rv = realizedVolSeries(closes);
  if (rv.length < 2) return null;
  return rankWithin(rv, rv[rv.length - 1]);
}

/**
 * Nivel importante que PROTEGE al strike corto, o null si no hay ninguno:
 *   · put  → soporte fuerte POR ENCIMA del strike corto (strike debajo del soporte);
 *   · call → resistencia fuerte POR DEBAJO del strike corto (strike sobre la resistencia).
 * Devuelve el más cercano al strike (el que primero "aguanta" el precio).
 */
export function guardingLevel(
  type: SpreadType,
  shortStrike: number,
  supports: SpreadLevel[],
  resistances: SpreadLevel[],
): SpreadLevel | null {
  if (type === "put") {
    const guards = supports.filter(
      (l) => l.strength >= MIN_LEVEL_STRENGTH && l.price > shortStrike + EPS,
    );
    return guards.length ? guards.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  }
  const guards = resistances.filter(
    (l) => l.strength >= MIN_LEVEL_STRENGTH && l.price < shortStrike - EPS,
  );
  return guards.length ? guards.reduce((a, b) => (b.price > a.price ? b : a)) : null;
}

// ── PURO: elegibilidad del subyacente ────────────────────────────────────

export interface EligibilityInput {
  isEtf: boolean;
  marketCap: number | null;
  avgVolume20d: number | null;
  spot: number;
  hasWeeklies: boolean;
  chainOpenInterest: number; // OI total de la cadena en el vencimiento
  chainVolume: number; // volumen de opciones del día en la cadena
  /** bid-ask típico como fracción del mid (mediana) en strikes de Δ 0.10–0.19. null si no hay ninguno. */
  typicalSpreadPctAtDelta: number | null;
}

export interface EligibilityResult {
  ok: boolean;
  fails: string[];
}

export function eligibility(input: EligibilityInput): EligibilityResult {
  const fails: string[] = [];
  // VENTA DE PRIMA (modelo del bot del operador): elegibilidad SUAVE. La liquidez de
  // verdad se juzga en la PATA CORTA (buildStructure). Aquí solo se descartan nombres
  // groseramente ilíquidos. Los ETFs de índice amplio (SPY/QQQ/IWM) NO gatean por
  // market cap (su "cap" no es comparable) — son líquidos por construcción. Ya NO se
  // exige OI total de cadena ≥10k (al mirar un solo vencimiento semanal, casi ningún
  // nombre lo alcanza) ni volumen del subyacente ≥5M (excluía blue-chips de calidad).
  if (!input.isEtf && (input.marketCap == null || input.marketCap < MIN_MARKET_CAP))
    fails.push(`Cap. de mercado ${fmtB(input.marketCap)} < $10B`);
  if (!(input.spot >= MIN_PRICE)) fails.push(`Precio $${input.spot.toFixed(2)} < $30`);
  if (!input.hasWeeklies) fails.push("Sin vencimiento semanal 4–7 DTE");
  if (input.chainVolume < MIN_CHAIN_VOLUME)
    fails.push(`Volumen de opciones ${Math.round(input.chainVolume)} < 2,000`);
  if (input.typicalSpreadPctAtDelta == null)
    fails.push("Sin strikes en Δ 0.10–0.19 para medir bid-ask");
  else if (input.typicalSpreadPctAtDelta > MAX_TYPICAL_SPREAD_PCT + EPS)
    fails.push(
      `Bid-Ask típico ${(input.typicalSpreadPctAtDelta * 100).toFixed(0)}% del mid > ${(MAX_TYPICAL_SPREAD_PCT * 100).toFixed(0)}%`,
    );
  return { ok: fails.length === 0, fails };
}

function fmtB(n: number | null): string {
  return n == null ? "n/d" : `$${(n / 1e9).toFixed(1)}B`;
}

// ── PURO: tipos de salida (fichas 9-B) ───────────────────────────────────

export interface SpreadLeg {
  strike: number;
  delta: number; // con signo
  absDelta: number;
  bid: number;
  ask: number;
  mid: number;
  openInterest: number;
  volume: number;
  spreadAbs: number; // ask − bid
}

export interface SpreadEconomics {
  width: number;
  credit: number; // por acción (mid corto − mid largo)
  creditPct: number; // credit / width × 100 (informativo)
  maxRisk: number; // por contrato, $ = (width − credit) × 100
  breakeven: number; // precio del subyacente
  distanceToBreakevenPct: number;
  expectedMovePct: number; // 1σ semanal en %
  shortOutside1Sigma: boolean;
}

export interface SpreadStats {
  probOtmPct: number; // (1 − |Δ corto|) × 100
  breakevenHitRatePct: number; // (1 − credit/width) × 100
  marginOverBreakevenPts: number; // probOtm − hitRate (puntos)
  elevatedDelta: boolean; // |Δ corto| > 0.14 (tope de la banda 0.10–0.15)
}

export interface SpreadManagement {
  takeProfitGain: number; // $ por contrato al 50% del beneficio máximo
  stopLossLoss: number; // $ por contrato (2.5× crédito)
  gammaAlert: boolean; // dte ≤ 2
  deltaRollAlert: number; // 0.40
  riskPerContract: number; // = maxRisk
}

/** El soporte (put) o resistencia (call) que respalda el strike corto. */
export interface SpreadGuard {
  price: number;
  strength: number;
  distancePct: number; // del strike corto al nivel, en %
}

export interface SpreadCandidate {
  ticker: string;
  sector: string;
  type: SpreadType;
  spot: number;
  expiration: string;
  dte: number;
  iv: number; // decimal usada para 1σ
  shortLeg: SpreadLeg;
  longLeg: SpreadLeg;
  economics: SpreadEconomics;
  stats: SpreadStats;
  management: SpreadManagement;
  /** El delta de la pata larga cayó en el rango objetivo 0.02–0.05. */
  longDeltaInBand: boolean;
  /** IV Rank (proxy 0-100). Solo etiqueta: null si no hay historia. */
  ivRank: number | null;
  /** true si el IV Rank quedó por debajo del piso preferido (>40). */
  ivRankLow: boolean;
  /**
   * Soporte/resistencia que protege el strike corto. Normalmente es un filtro DURO
   * (nunca null), pero en MODO EXPERTO un candidato sin nivel guardián se muestra
   * con guard=null y un aviso en `warnings` en vez de descartarse.
   */
  guard: SpreadGuard | null;
  /** Eventos macro BLANDOS (NFP) dentro de la ventana: avisan, no descartan. */
  softMacroEvents: MacroEvent[];
  /**
   * Avisos de MODO EXPERTO: filtros de CONTEXTO (macro, tendencia, nivel guardián,
   * 1σ estricto) que habrían descartado el candidato pero se degradaron a etiqueta
   * visible porque el operador pidió ver todo y decidir él. Vacío en modo seguro.
   */
  warnings: string[];
}

export type SpreadStatus = "candidato" | "descartado" | "no_elegible" | "sin_candidatos";

export interface SpreadScan {
  ticker: string;
  sector: string;
  status: SpreadStatus;
  /** Motivo para la tabla resumen (9-A). null si es candidato. */
  reason: string | null;
  eligibilityFails: string[];
  candidates: SpreadCandidate[];
  /** Tendencia detectada del subyacente. */
  trend: Trend;
}

export interface CreditSpreadInput {
  ticker: string;
  sector: string;
  bias: Bias;
  spot: number;
  isEtf: boolean;
  marketCap: number | null;
  avgVolume20d: number | null;
  /** Cadena completa (calls + puts) ya descargada de MarketSnack. */
  quotes: SpreadQuote[];
  /** Cierres diarios del subyacente (≈1 año) para tendencia + IV Rank proxy. */
  closes: number[];
  /** Soportes (findLevels), para respaldar el strike corto de los put spreads. */
  supports: SpreadLevel[];
  /** Resistencias (findLevels), para respaldar el strike corto de los call spreads. */
  resistances: SpreadLevel[];
  /** Estado de earnings dentro del vencimiento (estimador de earningsForTicker). */
  earnings: EarningsFlag;
  /** Eventos macro DENTRO de la ventana del trade (ya filtrados por la ruta). */
  macroEvents: MacroEvent[];
  /**
   * MODO EXPERTO (petición del operador): degrada los filtros de CONTEXTO
   * — macro (FOMC/CPI/PCE), tendencia, nivel guardián y 1σ estricto — de descarte
   * a AVISO visible en el candidato, para que el dueño (que opera venta de prima de
   * verdad) vea el contrato y decida él. Deja intactas la banda 4–7 DTE, la delta
   * 0.10–0.15 y toda la validación de liquidez/estructura (esos son seguridad, no
   * contexto). Sin él (modo seguro/estudiantes), esos filtros bloquean.
   */
  expert?: boolean;
}

// ── PURO: selección de patas y armado de estructura ──────────────────────

/** IV del strike más cercano al spot dentro de una lista, como proxy de "la IV de la cadena". */
function atmIv(rows: SpreadQuote[], spot: number): number | null {
  const withIv = rows.filter((r) => r.iv != null && r.iv > 0);
  if (withIv.length === 0) return null;
  const best = withIv.reduce((a, b) =>
    Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a,
  );
  return best.iv;
}

function toLeg(q: SpreadQuote, m: number): SpreadLeg {
  const bid = q.bid ?? 0;
  const ask = q.ask ?? 0;
  return {
    strike: q.strike,
    delta: q.delta ?? 0,
    absDelta: Math.abs(q.delta ?? 0),
    bid,
    ask,
    mid: m,
    openInterest: q.openInterest,
    volume: q.volume,
    spreadAbs: ask - bid,
  };
}

/**
 * Elige la pata larga: mismo tipo, más OTM que la corta, ancho dentro de
 * [WIDTH_MIN, WIDTH_MAX]. ADAPTATIVO al grid: prefiere el spread MÁS ESTRECHO
 * posible (la pata OTM más cercana), que es el riesgo definido mínimo para ese
 * subyacente. A igualdad de ancho, desempata por el delta largo objetivo 0.02–0.05
 * (cercanía al punto medio 0.035 → protección barata). Así un nombre con grid de $1
 * arma un spread de $1 y uno con grid de $5 arma el de $5 (el más ceñido que existe),
 * sin que el techo fuerce nunca un spread más ancho de lo necesario.
 */
function pickLongLeg(
  type: SpreadType,
  shortStrike: number,
  candidates: SpreadQuote[],
): SpreadQuote | null {
  const moreOtm = candidates
    .map((q) => ({
      q,
      width: type === "put" ? shortStrike - q.strike : q.strike - shortStrike,
    }))
    .filter(
      ({ q, width }) =>
        q.type === type &&
        width >= WIDTH_MIN - EPS &&
        width <= WIDTH_MAX + EPS &&
        mid(q.bid, q.ask) != null,
    );
  if (moreOtm.length === 0) return null;
  const IDEAL = (LONG_DELTA_MIN + LONG_DELTA_MAX) / 2; // 0.035
  return moreOtm.reduce((best, cur) => {
    // Ancho mínimo manda; a igualdad (±$0.01), el delta más cercano al objetivo.
    if (cur.width < best.width - 0.01) return cur;
    if (cur.width > best.width + 0.01) return best;
    return Math.abs(Math.abs(cur.q.delta ?? 0) - IDEAL) <
      Math.abs(Math.abs(best.q.delta ?? 0) - IDEAL)
      ? cur
      : best;
  }).q;
}

/**
 * Arma y VALIDA una estructura para una pata corta dada. Devuelve el candidato
 * si pasa TODOS los filtros de estructura (delta corto en banda, crédito > 0,
 * 1σ, soporte/resistencia que respalda el strike, liquidez de contrato). null si
 * falla (la causa agregada la resume el llamador).
 */
export function buildStructure(input: {
  ticker: string;
  sector: string;
  type: SpreadType;
  spot: number;
  short: SpreadQuote;
  chain: SpreadQuote[];
  chainIvFallback: number | null;
  supports: SpreadLevel[];
  resistances: SpreadLevel[];
  ivRank: number | null;
  softMacroEvents?: MacroEvent[];
  /** Modo experto: el nivel guardián ausente avisa en vez de descartar. */
  expert?: boolean;
  /** Avisos a nivel escaneo (macro/tendencia degradados) que hereda el candidato. */
  baseWarnings?: string[];
}): SpreadCandidate | null {
  const { ticker, sector, type, spot, short } = input;

  const absDeltaShort = Math.abs(short.delta ?? 0);
  // Banda de delta corta 0.10–0.15 (inclusiva; venta de prima).
  if (absDeltaShort < SHORT_DELTA_MIN - EPS || absDeltaShort > SHORT_DELTA_MAX + EPS) return null;

  const shortMid = mid(short.bid, short.ask);
  if (shortMid == null) return null;

  const longQ = pickLongLeg(type, short.strike, input.chain.filter((q) => q.expiration === short.expiration));
  if (!longQ) return null;
  const longMid = mid(longQ.bid, longQ.ask);
  if (longMid == null) return null;

  const width = type === "put" ? short.strike - longQ.strike : longQ.strike - short.strike;
  if (!(width >= WIDTH_MIN - EPS && width <= WIDTH_MAX + EPS)) return null;

  const credit = shortMid - longMid;
  if (!(credit > 0)) return null; // tiene que ser un crédito real
  const creditPct = (credit / width) * 100;

  // Liquidez de contrato — centrada en la PATA CORTA (venta de prima). La pata larga
  // ya pasó el único filtro que se le exige: cotización válida (mid != null, arriba).
  const shortLeg = toLeg(short, shortMid);
  const longLeg = toLeg(longQ, longMid);
  if (!(shortLeg.bid > 0)) return null; // bid>0 en la corta (hay prima real que cobrar)
  // Bid-ask de la CORTA ≤20% del mid (relativo, no absoluto).
  const shortLegRel = shortLeg.mid > 0 ? shortLeg.spreadAbs / shortLeg.mid : Infinity;
  if (shortLegRel > MAX_LEG_SPREAD_PCT + EPS) return null;
  if (shortLeg.openInterest < MIN_LEG_OI) return null; // OI≥250 en la corta
  if (!(shortLeg.volume > 0)) return null; // volumen del día en la corta
  // El bid-ask de la CORTA no puede comerse >30% del crédito (protección de edge en
  // la pata que operas; la larga es protección barata, no entra en este tope).
  if (shortLeg.spreadAbs > MAX_SPREAD_CONSUMES_CREDIT * credit + EPS) return null;

  // Avisos que hereda el candidato (macro/tendencia degradados a nivel escaneo) +
  // los que se acumulen aquí (1σ, guardián) cuando el modo experto los degrada.
  const warnings = [...(input.baseWarnings ?? [])];

  // Validación de distancia 1σ, independiente del delta. Filtro de CONTEXTO: en
  // modo seguro descarta; en experto avisa (a delta 0.10–0.15 el corto casi siempre
  // queda fuera de 1σ, pero con IV baja puede caer dentro y el dueño quiere verlo).
  const iv = short.iv ?? input.chainIvFallback;
  if (iv == null || !(iv > 0)) return null; // sin IV real no se valida → descartar
  const em = expectedMove(spot, iv, short.dte);
  const shortOutside1Sigma =
    type === "put" ? short.strike < em.lower1 : short.strike > em.upper1;
  if (!shortOutside1Sigma) {
    if (!input.expert) return null;
    warnings.push("Strike corto DENTRO de 1σ del movimiento esperado");
  }

  // Soporte/resistencia (filtro de CONTEXTO): put por debajo de un soporte importante,
  // call por encima de una resistencia importante. En modo experto la ausencia de
  // nivel guardián avisa en vez de descartar.
  const guardLevel = guardingLevel(type, short.strike, input.supports, input.resistances);
  if (!guardLevel) {
    if (!input.expert) return null;
    warnings.push(
      type === "put"
        ? "Sin soporte fuerte por encima del strike corto"
        : "Sin resistencia fuerte por debajo del strike corto",
    );
  }

  // Economía.
  const maxRisk = (width - credit) * MULTIPLIER;
  const breakeven = type === "put" ? short.strike - credit : short.strike + credit;
  const distanceToBreakevenPct = spot > 0 ? (Math.abs(spot - breakeven) / spot) * 100 : 0;

  // Realidad estadística.
  const probOtmPct = (1 - absDeltaShort) * 100;
  const breakevenHitRatePct = (1 - credit / width) * 100;
  const marginOverBreakevenPts = probOtmPct - breakevenHitRatePct;

  // Gestión.
  const management: SpreadManagement = {
    takeProfitGain: credit * TAKE_PROFIT_PCT * MULTIPLIER,
    stopLossLoss: credit * STOP_LOSS_MULT * MULTIPLIER,
    gammaAlert: short.dte <= GAMMA_ALERT_DTE,
    deltaRollAlert: DELTA_ROLL_ALERT,
    riskPerContract: maxRisk,
  };

  return {
    ticker,
    sector,
    type,
    spot,
    expiration: short.expiration,
    dte: short.dte,
    iv,
    shortLeg,
    longLeg,
    economics: {
      width,
      credit,
      creditPct,
      maxRisk,
      breakeven,
      distanceToBreakevenPct,
      expectedMovePct: em.sigmaPct,
      shortOutside1Sigma,
    },
    stats: {
      probOtmPct,
      breakevenHitRatePct,
      marginOverBreakevenPts,
      elevatedDelta: absDeltaShort > ELEVATED_DELTA + EPS,
    },
    management,
    longDeltaInBand:
      longLeg.absDelta >= LONG_DELTA_MIN - EPS && longLeg.absDelta <= LONG_DELTA_MAX + EPS,
    ivRank: input.ivRank,
    ivRankLow: input.ivRank != null && input.ivRank < IV_RANK_LABEL_MIN,
    guard: guardLevel
      ? {
          price: guardLevel.price,
          strength: guardLevel.strength,
          distancePct: Math.abs((guardLevel.price - short.strike) / short.strike) * 100,
        }
      : null,
    softMacroEvents: input.softMacroEvents ?? [],
    warnings,
  };
}

// ── PURO: escaneo completo de un ticker (filtros en orden) ───────────────

function typesForBias(bias: Bias): SpreadType[] {
  if (bias === "alcista") return ["put"]; // put credit spread
  if (bias === "bajista") return ["call"]; // call credit spread
  return ["put", "call"]; // neutral: ambos
}

/** La tendencia clara habilita un solo tipo; "lateral" no habilita ninguno. */
function typesForTrend(trend: Trend): SpreadType[] {
  if (trend === "alcista") return ["put"];
  if (trend === "bajista") return ["call"];
  return [];
}

/**
 * Escanea un ticker aplicando los filtros eliminatorios EN ORDEN y, si sobrevive,
 * arma las estructuras válidas. Corta en el primer filtro que falla.
 */
export function creditSpreadCandidates(input: CreditSpreadInput): SpreadScan {
  const trend = detectTrend(input.closes);
  const base = {
    ticker: input.ticker,
    sector: input.sector,
    eligibilityFails: [] as string[],
    candidates: [] as SpreadCandidate[],
    trend,
  };

  // Filtro 0 — Instrumento: en venta de prima los ETFs de índice amplio (SPY/QQQ/IWM)
  // SÍ se permiten (son el vehículo estándar). El universo curado ya acota qué ETFs
  // entran; la elegibilidad no gatea a los ETFs por market cap.

  // Weekly del frente: el vencimiento MÁS CERCANO con DTE en [4,7]. La ventana
  // es un único vencimiento (el más próximo), no todo el rango.
  const inBand = input.quotes.filter((q) => q.dte >= DTE_MIN && q.dte <= DTE_MAX);
  const targetDte = inBand.length > 0 ? Math.min(...inBand.map((q) => q.dte)) : null;
  const window = targetDte != null ? inBand.filter((q) => q.dte === targetDte) : [];
  const hasWeeklies = window.length > 0;

  // Filtro 1 — Elegibilidad (liquidez del subyacente/cadena). El bid-ask típico
  // se mide en la banda Δ 0.10–0.19 del mandato (§3), no en la del strike corto.
  const bandRows = window.filter((q) => {
    const d = Math.abs(q.delta ?? 0);
    return d >= ELIG_SPREAD_DELTA_MIN - EPS && d <= ELIG_SPREAD_DELTA_MAX + EPS && q.bid != null && q.ask != null;
  });
  // Bid-ask relativo al mid, no absoluto: (ask − bid) / mid por strike.
  const bandRelSpreads = bandRows
    .map((q) => {
      const m = mid(q.bid, q.ask);
      return m != null && m > 0 ? ((q.ask ?? 0) - (q.bid ?? 0)) / m : null;
    })
    .filter((x): x is number => x != null);
  const typicalSpreadPctAtDelta = bandRelSpreads.length ? median(bandRelSpreads) : null;
  const elig = eligibility({
    isEtf: input.isEtf,
    marketCap: input.marketCap,
    avgVolume20d: input.avgVolume20d,
    spot: input.spot,
    hasWeeklies,
    chainOpenInterest: window.reduce((s, q) => s + q.openInterest, 0),
    chainVolume: window.reduce((s, q) => s + q.volume, 0),
    typicalSpreadPctAtDelta,
  });
  if (!elig.ok) {
    return {
      ...base,
      status: "no_elegible",
      reason: elig.fails[0] ?? "No elegible",
      eligibilityFails: elig.fails,
    };
  }

  // Filtro 2 — Earnings: reporte dentro de la vida del spread → DESCARTAR.
  if (input.earnings === "dentro" || input.earnings === "dentro_confirmado") {
    return { ...base, status: "descartado", reason: "Earnings dentro de la ventana" };
  }

  // Avisos de modo experto que heredan todos los candidatos de este ticker.
  const expertWarnings: string[] = [];

  // Filtro 3 — Macro: solo los DUROS (FOMC/CPI/PCE) descartan; el NFP es blando
  // (mueve el precio un día y suele revertir) y se adjunta como aviso al candidato.
  // En MODO EXPERTO los DUROS también degradan a aviso: el operador decide.
  const hardMacro = input.macroEvents.filter(isHardMacro);
  if (hardMacro.length > 0) {
    const kinds = [...new Set(hardMacro.map((e) => e.kind))].join(", ");
    if (!input.expert) {
      return { ...base, status: "descartado", reason: `Evento macro en la ventana (${kinds})` };
    }
    expertWarnings.push(`Evento macro DURO en la ventana (${kinds})`);
  }
  const softMacroEvents = input.macroEvents.filter((e) => !isHardMacro(e));

  // Filtro 4 — Tendencia clara que concuerde con el sesgo. El sesgo manual filtra;
  // la tendencia del precio confirma. Sin concordancia → DESCARTAR. En MODO EXPERTO
  // se cae al sesgo manual (typesForBias) con un aviso: la tendencia deja de mandar.
  const trendTypes = typesForTrend(trend);
  let allowed = typesForBias(input.bias).filter((t) => trendTypes.includes(t));
  if (allowed.length === 0) {
    const reason =
      trend === "lateral"
        ? "Sin tendencia clara (precio lateral)"
        : `Tendencia ${trend} no concuerda con el sesgo ${input.bias}`;
    if (!input.expert) {
      return { ...base, status: "descartado", reason };
    }
    allowed = typesForBias(input.bias);
    expertWarnings.push(reason);
  }

  // Estructuras (selección de patas + crédito + 1σ + soporte/resistencia + liquidez).
  const chainIvFallback = atmIv(window, input.spot);
  const ivRank = ivRankProxy(input.closes);
  const out: SpreadCandidate[] = [];
  for (const type of allowed) {
    // Candidatos de pata corta: del tipo, en banda 0.10–0.15, ordenados por delta
    // ascendente (priorizar el delta MÁS BAJO que cumpla todo).
    const shorts = window
      .filter((q) => {
        if (q.type !== type) return false;
        const d = Math.abs(q.delta ?? 0);
        return d >= SHORT_DELTA_MIN - EPS && d <= SHORT_DELTA_MAX + EPS;
      })
      .sort((a, b) => Math.abs(a.delta ?? 0) - Math.abs(b.delta ?? 0));

    for (const short of shorts) {
      const cand = buildStructure({
        ticker: input.ticker,
        sector: input.sector,
        type,
        spot: input.spot,
        short,
        chain: window,
        chainIvFallback,
        supports: input.supports,
        resistances: input.resistances,
        ivRank,
        softMacroEvents,
        expert: input.expert,
        baseWarnings: expertWarnings,
      });
      if (cand) out.push(cand);
    }
  }

  if (out.length === 0) {
    return {
      ...base,
      status: "sin_candidatos",
      reason: "Ningún strike cumple 1σ/soporte-resistencia/liquidez en la ventana",
    };
  }

  // Válidos ordenados: mayor margen sobre el equilibrio y, a igualdad, menor delta.
  out.sort((a, b) => {
    const m = b.stats.marginOverBreakevenPts - a.stats.marginOverBreakevenPts;
    if (Math.abs(m) > EPS) return m;
    return a.shortLeg.absDelta - b.shortLeg.absDelta;
  });

  return { ...base, status: "candidato", reason: null, candidates: out };
}
