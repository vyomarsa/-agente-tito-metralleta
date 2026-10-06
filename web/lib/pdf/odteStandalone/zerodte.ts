// ============================================================================
// Agente 0DTE — cadena del vencimiento del día, ordenada por volumen.
// Ver Agente Principal/Proceso 0DTE.md.
//
// La cadena sale de Tastytrade (./tastySource) y pasa por `toRow`; lo único propio
// es pedir UNA sola fecha de vencimiento y quedarse con los strikes de mayor
// volumen de cada lado.
// ============================================================================

import { toRow } from "./compute";
import { expectedMove, probTouch } from "./expectedMove";
import { bsCharm, bsVanna, chainIV, MAX_SANE_IV } from "./gex";
import { marketDateStr } from "./occ";
import type { Lang } from "./i18n";
import { dynamicParams, evaluateEntry, noSetupReason, riskReward, type EntryDecision } from "./zerodteStrategy";
import { pickTicket, type Ticket, type TicketChainRow } from "./zerodteTicket";
import { buildStrategySuggestions, type StrategySuggestions } from "./strategySuggestions";
import { fetchChainTasty, fetchFuturePriceTasty, TastytradeError } from "./tastySource";
import type { ContractType, Row } from "./types";
import { loadFlow, overlayRealtime, type FlowAccumulator } from "./zerodteFlow";
import { isNativeFuture, loadNativeFuture, nativeFresh, rowsFromBuckets } from "./futuresNative";

/** Cuántos strikes se toman de cada lado. */
export const TOP_N = 15;

/**
 * Futuros: no tienen cadena de opciones propia en este plan. Se analizan vía su
 * índice equivalente (opciones reales) y los NIVELES se convierten al precio del
 * futuro con el basis en vivo (basis = futuro − índice).
 *   /ES (E-mini S&P 500)   ↔ SPX
 *   /NQ (E-mini Nasdaq-100) ↔ NDX
 */
export const FUTURE_MAP: Record<string, { index: string; future: string }> = {
  "/ES": { index: "SPX", future: "/ES" },
  "/NQ": { index: "NDX", future: "/NQ" },
};

/** Resuelve un ticker (posible futuro) al índice que se analiza y el futuro. */
export function resolveTicker(ticker: string): { analysis: string; future: string | null } {
  const key = ticker.trim().toUpperCase();
  const fut = FUTURE_MAP[key];
  return fut ? { analysis: fut.index, future: fut.future } : { analysis: key, future: null };
}

/**
 * Símbolo que espera Schwab. SPX es un índice y necesita el prefijo `$`:
 * pedir `SPX` a secas responde 400 Bad Request. Los futuros (/ES) van tal cual.
 */
export function toSchwabSymbol(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  if (!t) return "";
  const INDEX = new Set(["SPX", "NDX", "RUT", "VIX", "DJX"]);
  return INDEX.has(t) ? `$${t}` : t;
}

/**
 * Fecha de HOY en hora de Nueva York, formato YYYY-MM-DD.
 *
 * No se puede derivar de UTC: a partir de las 8:00 PM ET la fecha UTC ya es la
 * del día siguiente, y "el vencimiento de hoy" es la premisa de este agente.
 * PURA: recibe el instante.
 */
export function etDate(now: Date = new Date()): string {
  return marketDateStr(now);
}

/**
 * Fechas de vencimiento seleccionables: hoy + los próximos `count` días hábiles
 * (salta sábados y domingos). PURA. SPY/QQQ/SPX tienen vencimiento cada día de
 * mercado; si un día resultara feriado, Schwab devolverá cadena vacía y la UI lo
 * marca. No cubre feriados porque no hay calendario local — es aceptable.
 */
export function expirationDates(now: Date = new Date(), count = 3): string[] {
  const out = [etDate(now)];
  // Se avanza sobre el instante en UTC pero la fecha se lee siempre en ET.
  const cursor = new Date(now.getTime());
  while (out.length <= count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const wd = new Date(`${marketDateStr(cursor)}T12:00:00Z`).getUTCDay(); // 0=dom, 6=sab
    if (wd === 0 || wd === 6) continue;
    out.push(marketDateStr(cursor));
  }
  return out;
}

/** Los N strikes con mayor volumen de un lado. PURA. */
export function topByVolume(rows: Row[], type: ContractType, n: number = TOP_N): Row[] {
  return rows
    .filter((r) => r.contractType === type)
    .sort((a, b) => b.volume - a.volume || Math.abs(a.strike) - Math.abs(b.strike))
    .slice(0, n);
}

/** Una fila de la tabla: el strike con su lado call y su lado put. */
export interface ChainLine {
  strike: number;
  call: Row | null;
  put: Row | null;
  /** Por qué entró el strike: por el ranking de calls, el de puts, o ambos. */
  from: "call" | "put" | "both";
}

/**
 * Construye la tabla con forma de option chain. PURA.
 *
 * Los dos rankings son independientes, así que la unión puede dar hasta 2N
 * strikes. El lado que no clasificó se rellena desde la cadena completa: que un
 * strike entrara por sus puts no debe dejar su columna de calls en blanco.
 */
export function buildChainTable(all: Row[], n: number = TOP_N): ChainLine[] {
  const topCalls = topByVolume(all, "call", n);
  const topPuts = topByVolume(all, "put", n);

  const callRank = new Set(topCalls.map((r) => r.strike));
  const putRank = new Set(topPuts.map((r) => r.strike));

  const byStrike = new Map<number, { call: Row | null; put: Row | null }>();
  for (const r of all) {
    if (!callRank.has(r.strike) && !putRank.has(r.strike)) continue;
    let e = byStrike.get(r.strike);
    if (!e) { e = { call: null, put: null }; byStrike.set(r.strike, e); }
    if (r.contractType === "call") e.call = r;
    else e.put = r;
  }

  return [...byStrike.entries()]
    .map(([strike, e]) => ({
      strike,
      call: e.call,
      put: e.put,
      from: (callRank.has(strike) && putRank.has(strike)
        ? "both"
        : callRank.has(strike)
          ? "call"
          : "put") as ChainLine["from"],
    }))
    // De mayor a menor: los strikes altos arriba, como se lee un gráfico de
    // precio. El orden es por strike, NO por volumen, para que siga leyéndose
    // como una cadena de verdad.
    .sort((a, b) => b.strike - a.strike);
}

/**
 * Lo que el VOLUMEN por sí solo permite afirmar. Deliberadamente corto.
 *
 * No incluye dirección: el volumen dice dónde hay actividad, no de qué lado.
 * Un strike con volumen enorme es una apuesta alcista si esos calls se
 * compraron y un muro de resistencia si se vendieron, y eso solo lo distingue
 * el agresor (ask vs bid), que esta fuente no entrega. Ver Proceso 0DTE §6.3.
 */
export interface ChainSummary {
  /** Strike con más volumen de calls de toda la cadena. */
  maxCallStrike: number | null;
  maxCallVolume: number;
  /** Strike con más volumen de puts de toda la cadena. */
  maxPutStrike: number | null;
  maxPutVolume: number;
  /** Totales de TODA la cadena, no solo de los strikes mostrados. */
  callVolume: number;
  putVolume: number;
  /** putVolume / callVolume. null si no hay volumen de calls. */
  putCallRatio: number | null;
}

/** Resumen de la cadena. PURA. */
export function summarize(all: Row[]): ChainSummary {
  let maxCall: Row | null = null;
  let maxPut: Row | null = null;
  let callVolume = 0;
  let putVolume = 0;

  for (const r of all) {
    if (r.contractType === "call") {
      callVolume += r.volume;
      if (!maxCall || r.volume > maxCall.volume) maxCall = r;
    } else {
      putVolume += r.volume;
      if (!maxPut || r.volume > maxPut.volume) maxPut = r;
    }
  }

  return {
    maxCallStrike: maxCall?.strike ?? null,
    maxCallVolume: maxCall?.volume ?? 0,
    maxPutStrike: maxPut?.strike ?? null,
    maxPutVolume: maxPut?.volume ?? 0,
    callVolume,
    putVolume,
    putCallRatio: callVolume > 0 ? putVolume / callVolume : null,
  };
}

// ---------------------------------------------------------------- pronóstico

/** Cierre del mercado en minutos desde medianoche ET. */
const CLOSE_MIN = 16 * 60;

/**
 * Horas que faltan para el cierre (16:00 ET). PURA.
 *
 * Es el dato que hace viable el pronóstico intradía: `expectedMove` anualiza
 * sobre 365 días, así que pasarle `days = 0` da σ = 0 y los tres escenarios
 * colapsan sobre el spot. Con la fracción de día que queda, el cono se abre lo
 * que le corresponde — que a media sesión es poco, y así debe ser.
 */
export function hoursToClose(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const raw = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const h = raw === 24 ? 0 : raw; // ICU devuelve "24" a medianoche
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return Math.max(0, (CLOSE_MIN - (h * 60 + m)) / 60);
}

/**
 * Ventana alrededor del spot para medir la IV del día. Muy estrecha a propósito.
 *
 * `chainIV` usa ±20%, que sirve para horizontes de semanas pero no aquí: en el
 * vencimiento del día los strikes lejanos cotizan con IV disparatada (el tope de
 * cordura son 300%) y, ponderados por Open Interest, arrastran la media. Medido
 * en SPX el 24-jul-2026, ±20% daba 85% de IV — que implicaba ±1.7% en 3.4 horas,
 * más de lo que SPX suele moverse en una sesión entera.
 */
export const ATM_PCT = 0.02;

/**
 * IV at-the-money del vencimiento del día, ponderada por Open Interest. PURA.
 * Devuelve null si la cadena no trae IV real.
 */
export function atmIV(rows: Row[], spot: number, pct: number = ATM_PCT): number | null {
  if (!(spot > 0)) return null;
  // IV del STRADDLE ATM: promedio de la IV call+put del strike MÁS CERCANO al spot
  // (con IV válida). NO se pondera por OI — así el skew de equity (puts OTM con IV
  // alta y mucho OI) ya NO sesga la IV hacia arriba. Si el más cercano no tiene IV,
  // cae al siguiente. Es la convención estándar del expected move.
  const byK = new Map<number, { c?: number; p?: number }>();
  for (const r of rows) {
    const iv = r.greeks?.iv;
    if (typeof iv !== "number" || !(iv > 0) || iv > MAX_SANE_IV) continue;
    if (Math.abs(r.strike - spot) > spot * pct) continue;
    const e = byK.get(r.strike) ?? {};
    if (r.contractType === "call") e.c = iv; else e.p = iv;
    byK.set(r.strike, e);
  }
  const sorted = [...byK.entries()].sort((a, b) => Math.abs(a[0] - spot) - Math.abs(b[0] - spot));
  for (const [, e] of sorted) {
    const ivs = [e.c, e.p].filter((x): x is number => typeof x === "number");
    if (ivs.length > 0) return ivs.reduce((s, x) => s + x, 0) / ivs.length;
  }
  return null;
}

// ----------------------------------------------------------------- GEX 0DTE

/** Ventana de strikes alrededor del spot para el GEX del día. */
export const GEX_NEAR_PCT = 0.03;

/**
 * OI VIVO: ajusta el Open Interest (de ayer al cierre) por el agresor NETO de
 * HOY (compras − ventas agresivas por contrato). Fue un experimento para acercar
 * la gamma intradía, pero la validación en vivo (2026-08-10) contra GammaFlow/
 * MenthorQ lo REFUTÓ: sumar el volumen agresor al OI INVIERTE el signo del Net GEX
 * (daba −$4B cuando el mercado estaba +$25B) y tira el flip ~100 pts abajo. Las
 * herramientas estándar usan OI de settlement puro. Por eso: DEFAULT OFF.
 * GEX_LIVE_OI=1 → reactiva el experimento (no recomendado).
 */
const GEX_LIVE_OI = (process.env.GEX_LIVE_OI ?? "0") === "1";

export interface ZeroDteGexNode {
  strike: number;
  /** callGex − putGex. El signo dice qué lado domina. */
  netGex: number;
  callGex: number;
  putGex: number;
  side: "call" | "put";
  /** |NET GEX| del strike, normalizado al mayor de la ventana (0-1). Es la métrica
   *  del "gamma wall/magnet" estándar (la barra NETA más grande), no la gamma total. */
  concentration: number;
}

export interface ZeroDteGex {
  nodes: ZeroDteGexNode[];
  /** Strike de mayor concentración de gamma: el imán. */
  kingStrike: number | null;
  /** Strike donde el GEX acumulado cambia de signo: la zona de inversión. */
  flipStrike: number | null;
  /** Gamma neta del vencimiento. Positiva revierte, negativa amplifica. */
  regime: "positive" | "negative";
  totalNetGex: number;
  /** Fracción de contratos que traían gamma real (0-1). */
  realGammaShare: number;
  n: number;
}

/**
 * GEX del vencimiento del día. PURA.
 *
 * No reutiliza `gexAnalysis` porque este descarta todo contrato con
 * `daysToExpiration <= 0` —pensado para excluir los ya expirados de una cadena
 * multi-vencimiento— y en 0DTE eso es la cadena entera: devolvería vacío.
 *
 * Tampoco hace falta su maquinaria de Black-Scholes: Schwab entrega la gamma
 * real por contrato, y con T = 0 la fórmula degeneraría de todos modos.
 *
 * GEX por strike = gamma × OI × 100 × spot² × 0.01, con signo +call / −put,
 * igual que el motor existente.
 */
export function zeroDteGex(
  rows: Row[],
  spot: number,
  nearPct: number = GEX_NEAR_PCT,
): ZeroDteGex {
  const empty: ZeroDteGex = {
    nodes: [], kingStrike: null, flipStrike: null,
    regime: "positive", totalNetGex: 0, realGammaShare: 0, n: 0,
  };
  if (!(spot > 0) || rows.length === 0) return empty;

  const lo = spot * (1 - nearPct);
  const hi = spot * (1 + nearPct);
  const byStrike = new Map<number, { callGex: number; putGex: number }>();
  let considered = 0;
  let withRealGamma = 0;

  for (const r of rows) {
    if (r.strike < lo || r.strike > hi) continue;
    // OI EFECTIVO = OI (ayer) + agresor neto de hoy (posicionamiento nuevo).
    // Se acota a ≥0 (no hay OI negativo). Con GEX_LIVE_OI=0 usa OI puro.
    const oi = Math.max(0, r.openInterest + (GEX_LIVE_OI ? (r.intradayNet ?? 0) : 0));
    if (!(oi > 0)) continue;
    const gamma = r.greeks?.gamma;
    considered += 1;
    if (typeof gamma !== "number" || !(gamma > 0)) continue;
    withRealGamma += 1;

    const gex = gamma * oi * 100 * spot * spot * 0.01;
    const s = byStrike.get(r.strike) ?? { callGex: 0, putGex: 0 };
    if (r.contractType === "call") s.callGex += gex;
    else s.putGex += gex;
    byStrike.set(r.strike, s);
  }

  if (byStrike.size === 0) return empty;

  const raw = [...byStrike.entries()]
    .map(([strike, g]) => ({
      strike,
      netGex: g.callGex - g.putGex,
      callGex: g.callGex,
      putGex: g.putGex,
    }))
    .sort((a, b) => a.strike - b.strike);

  // Concentración por |NET GEX| (estándar del "gamma wall/magnet": la barra NETA
  // más grande), NO por gamma total (call+put) — así el imán coincide con las barras
  // del chart y con las referencias (antes usaba total → "el magneto no machea").
  const maxAbsNet = Math.max(...raw.map((r) => Math.abs(r.netGex)), 0);
  const nodes: ZeroDteGexNode[] = raw.map((r) => ({
    strike: r.strike,
    netGex: r.netGex,
    callGex: r.callGex,
    putGex: r.putGex,
    side: (r.netGex >= 0 ? "call" : "put") as "call" | "put",
    concentration: maxAbsNet > 0 ? Math.abs(r.netGex) / maxAbsNet : 0,
  }));

  // Imán: el strike con mayor |NET GEX| (la barra neta dominante). Es donde el
  // hedging NETO de los dealers es más fuerte; el régimen dice si pinea o repele.
  const king = nodes.reduce((a, b) => (b.concentration > a.concentration ? b : a));

  // Gamma flip (frontera de régimen): el strike donde el netGex POR STRIKE cambia
  // de signo — la frontera "roja/verde" (puts dominan ↔ calls dominan), como la
  // marcan GammaFlow/MenthorQ. Se interpola entre los dos strikes y se toma la más
  // CERCANA al spot. Es más robusta que el cruce del ACUMULADO, que en tickers de
  // Net GEX total negativo nunca cruza cerca del spot (deja solo cruces espurios de
  // strikes lejanos) y daba un flip muy alejado (ej. SPY 754 en vez de ~772).
  let flipStrike: number | null = null;
  let bestDist = Infinity;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i];
    if (a.netGex !== 0 && Math.sign(b.netGex) !== Math.sign(a.netGex)) {
      const span = Math.abs(a.netGex) + Math.abs(b.netGex);
      const cross = span > 0 ? a.strike + (b.strike - a.strike) * (Math.abs(a.netGex) / span) : b.strike;
      const dist = Math.abs(cross - spot);
      if (dist < bestDist) { bestDist = dist; flipStrike = cross; }
    }
  }

  const totalNetGex = raw.reduce((s, r) => s + r.netGex, 0);

  // Régimen = posición del SPOT respecto al flip (la frontera que importa para
  // operar): arriba del flip = γ+ (los dealers estabilizan, pin); abajo = γ−
  // (aceleración). Es más accionable que el signo del total (que puede ser + aunque
  // el precio esté en la zona negativa bajo el flip). Sin flip, cae al signo total.
  const regime: "positive" | "negative" = flipStrike != null
    ? (spot >= flipStrike ? "positive" : "negative")
    : (totalNetGex >= 0 ? "positive" : "negative");

  return {
    nodes: [...nodes].sort((a, b) => b.concentration - a.concentration),
    kingStrike: king.strike,
    flipStrike,
    regime,
    totalNetGex,
    realGammaShare: considered > 0 ? withRealGamma / considered : 0,
    n: byStrike.size,
  };
}

// ---------------------------------------------- flujos de dealer (vanna / charm)

export interface DealerFlow {
  /** Charm neto cerca del dinero (con signo +call/−put, ponderado por OI). MÉTRICA
   *  ESTRUCTURAL (como el GEX) — NO es la dirección del cierre; para eso usar charmFlow. */
  netCharm: number;
  /** Dirección del REBALANCEO del dealer por charm hacia el cierre = −Σ bsCharm·OI
   *  (sin signo por tipo). >0 = compra neta (sesgo alcista al cierre); <0 = venta
   *  (bajista). Escala con charmIntensity. Es el signo bueno para el pinning alterno. */
  charmFlow: number;
  /** Vanna neta cerca del dinero (misma convención). */
  netVanna: number;
  /**
   * Intensidad del efecto charm AHORA (0-1). Crece hacia el cierre porque charm
   * escala como 1/T; a media sesión es leve, en la última hora domina.
   */
  charmIntensity: number;
  /** Dirección de la deriva por vanna SI la IV baja ~1 punto. */
  vannaIfVolDrops: Lean;
  /** Explicación en una línea. */
  note: string;
}

/**
 * Agrega charm y vanna de la cadena del día como "flujo de dealer". PURA.
 *
 * Convención de posicionamiento (la misma del GEX de este proyecto): se suma con
 * signo +call / −put, ponderado por Open Interest, solo cerca del dinero. NO es
 * una certeza sobre el posicionamiento real de cada dealer — es el modelo
 * estándar de exposición agregada. Por eso lo que sale es una TENDENCIA
 * probabilística, no una garantía.
 *
 * `hoursToClose` escala la intensidad de charm (1/T se dispara al cierre).
 */
export function dealerFlow(
  rows: Row[],
  spot: number,
  iv: number | null,
  hoursLeft: number,
  nearPct = 0.03,
): DealerFlow | null {
  if (!(spot > 0) || iv == null || !(iv > 0) || hoursLeft <= 0) return null;

  const lo = spot * (1 - nearPct);
  const hi = spot * (1 + nearPct);
  const T = hoursLeft / (24 * 365); // años hasta el cierre

  let netCharm = 0;
  let netVanna = 0;
  let charmFlow = 0; // dirección del rebalanceo por charm al cierre (ver abajo)
  for (const r of rows) {
    if (r.strike < lo || r.strike > hi) continue;
    if (!(r.openInterest > 0)) continue;
    const sign = r.contractType === "call" ? 1 : -1;
    const ch = bsCharm(spot, r.strike, T, iv);
    netCharm += ch * r.openInterest * sign;
    netVanna += bsVanna(spot, r.strike, T, iv) * r.openInterest * sign;
    // Flujo de rebalanceo del dealer al cierre. bsCharm = ∂Δ/∂T; al PASAR el
    // tiempo Δ cambia −bsCharm, y el dealer (corto las opciones del público)
    // ajusta su cobertura comprando/vendiendo futuros por −bsCharm·OI. Suma sin
    // signo por tipo. >0 = compra neta (alcista); <0 = venta neta (bajista).
    // Verificado: puts OTM decayendo → +, calls OTM → − (melt-up clásico).
    charmFlow += -ch * r.openInterest;
  }

  // Intensidad de charm: crece al acercarse el cierre. Plena en la última hora.
  const charmIntensity = Math.max(0, Math.min(1, 1 - hoursLeft / 6.5));

  // Vanna: si la IV baja, el sesgo va en sentido OPUESTO al signo de netVanna
  // (menos vol → el delta cae donde vanna es positiva). Se reporta condicional.
  const vannaIfVolDrops: Lean =
    Math.abs(netVanna) < 1e-6 ? "lateral" : netVanna > 0 ? "bajista" : "alcista";

  const note =
    `Charm ${netCharm >= 0 ? "positivo" : "negativo"} (intensidad ${(charmIntensity * 100).toFixed(0)}%, ` +
    `sube hacia el cierre); vanna sugiere sesgo ${vannaIfVolDrops} si la IV baja.`;

  return { netCharm, charmFlow, netVanna, charmIntensity, vannaIfVolDrops, note };
}

// ------------------------------------------------- panorama a corto plazo (5 min)

export type Lean = "alcista" | "bajista" | "lateral";

export interface ShortTermOutlook {
  spot: number;
  horizonMinutes: number;
  /** Desviación estándar del movimiento en el horizonte, en puntos. */
  sigma: number;
  /** Rango ~68% (±1σ). */
  rangeLow: number;
  rangeHigh: number;
  /** Imán del GEX (strike de mayor gamma). */
  magnet: number | null;
  regime: "positive" | "negative";
  lean: Lean;
  /** Frase corta y llana: "ahora en X → en ~5 min ...". */
  headline: string;
  /** Explicación en una línea del porqué. */
  detail: string;
  confidence: "baja" | "media";
  /** Intensidad del charm ahora (0-1), o null si no hay flujo. Sube hacia el cierre. */
  charmIntensity: number | null;
  /** Qué añade el charm a la lectura, o null. */
  charmNote: string | null;
  /** Qué añade la vanna (condicional a la IV), o null. */
  vannaNote: string | null;
}

const nfPts = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Panorama del próximo tramo (por defecto 5 min). PURA.
 *
 * Deliberadamente NO da un precio único "va a llegar a X". A 5 minutos el
 * movimiento esperado es diminuto y afirmar un punto exacto sería falso. Lo que
 * sí es defendible: el RANGO estadístico (±1σ sobre el horizonte) y hacia dónde
 * empuja el POSICIONAMIENTO (el imán del GEX y el régimen de gamma). Se combinan
 * en una frase legible, marcada siempre como estimación, no como consejo.
 */
export function shortTermOutlook(
  spot: number,
  iv: number | null,
  gex: ZeroDteGex,
  horizonMinutes = 5,
  flow?: DealerFlow | null,
  basis = 0,
  locale: Lang = "es",
): ShortTermOutlook | null {
  if (!(spot > 0) || iv == null || !(iv > 0)) return null;

  // En futuros (/ES, /NQ) el TEXTO se muestra en el precio del futuro (índice +
  // basis, al tick de 0.25). Los campos numéricos del objeto se quedan crudos
  // (en el índice): el consumidor les aplica el basis. Así no se convierte dos
  // veces. Con basis 0 (índices normales) es identidad.
  const dv = (v: number) => nfPts(basis ? Math.round((v + basis) * 4) / 4 : v);
  const dSpot = (basis ? Math.round((spot + basis) * 4) / 4 : spot).toFixed(2);
  const es = locale === "es";

  const days = horizonMinutes / 1440;
  const em = expectedMove(spot, iv, days);
  const lo = em.lower1;
  const hi = em.upper1;
  const magnet = gex.kingStrike;
  const dist = magnet != null ? magnet - spot : 0;

  const charmI = flow?.charmIntensity ?? null;

  // Lean: en gamma positiva el precio revierte hacia el imán; en negativa se
  // amplifica. El imán solo "tira" si está a un alcance razonable en el horizonte.
  // El CHARM extiende ese alcance hacia el cierre: el delta que se desvanece
  // arrastra el precio al imán con más fuerza cuanto menos tiempo queda.
  let lean: Lean = "lateral";
  let detail: string;
  const reach = 2 * em.sigma * (1 + 0.5 * (charmI ?? 0));

  if (magnet == null) {
    detail = es ? "Sin imán de gamma identificable; movimiento sin sesgo claro." : "No identifiable gamma magnet; move with no clear bias.";
  } else if (gex.regime === "positive") {
    if (Math.abs(dist) <= em.sigma) {
      lean = "lateral";
      detail = es
        ? `Gamma positiva y el precio ya está sobre el imán ${dv(magnet)}: los dealers lo anclan, se espera lateral.`
        : `Positive gamma and price is already on the magnet ${dv(magnet)}: dealers anchor it, sideways expected.`;
    } else if (Math.abs(dist) <= reach) {
      lean = dist > 0 ? "alcista" : "bajista";
      detail = es
        ? `Gamma positiva: el precio tiende a volver al imán ${dv(magnet)}, ${dist > 0 ? "por encima" : "por debajo"}.`
        : `Positive gamma: price tends to return to the magnet ${dv(magnet)}, ${dist > 0 ? "above" : "below"}.`;
    } else {
      lean = "lateral";
      detail = es
        ? `El imán ${dv(magnet)} queda fuera de alcance en ${horizonMinutes} min; sesgo lateral dentro del rango.`
        : `The magnet ${dv(magnet)} is out of reach in ${horizonMinutes} min; sideways bias within the range.`;
    }
  } else {
    // Gamma negativa: los movimientos se amplifican. Sin momentum no afirmamos
    // dirección, pero avisamos del riesgo de aceleración.
    lean = "lateral";
    const flipDisp = gex.flipStrike != null ? dv(gex.flipStrike) : es ? "un extremo" : "an extreme";
    detail = es
      ? `Gamma negativa: los movimientos se amplifican. Si rompe ${flipDisp}, puede acelerar.`
      : `Negative gamma: moves amplify. If it breaks ${flipDisp}, it can accelerate.`;
  }

  const confidence: "baja" | "media" =
    gex.regime === "positive" && magnet != null && Math.abs(dist) <= em.sigma ? "media" : "baja";

  // Notas de charm/vanna: la matemática que afina la trayectoria hacia el cierre.
  let charmNote: string | null = null;
  let vannaNote: string | null = null;
  if (flow && charmI != null) {
    const pct = `${(charmI * 100).toFixed(0)}%`;
    const magDisp = magnet != null ? dv(magnet) : es ? "el imán" : "the magnet";
    charmNote =
      gex.regime === "positive"
        ? es
          ? `Charm ${pct}: la atracción hacia ${magDisp} se intensifica hacia el cierre (pin).`
          : `Charm ${pct}: the pull toward ${magDisp} intensifies into the close (pin).`
        : es
          ? `Charm ${pct}: un rompimiento puede acelerar hacia el cierre (gamma negativa).`
          : `Charm ${pct}: a breakout can accelerate into the close (negative gamma).`;
    if (flow.vannaIfVolDrops !== "lateral") {
      const vbias = es ? flow.vannaIfVolDrops : flow.vannaIfVolDrops === "alcista" ? "bullish" : "bearish";
      vannaNote = es ? `Vanna: si la IV baja, añade sesgo ${vbias}.` : `Vanna: if IV drops, adds ${vbias} bias.`;
    }
  }

  const headline = es
    ? `Ahora ${dSpot} → en ~${horizonMinutes} min, probablemente entre ${dv(lo)} y ${dv(hi)}` +
      (magnet != null && lean !== "lateral" ? `, gravitando hacia ${dv(magnet)}` : "")
    : `Now ${dSpot} → in ~${horizonMinutes} min, likely between ${dv(lo)} and ${dv(hi)}` +
      (magnet != null && lean !== "lateral" ? `, gravitating toward ${dv(magnet)}` : "");

  return {
    spot,
    horizonMinutes,
    sigma: em.sigma,
    rangeLow: lo,
    rangeHigh: hi,
    magnet,
    regime: gex.regime,
    lean,
    headline,
    detail,
    confidence,
    charmIntensity: charmI,
    charmNote,
    vannaNote,
  };
}

// ----------------------------------------------- pronóstico de cierre (3-4pm ET)

/** Ventana en minutos antes del cierre en que se activa el pronóstico. */
export const CLOSING_WINDOW_MIN = 60;

/**
 * Fase del pronóstico de cierre a lo largo del día:
 *  - pending: 9:30am–3pm, aún no se calcula (strike null).
 *  - live: 3–4pm, se calcula y converge.
 *  - final: tras las 4pm y hasta las 9:30am de la próxima sesión, valor fijado.
 */
export type ClosingPhase = "pending" | "live" | "final";

export interface ClosingForecast {
  phase: ClosingPhase;
  minutesLeft: number;
  spot: number;
  magnet: number | null;
  /** Max Pain (strike de menor valor intrínseco para los holders). Predictor de
   *  cierre clásico, complementario al imán de gamma. null si no hay OI. */
  maxPain: number | null;
  regime: "positive" | "negative";
  /** Precio de cierre estimado (crudo, sin redondear al strike). */
  estimate: number;
  /** Strike más probable de cierre. null en fase pending. */
  strike: number | null;
  /** Rango ~68% del cierre, redondeado a strikes. */
  rangeLow: number;
  rangeHigh: number;
  /** σ restante en puntos: se encoge hacia 0 al acercarse las 4pm. */
  sigma: number;
  confidence: "baja" | "media" | "alta";
  note: string;
  /** Solo en fase final: la fecha de la sesión de la que viene el valor fijado. */
  fromDate?: string;
}

/**
 * Pronóstico del strike de cierre a las 4:00pm ET. PURA.
 *
 * Se activa **solo en la última hora** (3:00-4:00pm ET), que es cuando el jalón
 * de gamma+charm de los market makers es más fuerte (charm ~ 1/√T se dispara) y
 * el movimiento restante ya es pequeño. Fuera de esa ventana devuelve null.
 *
 * En gamma POSITIVA el precio tiende al imán; el estimado se acota al cono de 2σ
 * restante, así que **converge**: mientras pasa el tiempo, σ se encoge y el
 * estimado se afina hacia el precio actual/imán. En gamma NEGATIVA no hay pin —
 * el mejor estimado es el precio actual y la confianza baja.
 *
 * NO es certeza: el pin es una tendencia que una noticia grande puede romper.
 */
/**
 * Max Pain: el precio de cierre donde el valor INTRÍNSECO total de las opciones en
 * manos de los holders es MÍNIMO (los holders pierden lo más posible; los vendedores
 * netos —los dealers— ganan). El precio tiende a gravitar ahí en la expiración. Es el
 * predictor de cierre CLÁSICO, complementario al imán de gamma: el imán mide el
 * hedging de los dealers; el Max Pain mide el OI intrínseco. PURA.
 *
 * Para cada precio candidato P (los strikes): Σ_K max(0,P−K)·callOI + max(0,K−P)·putOI.
 * El argmin es el Max Pain. Ventana ±nearPct del spot (el cierre no se aleja hoy; un
 * muro de OI lejano no fija el cierre de la sesión).
 */
export function maxPainStrike(
  rows: Row[],
  spot: number,
  nearPct = GEX_NEAR_PCT,
): number | null {
  if (!(spot > 0) || rows.length === 0) return null;
  const lo = spot * (1 - nearPct);
  const hi = spot * (1 + nearPct);
  const byK = new Map<number, { c: number; p: number }>();
  for (const r of rows) {
    if (r.strike < lo || r.strike > hi) continue;
    const oi = r.openInterest;
    if (!(oi > 0)) continue;
    const e = byK.get(r.strike) ?? { c: 0, p: 0 };
    if (r.contractType === "call") e.c += oi;
    else e.p += oi;
    byK.set(r.strike, e);
  }
  if (byK.size === 0) return null;

  let best: number | null = null;
  let bestPain = Infinity;
  for (const P of byK.keys()) {
    let pain = 0;
    for (const [K, e] of byK) {
      if (P > K) pain += (P - K) * e.c; // calls que cierran ITM
      else if (P < K) pain += (K - P) * e.p; // puts que cierran ITM
    }
    if (pain < bestPain) {
      bestPain = pain;
      best = P;
    }
  }
  return best;
}

/**
 * Construye el GEX Ticket server-side desde el mismo `entry` que ya devuelve el API
 * (el trade que muestra la web y Discord) + la cadena. Así el bot lo lee de `d.ticket`
 * sin recalcular nada. `flowSweeps` se queda en 0 aquí (el server no tiene el flujo
 * en vivo); el consumidor que sí lo tenga lo puede rellenar. null si no hay setup.
 */
export function buildTicket(
  lines: ChainLine[],
  entry: EntryDecision | null,
  spot: number | null,
): Ticket | null {
  if (!entry || spot == null || !(spot > 0)) return null;
  const chain: TicketChainRow[] = lines.flatMap((l) => {
    const out: TicketChainRow[] = [];
    const push = (r: Row | null, type: "call" | "put") => {
      if (r) out.push({ strike: l.strike, type, bid: r.bid ?? null, ask: r.ask ?? null, delta: r.greeks?.delta ?? null, gamma: r.greeks?.gamma ?? null, iv: r.greeks?.iv ?? null, volume: r.volume, oi: r.openInterest });
    };
    push(l.call, "call");
    push(l.put, "put");
    return out;
  });
  return pickTicket(entry, spot, chain);
}

export function closingForecast(
  spot: number,
  iv: number | null,
  gex: ZeroDteGex,
  now: Date = new Date(),
  strikeStep = 5,
  locale: Lang = "es",
  maxPain: number | null = null,
): ClosingForecast | null {
  if (!(spot > 0) || iv == null || !(iv > 0)) return null;

  const minutesLeft = hoursToClose(now) * 60;
  if (minutesLeft <= 0 || minutesLeft > CLOSING_WINDOW_MIN) return null;

  const em = expectedMove(spot, iv, minutesLeft / 1440);
  const reach = 2 * em.sigma; // cuánto puede moverse, como mucho, en el tiempo que queda
  const magnet = gex.kingStrike;

  // Estimado crudo: en gamma positiva, el imán acotado a lo alcanzable; si el
  // imán no llega, hasta donde el tiempo permita hacia él. En gamma negativa el
  // pin no aplica: el mejor estimado es el precio actual.
  let estimate: number;
  if (gex.regime === "positive" && magnet != null) {
    estimate = Math.min(spot + reach, Math.max(spot - reach, magnet));
  } else {
    estimate = spot;
  }

  const strike = Math.round(estimate / strikeStep) * strikeStep;
  const rangeLow = Math.round((spot - em.sigma) / strikeStep) * strikeStep;
  const rangeHigh = Math.round((spot + em.sigma) / strikeStep) * strikeStep;

  // Confianza: sube al converger (menos tiempo, menos σ) en gamma positiva.
  let confidence: "baja" | "media" | "alta";
  if (gex.regime !== "positive" || magnet == null) confidence = "baja";
  else if (minutesLeft <= 15) confidence = "alta";
  else confidence = "media";

  const es = locale === "es";
  const baseNote =
    gex.regime === "positive" && magnet != null
      ? es
        ? `Gamma positiva: los dealers tienden a anclar el cierre cerca de ${nfPts(magnet)}. Quedan ${minutesLeft.toFixed(0)} min y el margen de movimiento es +/-${em.sigma.toFixed(1)} pts.`
        : `Positive gamma: dealers tend to anchor the close near ${nfPts(magnet)}. ${minutesLeft.toFixed(0)} min left and the move margin is +/-${em.sigma.toFixed(1)} pts.`
      : es
        ? `Gamma negativa: sin efecto de anclaje fiable. El mejor estimado es el precio actual; un rompimiento puede alejarlo.`
        : `Negative gamma: no reliable anchoring effect. The best estimate is the current price; a breakout can push it away.`;

  // Max Pain como segundo predictor. Si coincide con el imán de gamma (±1 strike) es
  // CONFLUENCIA (dos métodos independientes de acuerdo → pin más firme); si diverge,
  // se muestra el nivel para que el usuario lo tenga en cuenta.
  let mpNote = "";
  if (maxPain != null) {
    // La confluencia "pin más firme" solo tiene sentido en γ+ (donde el imán ancla).
    // En γ− no hay pin fiable aunque el Max Pain coincida: se muestra el nivel, neutro.
    const confluye = gex.regime === "positive" && magnet != null && Math.abs(maxPain - magnet) <= strikeStep;
    mpNote = confluye
      ? es
        ? ` Max Pain (OI) coincide en ${nfPts(maxPain)} -> confluencia, pin mas firme.`
        : ` Max Pain (OI) agrees at ${nfPts(maxPain)} -> confluence, firmer pin.`
      : es
        ? ` Max Pain (OI) en ${nfPts(maxPain)}.`
        : ` Max Pain (OI) at ${nfPts(maxPain)}.`;
  }

  return {
    phase: "live",
    minutesLeft,
    spot,
    magnet,
    maxPain,
    regime: gex.regime,
    estimate,
    strike,
    rangeLow,
    rangeHigh,
    sigma: em.sigma,
    confidence,
    note: baseNote + mpNote,
  };
}

export type ScenarioKind = "bear" | "base" | "bull";

export interface ZeroDteScenario {
  kind: ScenarioKind;
  target: number;
  changePct: number;
  /** Probabilidad de TOCAR el nivel antes del cierre (0-1). */
  probTouch: number;
  reason: string;
}

export interface ZeroDteForecast {
  spot: number;
  iv: number;
  hoursToClose: number;
  sigma: number;
  sigmaPct: number;
  upper1: number;
  lower1: number;
  upper2: number;
  lower2: number;
  scenarios: ZeroDteScenario[];
  /** % de auto-corrección aplicado al objetivo base por el sesgo histórico. */
  calibShiftPct: number;
  /** Motivo por el que el pronóstico NO es fiable, o null. */
  caveat: string | null;
}

/** Parámetros del lazo de auto-corrección. */
export const CALIBRATION = { minSamples: 5, gain: 0.6, capPct: 3 };

/**
 * Cuánto (en %) corregir el objetivo central del pronóstico según el sesgo
 * histórico medido en "Precisión del modelo". PURA.
 *
 * Amortiguada y acotada: solo con ≥minSamples sesiones evaluadas, corrige el
 * `gain` (60%) del sesgo, con tope ±capPct%. Converge sola: al mejorar el
 * modelo el sesgo baja y la corrección se apaga. biasPct>0 (el precio cierra por
 * encima del base) → sube el objetivo; <0 → lo baja.
 */
export function calibrationShiftPct(
  biasPct: number | null,
  samples: number,
  cfg = CALIBRATION,
): number {
  if (biasPct == null || samples < cfg.minSamples) return 0;
  return Math.max(-cfg.capPct, Math.min(cfg.capPct, biasPct * cfg.gain));
}

/**
 * Tres escenarios para lo que queda de sesión. PURA.
 *
 * El imán es el strike de mayor volumen ponderado por probabilidad de toque: un
 * muro enorme pero inalcanzable en 3 horas pesa menos que uno mediano y cercano.
 * Todo se recorta al cono de 2σ — sin ese tope el modelo propone objetivos que
 * la volatilidad implícita no permite alcanzar en el tiempo que queda.
 *
 * NO incorpora dirección: el volumen no distingue compra de venta. Estos niveles
 * son zonas de atracción, no una apuesta sobre hacia dónde va el precio.
 */
export function buildForecast(
  spot: number,
  iv: number | null,
  lines: ChainLine[],
  now: Date = new Date(),
  calibShiftPct = 0,
  basis = 0,
  locale: Lang = "es",
): ZeroDteForecast | null {
  if (!(spot > 0) || iv == null || !(iv > 0)) return null;

  // En futuros, el strike citado en el TEXTO se muestra en el precio del futuro
  // (índice + basis, tick 0.25). Los `target` numéricos se quedan crudos: la
  // página les aplica el basis. Con basis 0 es identidad.
  const cvp = (v: number) => (basis ? Math.round((v + basis) * 4) / 4 : v);
  const es = locale === "es";

  const hrs = hoursToClose(now);
  const days = hrs / 24;
  const em = expectedMove(spot, iv, days);

  const clamp = (v: number) => Math.min(em.upper2, Math.max(em.lower2, v));

  // Peso de cada strike: volumen total × probabilidad de tocarlo antes del cierre.
  const weighted = lines
    .map((l) => {
      const volume = (l.call?.volume ?? 0) + (l.put?.volume ?? 0);
      const touch = probTouch(spot, l.strike, iv, days);
      return { strike: l.strike, volume, touch, weight: volume * touch };
    })
    .filter((w) => w.volume > 0)
    .sort((a, b) => b.weight - a.weight);

  const top = weighted[0];
  // Auto-corrección: el objetivo base (el imán crudo) se desplaza según el sesgo
  // histórico, y se recorta al cono de 2σ. Los extremos (bull/bear) se quedan en
  // los muros crudos: no se arrastra el sesgo a las alas.
  const base = top ? clamp(top.strike + (spot * calibShiftPct) / 100) : spot;

  // Separación mínima respecto al base. Sin ella, el peso volumen × toque
  // siempre elige el strike CONTIGUO —su probabilidad de toque es casi 1— y los
  // tres escenarios se amontonan en ±0.1% mientras el cono dice ±1.7%. Un
  // escenario que no se distingue del base no es un escenario.
  const minGap = Math.max(em.sigma * 0.5, spot * 0.001);

  const above = weighted.filter((w) => w.strike >= base + minGap);
  const below = weighted.filter((w) => w.strike <= base - minGap);

  // Si no hay muro relevante a un lado, la banda de 1σ hace de objetivo.
  const bullRaw = above.length ? above[0].strike : em.upper1;
  const bearRaw = below.length ? below[0].strike : em.lower1;

  // Orden estricto bear < base < bull: un modelo que los cruza no dice nada.
  const bull = Math.max(clamp(bullRaw), base);
  const bear = Math.min(clamp(bearRaw), base);

  const mk = (kind: ScenarioKind, target: number, reason: string): ZeroDteScenario => ({
    kind,
    target,
    changePct: ((target - spot) / spot) * 100,
    probTouch: probTouch(spot, target, iv, days),
    reason,
  });

  const volTxt = top
    ? `${top.volume.toLocaleString("en-US")} ${es ? "contratos" : "contracts"}`
    : es ? "sin volumen" : "no volume";

  let caveat: string | null = null;
  if (hrs <= 0) caveat = es ? "Sesión cerrada: el vencimiento de hoy ya expiró." : "Session closed: today's expiration already expired.";
  else if (hrs < 0.5) caveat = es ? "Menos de 30 minutos para el cierre: el modelo pierde sentido." : "Less than 30 minutes to the close: the model loses meaning.";
  else if (!top) caveat = es ? "Sin volumen suficiente en la cadena." : "Not enough volume in the chain.";

  return {
    spot,
    iv,
    hoursToClose: hrs,
    sigma: em.sigma,
    sigmaPct: em.sigmaPct,
    upper1: em.upper1,
    lower1: em.lower1,
    upper2: em.upper2,
    lower2: em.lower2,
    calibShiftPct,
    caveat,
    scenarios: [
      mk("bear", bear, below.length
        ? es
          ? `Zona de atracción por debajo (${below[0].volume.toLocaleString("en-US")} contratos)`
          : `Attraction zone below (${below[0].volume.toLocaleString("en-US")} contracts)`
        : es ? "Banda inferior de 1σ — no hay muro relevante debajo" : "Lower 1σ band — no relevant wall below"),
      mk("base", base, top
        ? es
          ? `Strike de mayor atracción: ${cvp(top.strike)} (${volTxt})${calibShiftPct !== 0 ? ` · ajustado ${calibShiftPct > 0 ? "+" : ""}${calibShiftPct.toFixed(2)}% por sesgo histórico` : ""}`
          : `Highest-attraction strike: ${cvp(top.strike)} (${volTxt})${calibShiftPct !== 0 ? ` · adjusted ${calibShiftPct > 0 ? "+" : ""}${calibShiftPct.toFixed(2)}% by historical bias` : ""}`
        : es ? "Sin imán identificable" : "No identifiable magnet"),
      mk("bull", bull, above.length
        ? es
          ? `Zona de atracción por encima (${above[0].volume.toLocaleString("en-US")} contratos)`
          : `Attraction zone above (${above[0].volume.toLocaleString("en-US")} contracts)`
        : es ? "Banda superior de 1σ — no hay muro relevante encima" : "Upper 1σ band — no relevant wall above"),
    ],
  };
}

export interface ZeroDteResult {
  ticker: string;
  expiration: string;
  /** true si el vencimiento pedido es el de hoy (0DTE). Los paneles intradía
   *  (panorama 5 min, escenarios hasta el cierre) solo aplican cuando es true. */
  isToday: boolean;
  spot: number | null;
  delayed: boolean;
  /** Contratos totales del vencimiento (denominador del ranking). */
  contractCount: number;
  /** Strikes con datos frescos de la fuente de datos superpuestos (0 = todo Schwab). */
  realtimeStrikes: number;
  /** Antigüedad del dato fresco más reciente, en segundos. null si no hubo. */
  realtimeAgeSec: number | null;
  lines: ChainLine[];
  summary: ChainSummary;
  /** null si la cadena no trae IV real o el spot no llegó. */
  forecast: ZeroDteForecast | null;
  /** Panorama del próximo tramo (~5 min), en lenguaje llano. */
  outlook: ShortTermOutlook | null;
  /** Flujos de dealer (vanna/charm) — afinan la trayectoria hacia el cierre. */
  dealerFlow: DealerFlow | null;
  /** Pronóstico del strike de cierre — solo activo 3:00-4:00pm ET, si no null. */
  closing: ClosingForecast | null;
  gex: ZeroDteGex;
  /** "Mejor trade ahora": setup pin-al-imán en γ+, o null si no hay / no es hoy. */
  entry: EntryDecision | null;
  /** Riesgo/beneficio del setup (recorrido al target ÷ al stop), o null. */
  entryRR: number | null;
  /** El contrato concreto del setup (GEX Ticket): strike/tipo + entrada/target/stop
   *  en $ de la opción por delta-gamma. null si no hay setup. Lo consume la web y el
   *  bot de Discord desde la MISMA fuente (server), sin duplicar la lógica. */
  ticket: Ticket | null;
  /** Motivo por el que NO hay setup ahora (para mostrarlo), o null. */
  noSetup: string | null;
  /** Sugerencias de estrategia (vertical, credit call, iron condor) sobre la
   *  MISMA cadena — null si no es hoy o no hay spot. Ver strategySuggestions.ts. */
  suggestions: StrategySuggestions | null;
  /** El índice sobre el que se hizo el análisis (SPX/NDX). Igual al ticker salvo
   *  en futuros (/ES→SPX, /NQ→NDX). La persistencia se llavea por este. */
  analysisTicker: string;
  /** Símbolo del futuro (/ES) si se pidió uno, o null. */
  future: string | null;
  /** basis = precio del futuro − índice. 0 si no es futuro. Los niveles se
   *  muestran en términos del futuro sumándolo. */
  basis: number;
  asOf: string;
}

/**
 * Descarga la cadena de UN vencimiento y devuelve la tabla ya ordenada.
 *
 * `targetDate` (YYYY-MM-DD) elige el vencimiento; por defecto, hoy (0DTE). Se
 * descarga SOLO esa fecha (`fromDate = toDate = targetDate`), bajo demanda: cada
 * día es una consulta independiente, así que ver un vencimiento futuro no altera
 * en nada el cálculo de hoy. Al pedir una sola expiración no hace falta el troceo
 * por ventanas de `fetchOptionChain`.
 */
/**
 * Análisis 0DTE de un FUTURO NATIVO (/ES, /NQ). Lee la cadena que streamea
 * Tastytrade (`data/tastytrade-fut/…`): OI, griegos, volumen, agresor y quotes
 * reales por strike, con spot = precio del futuro y basis = 0 (los niveles ya
 * están en términos del futuro). Reutiliza el mismo pipeline que la ruta índice.
 *
 * Si el streamer no tiene archivo (caído / fuera de horario), degrada suave:
 * cadena vacía → GEX vacío, paneles sin dato (no rompe la página).
 */
async function fetchNativeFuture(
  ticker: string,
  now: Date,
  targetDate: string | undefined,
  calibShiftPct: number,
  locale: Lang,
): Promise<ZeroDteResult | null> {
  const future = ticker.trim().toUpperCase();
  const today = etDate(now);
  const day = targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? targetDate : today;
  const isToday = day === today;

  const nf = await loadNativeFuture(future, day);
  // FUENTE PRIMARIA solo si el streamer de Tastytrade está VIVO (archivo fresco).
  // Si no, null → el llamador cae a la alterna (Schwab vía índice). Para fechas
  // pasadas/futuras (no hoy) no hay streamer: también cae a la alterna.
  if (!isToday || !nativeFresh(nf, now.getTime())) return null;

  const exp = nf!.exp ?? day;
  const rows = rowsFromBuckets(nf!.acc.buckets, exp, future);
  if (rows.length === 0) return null; // sin cadena utilizable → alterna
  const spot = nf!.spot ?? null;
  const newestTs = nf?.newestTs ?? 0;
  const realtimeAgeSec = newestTs > 0 ? Math.max(0, Math.round((now.getTime() - newestTs) / 1000)) : null;

  const lines = buildChainTable(rows);
  const iv = spot != null ? atmIV(rows, spot) ?? chainIV(rows, spot) : null;
  const gex = zeroDteGex(rows, spot ?? 0);
  const flow = dealerFlow(rows, spot ?? 0, iv, hoursToClose(now));
  const basis = 0; // spot ya es el futuro; nada que convertir

  // Distancia/stop DINÁMICOS por σ (mismo criterio que el panel en vivo).
  const sigmaClose = isToday && spot != null && iv != null && iv > 0 ? expectedMove(spot, iv, hoursToClose(now) / 24).sigma : null;
  const entryParams = dynamicParams(spot ?? 0, sigmaClose, future);
  const entry = isToday && spot != null
    ? evaluateEntry(spot, gex.regime, gex.kingStrike, gex.flipStrike, entryParams, basis, locale)
    : null;

  return {
    ticker: future,
    expiration: exp,
    isToday,
    spot,
    delayed: false,
    contractCount: rows.length,
    realtimeStrikes: rows.length, // toda la cadena es en vivo (Tastytrade)
    realtimeAgeSec,
    lines,
    summary: summarize(rows),
    forecast: isToday ? buildForecast(spot ?? 0, iv, lines, now, calibShiftPct, basis, locale) : null,
    outlook: isToday ? shortTermOutlook(spot ?? 0, iv, gex, 5, flow, basis, locale) : null,
    dealerFlow: isToday ? flow : null,
    closing: isToday ? closingForecast(spot ?? 0, iv, gex, now, undefined, locale, maxPainStrike(rows, spot ?? 0)) : null,
    gex,
    entry,
    entryRR: entry ? riskReward(entry) : null,
    ticket: buildTicket(lines, entry, spot),
    noSetup: isToday && !entry && spot != null ? noSetupReason(spot, gex.regime, gex.kingStrike, entryParams, locale) : null,
    suggestions: isToday && spot != null ? buildStrategySuggestions(rows, spot, gex, entry, locale) : null,
    analysisTicker: future, // se analiza a sí mismo, ya no vía SPX/NDX
    future,
    basis,
    asOf: now.toISOString(),
  };
}

// Antigüedad máxima (ms) del archivo del streamer de índice para tratarlo como
// VIVO. Escribe cada ~10 s; si supera esto, se considera caído y se cae a Schwab.
const INDEX_STREAM_STALE_MS = Number(process.env.INDEX_STREAM_STALE_MS ?? 180_000);

/**
 * Deriva el spot del índice desde la cadena por PARIDAD PUT-CALL: en un strike K,
 * forward = K + callMid − putMid; para 0DTE (T≈0) forward ≈ spot. Se usa el strike
 * más ATM (donde |call − put| es mínimo → spreads estrechos, mid fiable), y se
 * promedian los strikes contiguos para estabilizar. PURA. null si no hay call+put.
 */
function spotFromChain(rows: Row[]): number | null {
  const byK = new Map<number, { c?: number; p?: number }>();
  for (const r of rows) {
    const mid = r.bid != null && r.ask != null ? (r.bid + r.ask) / 2 : (r.price ?? null);
    if (mid == null || !(mid > 0)) continue;
    const e = byK.get(r.strike) ?? {};
    if (r.contractType === "call") e.c = mid; else e.p = mid;
    byK.set(r.strike, e);
  }
  // forward implícito (K + call − put) por strike, ordenados por cercanía al ATM.
  const fwds = [...byK.entries()]
    .filter(([, e]) => e.c != null && e.p != null)
    .map(([K, e]) => ({ diff: Math.abs((e.c as number) - (e.p as number)), fwd: K + (e.c as number) - (e.p as number) }))
    .sort((a, b) => a.diff - b.diff);
  if (fwds.length === 0) return null;
  // Mediana de los 3 strikes más ATM (robusto ante un mid ruidoso puntual).
  const top = fwds.slice(0, 3).map((x) => x.fwd).sort((a, b) => a - b);
  const spot = top[Math.floor(top.length / 2)];
  return spot > 0 ? spot : null;
}

/**
 * Análisis 0DTE de un ÍNDICE/ETF (SPX, SPY, QQQ) con TASTYTRADE como fuente
 * PRIMARIA: lee los buckets que streamea el streamer de índice (`data/0dte/…`)
 * —OI, griegos, volumen, agresor y quotes reales por strike, EN VIVO— igual que
 * los futuros nativos, cubriendo la ventana ±STREAM_WINDOW ATM (basta para el GEX).
 *
 * Si el stream está caído/viejo, no trae spot, o la fecha no es hoy, devuelve null
 * y el llamador cae a Schwab (la fuente de RESPALDO). Así el dashboard nunca queda
 * vacío y el flip/GEX pasa a ser en vivo (sin el delay de 15 min de Schwab).
 */
async function fetchIndexTastytrade(
  ticker: string,
  now: Date,
  targetDate: string | undefined,
  calibShiftPct: number,
  locale: Lang,
): Promise<ZeroDteResult | null> {
  const today = etDate(now);
  const day = targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? targetDate : today;
  if (day !== today) return null; // el streamer solo tiene hoy → Schwab para otras fechas

  const acc = (await loadFlow(ticker, day)) as FlowAccumulator & { spot?: number | null };
  const ts = Date.parse(acc.updatedAt ?? "");
  if (!Number.isFinite(ts) || now.getTime() - ts >= INDEX_STREAM_STALE_MS) return null; // stream viejo → respaldo

  const rows = rowsFromBuckets(acc.buckets, day, ticker);
  if (rows.length === 0) return null; // sin cadena utilizable → respaldo

  // Spot: del stream si lo trae (SPY/QQQ escriben el quote del ETF); si no lo trae
  // (SPX, cuyo streamer SYSTEM no lo escribe), se DERIVA de la cadena por paridad
  // put-call. Si ni así hay spot → respaldo Schwab.
  const spot = (typeof acc.spot === "number" && acc.spot > 0 ? acc.spot : null) ?? spotFromChain(rows);
  if (spot == null) return null;

  let newestTs = 0;
  for (const b of Object.values(acc.buckets)) if (b && b.ts > newestTs) newestTs = b.ts;
  const realtimeAgeSec = newestTs > 0 ? Math.max(0, Math.round((now.getTime() - newestTs) / 1000)) : null;

  const lines = buildChainTable(rows);
  const iv = atmIV(rows, spot) ?? chainIV(rows, spot);
  const gex = zeroDteGex(rows, spot);
  const flow = dealerFlow(rows, spot, iv, hoursToClose(now));

  const sigmaClose = iv != null && iv > 0 ? expectedMove(spot, iv, hoursToClose(now) / 24).sigma : null;
  const entryParams = dynamicParams(spot, sigmaClose, ticker);
  const entry = evaluateEntry(spot, gex.regime, gex.kingStrike, gex.flipStrike, entryParams, 0, locale);

  return {
    ticker,
    expiration: day,
    isToday: true,
    spot,
    delayed: false,
    contractCount: rows.length,
    realtimeStrikes: rows.length, // toda la cadena es en vivo (Tastytrade)
    realtimeAgeSec,
    lines,
    summary: summarize(rows),
    forecast: buildForecast(spot, iv, lines, now, calibShiftPct, 0, locale),
    outlook: shortTermOutlook(spot, iv, gex, 5, flow, 0, locale),
    dealerFlow: flow,
    closing: closingForecast(spot, iv, gex, now, undefined, locale, maxPainStrike(rows, spot)),
    gex,
    entry,
    entryRR: entry ? riskReward(entry) : null,
    ticket: buildTicket(lines, entry, spot),
    noSetup: !entry ? noSetupReason(spot, gex.regime, gex.kingStrike, entryParams, locale) : null,
    suggestions: buildStrategySuggestions(rows, spot, gex, entry, locale),
    analysisTicker: ticker,
    future: null,
    basis: 0,
    asOf: now.toISOString(),
  };
}

export async function fetchZeroDte(
  ticker: string,
  now: Date = new Date(),
  targetDate?: string,
  calibShiftPct = 0,
  locale: Lang = "es",
): Promise<ZeroDteResult> {
  // FUENTE PRIMARIA = Tastytrade (futuros nativos): /ES y /NQ se analizan sobre
  // sus PROPIAS opciones de futuro (CME) que streamea Tastytrade — cadena, flujo,
  // GEX y pronóstico salen de ahí, con spot = futuro y basis = 0.
  // FUENTE ALTERNA = Schwab: si el streamer está caído/viejo (o NATIVE_FUTURES=0),
  // `fetchNativeFuture` devuelve null y se cae a la ruta de índice (SPX/NDX+basis)
  // de abajo. Así el dashboard nunca queda vacío.
  if (isNativeFuture(ticker)) {
    const native = await fetchNativeFuture(ticker, now, targetDate, calibShiftPct, locale);
    if (native) return native;
    // (sin datos frescos de Tastytrade → alterna Schwab, sigue abajo)
  }

  // Ruta índice (alterna Schwab / no-futuros): la cadena de opciones, el flujo, el
  // GEX y el pronóstico se calculan sobre el índice; al final se suma el basis
  // (futuro − índice) para mostrar los niveles en el futuro.
  const { analysis, future } = resolveTicker(ticker);

  // FUENTE PRIMARIA para índice/ETF (SPX/SPY/QQQ, sin futuro): Tastytrade en vivo.
  // Si su streamer está fresco, la cadena/GEX salen de ahí; si está caído/viejo o
  // es otra fecha, `fetchIndexTastytrade` devuelve null y sigue la ruta Schwab de
  // abajo (respaldo). No aplica al rollback de futuros (future != null → basis).
  if (!future) {
    const idx = await fetchIndexTastytrade(analysis, now, targetDate, calibShiftPct, locale);
    if (idx) return idx;
  }

  if (!analysis.trim()) throw new TastytradeError("Ticker vacío.");
  const today = etDate(now);
  const day = targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? targetDate : today;
  const isToday = day === today;

  // Cadena del vencimiento desde Tastytrade (antes Schwab, 15 min retrasada).
  const parsed = await fetchChainTasty(analysis, day);
  const chainRows = parsed.contracts.map(toRow);

  // Superpone el acumulado del streamer (agresor/flujo) si está corriendo. Solo
  // para el vencimiento de hoy — el acumulado es intradía.
  let rows = chainRows;
  let realtimeStrikes = 0;
  let realtimeAgeSec: number | null = null;
  if (isToday) {
    const acc = await loadFlow(analysis, day).catch(() => null);
    const ov = overlayRealtime(chainRows, acc);
    rows = ov.rows;
    realtimeStrikes = ov.realtimeStrikes;
    if (ov.newestTs > 0) realtimeAgeSec = Math.max(0, Math.round((now.getTime() - ov.newestTs) / 1000));
  }

  const lines = buildChainTable(rows);

  // IV at-the-money del día. Si no hay OI junto al dinero se cae a la ventana
  // ancha de `chainIV`, que es peor pero mejor que quedarse sin pronóstico.
  const spot = parsed.underlyingPrice ?? spotFromChain(rows);
  const iv = spot != null ? atmIV(rows, spot) ?? chainIV(rows, spot) : null;
  const gex = zeroDteGex(rows, spot ?? 0);
  const flow = dealerFlow(rows, spot ?? 0, iv, hoursToClose(now));

  // Basis en vivo del futuro (futuro − índice). Se recalcula en cada carga
  // porque el cost-of-carry cambia día a día. Si el quote del futuro falla, 0
  // (los niveles se muestran en términos del índice, degradación segura).
  let basis = 0;
  if (future && spot != null) {
    const futPrice = await fetchFuturePriceTasty(future).catch(() => null);
    if (futPrice != null) basis = futPrice - spot;
  }

  // "Mejor trade ahora": mismo cálculo que el panel en vivo de la página.
  const sigmaClose = isToday && spot != null && iv != null && iv > 0 ? expectedMove(spot, iv, hoursToClose(now) / 24).sigma : null;
  const entryParams = dynamicParams(spot ?? 0, sigmaClose, ticker);
  const entry = isToday && spot != null
    ? evaluateEntry(spot, gex.regime, gex.kingStrike, gex.flipStrike, entryParams, basis, locale)
    : null;

  return {
    ticker: ticker.toUpperCase(),
    expiration: day,
    isToday,
    spot,
    delayed: false, // Tastytrade es tiempo real
    contractCount: rows.length,
    /** Strikes con datos del streamer de flujo (0 = solo la foto de Tastytrade). */
    realtimeStrikes,
    /** Antigüedad del dato fresco más reciente, en segundos. null si no hubo. */
    realtimeAgeSec,
    lines,
    summary: summarize(rows),
    // Paneles intradía solo en 0DTE: en un vencimiento futuro no aplican.
    forecast: isToday ? buildForecast(spot ?? 0, iv, lines, now, calibShiftPct, basis, locale) : null,
    outlook: isToday ? shortTermOutlook(spot ?? 0, iv, gex, 5, flow, basis, locale) : null,
    dealerFlow: isToday ? flow : null,
    closing: isToday ? closingForecast(spot ?? 0, iv, gex, now, undefined, locale, maxPainStrike(rows, spot ?? 0)) : null,
    gex,
    entry,
    entryRR: entry ? riskReward(entry) : null,
    ticket: buildTicket(lines, entry, spot),
    noSetup: isToday && !entry && spot != null ? noSetupReason(spot, gex.regime, gex.kingStrike, entryParams, locale) : null,
    suggestions: isToday && spot != null ? buildStrategySuggestions(rows, spot, gex, entry, locale) : null,
    analysisTicker: analysis.toUpperCase(),
    future,
    basis,
    asOf: now.toISOString(),
  };
}
