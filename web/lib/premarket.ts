// ============================================================================
// Sub-agente de PRE-MARKET. TODO PURO (tests en premarket.test.ts).
//
// Corre 30 min antes de la apertura y manda por Telegram, para SPY, QQQ, SPX y
// las 7 magníficas:
//   · Medias móviles de 55 y 200 en velas de 4H (horario regular, como el 4H de
//     TradingView): dónde está el precio respecto a cada una y hacia dónde van.
//   · Notional value de las opciones: valor del subyacente que controlan los
//     contratos abiertos = open interest × 100 × precio. Calls vs puts, el neto
//     ajustado por delta y los strikes con más nocional (los "muros").
//   · Noticias que mueven mercado: calendario macro, earnings cercanos y
//     titulares con sentimiento.
//
// Las reglas de sesgo son deliberadamente simples y van escritas en el mensaje:
// esto es un resumen para decidir, no una señal de entrada.
// ============================================================================

import { sma } from "./sma";

export const PREMARKET_TICKERS = ["SPY", "QQQ", "SPX", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"] as const;
export const MAGNIFICENT_7 = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"] as const;

export const MA_FAST = 55;
export const MA_SLOW = 200;
/** Velas de 4H hacia atrás para medir la pendiente de cada media (~5 sesiones). */
export const SLOPE_LOOKBACK = 10;
/** Un cruce de medias dentro de estas velas se marca como RECIENTE. */
export const FRESH_CROSS_BARS = SLOPE_LOOKBACK;
/** Los muros se buscan a menos de este % del precio: más lejos es cobertura de cola, no un nivel. */
export const WALL_RANGE_PCT = 8;
/**
 * Voto del nocional: neto ajustado por delta ÷ nocional bruto. Se usa esto y no el
 * put/call porque los índices llevan siempre más puts (cobertura) y el P/C los
 * pintaría bajistas a diario; una put lejana de cobertura tiene delta pequeño y
 * apenas mueve el neto.
 */
export const NET_DELTA_VOTE = 0.05;

export type Trend = "alcista" | "bajista" | "mixta";
export type Bias = "alcista" | "bajista" | "neutral";

// ---------------------------------------------------------------------------
// Medias móviles 4H
// ---------------------------------------------------------------------------

export interface MaAnalysis {
  ma55: number | null;
  ma200: number | null;
  /** % del precio sobre (+) o bajo (−) cada media. */
  dist55: number | null;
  dist200: number | null;
  /** Pendiente en % contra hace SLOPE_LOOKBACK velas. */
  slope55: number | null;
  slope200: number | null;
  /** Orden de las medias: 55 sobre 200 = estructura alcista. */
  stack: "55>200" | "55<200" | null;
  /** Si las medias se cruzaron en las últimas FRESH_CROSS_BARS velas. */
  freshCross: "dorado" | "muerte" | null;
  trend: Trend;
  /** Lectura en palabras para el mensaje. */
  reading: string;
}

function pctDiff(a: number, b: number): number {
  return ((a - b) / b) * 100;
}

/** Medias de 55/200 sobre los cierres 4H (más antiguo primero) y el precio actual. */
export function maAnalysis(closes: number[], price: number): MaAnalysis {
  const ma55 = sma(closes, MA_FAST);
  const ma200 = sma(closes, MA_SLOW);
  const prev = closes.slice(0, Math.max(0, closes.length - SLOPE_LOOKBACK));
  const ma55Prev = sma(prev, MA_FAST);
  const ma200Prev = sma(prev, MA_SLOW);

  const dist55 = ma55 != null ? pctDiff(price, ma55) : null;
  const dist200 = ma200 != null ? pctDiff(price, ma200) : null;
  const slope55 = ma55 != null && ma55Prev != null ? pctDiff(ma55, ma55Prev) : null;
  const slope200 = ma200 != null && ma200Prev != null ? pctDiff(ma200, ma200Prev) : null;
  const stack = ma55 != null && ma200 != null ? (ma55 >= ma200 ? "55>200" : "55<200") : null;
  const stackPrev = ma55Prev != null && ma200Prev != null ? (ma55Prev >= ma200Prev ? "55>200" : "55<200") : null;

  let freshCross: MaAnalysis["freshCross"] = null;
  // Se compara contra hace SLOPE_LOOKBACK velas (= FRESH_CROSS_BARS).
  if (stack && stackPrev && stack !== stackPrev) {
    freshCross = stack === "55>200" ? "dorado" : "muerte";
  }

  let trend: Trend = "mixta";
  let reading: string;
  if (ma55 == null || ma200 == null) {
    reading = "sin histórico suficiente para las dos medias";
  } else if (price > ma55 && ma55 > ma200) {
    trend = "alcista";
    reading = "precio sobre MA55 y MA200, con la 55 sobre la 200: tendencia alcista";
  } else if (price < ma55 && ma55 < ma200) {
    trend = "bajista";
    reading = "precio bajo MA55 y MA200, con la 55 bajo la 200: tendencia bajista";
  } else if (price < ma55 && price > ma200) {
    reading = "retroceso: perdió la MA55 pero sigue sobre la MA200 (soporte a vigilar)";
  } else if (price > ma55 && price < ma200) {
    reading = "rebote: recuperó la MA55 pero sigue bajo la MA200 (resistencia a vigilar)";
  } else if (price > ma55 && price > ma200) {
    reading = "precio sobre ambas medias, pero la 55 aún bajo la 200: intento de giro alcista";
  } else {
    reading = "precio bajo ambas medias, pero la 55 aún sobre la 200: deterioro de la tendencia";
  }

  return { ma55, ma200, dist55, dist200, slope55, slope200, stack, freshCross, trend, reading };
}

// ---------------------------------------------------------------------------
// Notional value de las opciones
// ---------------------------------------------------------------------------

/** Lo mínimo de un contrato que hace falta para el nocional. */
export interface NotionalContract {
  strike: number;
  type: "call" | "put";
  openInterest: number;
  delta: number | null;
  volume?: number;
}

export interface StrikeNotional {
  strike: number;
  notional: number;
  openInterest: number;
}

export interface NotionalSummary {
  /** Σ OI × 100 × precio de las calls / puts. */
  callNotional: number;
  putNotional: number;
  /** puts ÷ calls. >1 = más cobertura/bajista; <1 = más apuesta alcista. */
  putCallRatio: number | null;
  /**
   * Nocional ajustado por delta (Σ OI × 100 × precio × delta): cuánto subyacente
   * equivalen de verdad las posiciones. Positivo = el posicionamiento neto es largo.
   */
  netDeltaNotional: number;
  /** Nocional NEGOCIADO la última sesión (volumen × 100 × precio), si llegó. */
  callVolumeNotional: number;
  putVolumeNotional: number;
  /** Strike de calls con más nocional por ENCIMA del precio, a ≤ WALL_RANGE_PCT (resistencia). */
  callWall: StrikeNotional | null;
  /** Strike de puts con más nocional por DEBAJO del precio, a ≤ WALL_RANGE_PCT (soporte). */
  putWall: StrikeNotional | null;
  contracts: number;
}

export function notionalSummary(contracts: NotionalContract[], spot: number): NotionalSummary {
  let callNotional = 0;
  let putNotional = 0;
  let netDeltaNotional = 0;
  let callVolumeNotional = 0;
  let putVolumeNotional = 0;
  const callsByStrike = new Map<number, number>();
  const putsByStrike = new Map<number, number>();

  for (const c of contracts) {
    const oi = Number.isFinite(c.openInterest) && c.openInterest > 0 ? c.openInterest : 0;
    const vol = c.volume != null && Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
    const notional = oi * 100 * spot;
    if (c.type === "call") {
      callNotional += notional;
      callVolumeNotional += vol * 100 * spot;
      if (c.strike > spot && c.strike <= spot * (1 + WALL_RANGE_PCT / 100)) callsByStrike.set(c.strike, (callsByStrike.get(c.strike) ?? 0) + oi);
    } else {
      putNotional += notional;
      putVolumeNotional += vol * 100 * spot;
      if (c.strike < spot && c.strike >= spot * (1 - WALL_RANGE_PCT / 100)) putsByStrike.set(c.strike, (putsByStrike.get(c.strike) ?? 0) + oi);
    }
    if (c.delta != null && Number.isFinite(c.delta)) netDeltaNotional += notional * c.delta;
  }

  const wall = (m: Map<number, number>): StrikeNotional | null => {
    let best: StrikeNotional | null = null;
    for (const [strike, oi] of m) {
      if (oi > 0 && (!best || oi > best.openInterest)) best = { strike, openInterest: oi, notional: oi * 100 * spot };
    }
    return best;
  };

  return {
    callNotional,
    putNotional,
    putCallRatio: callNotional > 0 ? putNotional / callNotional : null,
    netDeltaNotional,
    callVolumeNotional,
    putVolumeNotional,
    callWall: wall(callsByStrike),
    putWall: wall(putsByStrike),
    contracts: contracts.length,
  };
}

// ---------------------------------------------------------------------------
// Sesgo por ticker
// ---------------------------------------------------------------------------

export interface TickerInput {
  ticker: string;
  /** Precio de pre-market (o el último, si aún no cotiza). */
  price: number | null;
  prevClose: number | null;
  /** true si el precio es una estimación (SPX antes de la apertura). */
  priceImplied?: boolean;
  ma: MaAnalysis | null;
  notional: NotionalSummary | null;
  /** Sesgo de las noticias del ticker (Massive), si hubo. */
  newsBias: Bias | null;
  /** Fecha de earnings si cae en los próximos días. */
  earningsDate: string | null;
  headlines: { title: string; sentiment: string | null }[];
  errors: string[];
}

export interface TickerVerdict {
  bias: Bias;
  score: number;
  reasons: string[];
}

/**
 * Sesgo = suma de tres votos (+1 alcista / −1 bajista / 0):
 *   · Medias 4H: tendencia alcista/bajista.
 *   · Nocional: neto Δ ≥ +5% del bruto (+1) o ≤ −5% (−1).
 *   · Noticias: sesgo del ticker.
 * ≥ +2 alcista, ≤ −2 bajista; lo demás neutral. Exigir dos votos evita que una
 * sola fuente decida.
 */
export function tickerVerdict(t: TickerInput): TickerVerdict {
  let score = 0;
  const reasons: string[] = [];
  if (t.ma?.trend === "alcista") { score += 1; reasons.push("medias 4H alcistas"); }
  if (t.ma?.trend === "bajista") { score -= 1; reasons.push("medias 4H bajistas"); }
  const share = netDeltaShare(t.notional);
  if (share != null && share >= NET_DELTA_VOTE) { score += 1; reasons.push(`posicionamiento neto largo (Δ ${(share * 100).toFixed(0)}% del nocional)`); }
  if (share != null && share <= -NET_DELTA_VOTE) { score -= 1; reasons.push(`posicionamiento neto corto (Δ ${(share * 100).toFixed(0)}% del nocional)`); }
  if (t.newsBias === "alcista") { score += 1; reasons.push("noticias positivas"); }
  if (t.newsBias === "bajista") { score -= 1; reasons.push("noticias negativas"); }
  const bias: Bias = score >= 2 ? "alcista" : score <= -2 ? "bajista" : "neutral";
  return { bias, score, reasons };
}

/** Nocional neto ajustado por delta como fracción del bruto (−1..1). */
export function netDeltaShare(n: NotionalSummary | null): number | null {
  if (!n) return null;
  const gross = n.callNotional + n.putNotional;
  return gross > 0 ? n.netDeltaNotional / gross : null;
}

/** Sesgo de noticias a partir del sentimiento de Massive, ponderando igual cada titular. */
export function headlineBias(items: { sentiment: string | null }[]): Bias | null {
  let pos = 0;
  let neg = 0;
  for (const i of items) {
    if (i.sentiment === "positive") pos++;
    if (i.sentiment === "negative") neg++;
  }
  if (pos + neg === 0) return null;
  if (pos >= neg * 2 && pos >= 2) return "alcista";
  if (neg >= pos * 2 && neg >= 2) return "bajista";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Mensaje de Telegram (HTML)
// ---------------------------------------------------------------------------

export interface MacroLine {
  date: string;
  label: string;
}

export interface PremarketReport {
  /** Día de mercado ET, YYYY-MM-DD. */
  date: string;
  tickers: TickerInput[];
  vix: number | null;
  macroToday: MacroLine[];
  macroSoon: MacroLine[];
  headlines: { title: string; publisher: string }[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** $1.2B / $340M / $12K — el nocional es enorme y se lee mejor abreviado. */
export function bigMoney(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function px(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedPct(n: number | null, digits = 2): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`;
}

const BIAS_ICON: Record<Bias, string> = { alcista: "🟢", bajista: "🔴", neutral: "⚪" };

function arrow(slope: number | null): string {
  if (slope == null) return "";
  if (slope > 0.05) return "↗";
  if (slope < -0.05) return "↘";
  return "→";
}

function tickerBlock(t: TickerInput): string {
  const v = tickerVerdict(t);
  const gap = t.price != null && t.prevClose ? ((t.price - t.prevClose) / t.prevClose) * 100 : null;
  const lines: string[] = [];
  lines.push(
    `${BIAS_ICON[v.bias]} <b>${t.ticker}</b> ${px(t.price)}${t.priceImplied ? " (impl.)" : ""} · gap ${signedPct(gap)} · <b>${v.bias.toUpperCase()}</b>`,
  );

  const m = t.ma;
  if (m && m.ma55 != null && m.ma200 != null) {
    lines.push(
      `  MA55 ${px(m.ma55)} ${arrow(m.slope55)} (${signedPct(m.dist55, 1)}) · MA200 ${px(m.ma200)} ${arrow(m.slope200)} (${signedPct(m.dist200, 1)})`,
    );
    lines.push(`  ${esc(m.reading)}${m.freshCross ? ` · ⚡ cruce ${m.freshCross} reciente` : ""}`);
  } else if (m) {
    lines.push(`  Medias 4H: ${esc(m.reading)}`);
  }

  const n = t.notional;
  if (n && n.callNotional + n.putNotional > 0) {
    lines.push(
      `  Nocional OI: calls ${bigMoney(n.callNotional)} · puts ${bigMoney(n.putNotional)} · P/C ${n.putCallRatio?.toFixed(2) ?? "—"} · neto Δ ${bigMoney(n.netDeltaNotional)}`,
    );
    const walls: string[] = [];
    if (n.callWall) walls.push(`muro calls ${px(n.callWall.strike)} (${bigMoney(n.callWall.notional)})`);
    if (n.putWall) walls.push(`muro puts ${px(n.putWall.strike)} (${bigMoney(n.putWall.notional)})`);
    if (walls.length) lines.push(`  ${walls.join(" · ")}`);
    if (n.callVolumeNotional + n.putVolumeNotional > 0) {
      lines.push(`  Negociado ayer: calls ${bigMoney(n.callVolumeNotional)} · puts ${bigMoney(n.putVolumeNotional)}`);
    }
  }

  if (t.earningsDate) lines.push(`  📅 Earnings ${t.earningsDate}`);
  for (const h of t.headlines.slice(0, 2)) {
    const ico = h.sentiment === "positive" ? "➕" : h.sentiment === "negative" ? "➖" : "•";
    lines.push(`  ${ico} ${esc(h.title)}`);
  }
  if (v.reasons.length) lines.push(`  <i>Por qué: ${esc(v.reasons.join(", "))}</i>`);
  if (t.errors.length) lines.push(`  ⚠️ ${esc(t.errors.join(" · "))}`);
  return lines.join("\n");
}

export function premarketText(r: PremarketReport): string {
  const out: string[] = [];
  out.push(`🌅 <b>PRE-MARKET ${r.date}</b> — 30 min para la apertura`);

  const verdicts = r.tickers.map((t) => tickerVerdict(t).bias);
  const up = verdicts.filter((b) => b === "alcista").length;
  const down = verdicts.filter((b) => b === "bajista").length;
  const spy = r.tickers.find((t) => t.ticker === "SPY");
  const spyGap = spy?.price != null && spy.prevClose ? ((spy.price - spy.prevClose) / spy.prevClose) * 100 : null;
  out.push(
    `Amplitud: 🟢 ${up} · 🔴 ${down} · ⚪ ${r.tickers.length - up - down}` +
      ` · SPY ${signedPct(spyGap)}${r.vix != null ? ` · VIX ${r.vix.toFixed(2)}` : ""}`,
  );

  out.push("");
  out.push("<b>📰 Lo que mueve hoy</b>");
  if (r.macroToday.length) {
    for (const e of r.macroToday) out.push(`🚨 HOY: <b>${esc(e.label)}</b>`);
  } else {
    out.push("Sin CPI/NFP/PCE/FOMC hoy.");
  }
  for (const e of r.macroSoon) out.push(`📅 ${e.date}: ${esc(e.label)}`);
  const earn = r.tickers.filter((t) => t.earningsDate);
  if (earn.length) out.push(`📅 Earnings cerca: ${earn.map((t) => `${t.ticker} ${t.earningsDate}`).join(" · ")}`);
  for (const h of r.headlines.slice(0, 5)) out.push(`• ${esc(h.title)} <i>(${esc(h.publisher)})</i>`);

  out.push("");
  out.push("<b>📊 Índices</b>");
  for (const t of r.tickers.filter((x) => !(MAGNIFICENT_7 as readonly string[]).includes(x.ticker))) {
    out.push(tickerBlock(t));
  }
  out.push("");
  out.push("<b>💎 7 Magníficas</b>");
  for (const t of r.tickers.filter((x) => (MAGNIFICENT_7 as readonly string[]).includes(x.ticker))) {
    out.push(tickerBlock(t));
  }

  out.push("");
  out.push(
    "<i>Medias en velas 4H de horario regular. Nocional = open interest × 100 × precio, " +
      "vencimientos más cercanos. Sesgo = medias + nocional + noticias (hacen falta 2 votos). " +
      "Resumen informativo, no es señal de entrada.</i>",
  );
  return out.join("\n");
}
