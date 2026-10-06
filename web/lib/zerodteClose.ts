// ============================================================================
// Tarjeta de cierre del 0DTE — Max Pain + Charm.
//
// Amplía el GEX Pinning que ya existe (`pinning` en zerodteSignals.ts) con los
// dos predictores que le faltaban para la última hora:
//
//   · MAX PAIN — el precio donde el valor INTRÍNSECO total de las opciones en
//     manos de los compradores es MÍNIMO. Es el predictor clásico de cierre y
//     mide algo DISTINTO del imán de gamma: el imán mide la cobertura viva del
//     dealer, el Max Pain mide el Open Interest acumulado. Que los dos coincidan
//     es confluencia (dos métodos independientes de acuerdo); que diverjan es
//     información igual de útil.
//
//   · CHARM — la variación del delta por el paso del TIEMPO. Es EL griego del
//     0DTE: escala como 1/T, así que a media sesión es leve y en la última hora
//     domina. Cuando el delta de las opciones se desvanece, el dealer deshace
//     cobertura, y ese flujo mecánico empuja el precio. El signo dice hacia
//     dónde: OI de puts OTM decayendo → el dealer recompra → deriva alcista
//     (el "melt-up" de fin de día); OI de calls OTM → vende → deriva bajista.
//
// El MOC (imbalance de cierre de las 3:50pm ET) NO vive aquí: no hay fuente de
// datos que lo dé en Tastytrade ni en MarketSnack, así que lo pega el usuario a
// mano en la tarjeta y se guarda solo en su navegador. Ver `app/0dte/page.tsx`.
//
// Todo PURO y testeable. La I/O vive en `lib/zerodteScan.ts`.
// ============================================================================

import { bsCharm } from "./blackScholes";
import type { ZeroDteAnalysis, ZeroDteStrike } from "./zerodte";

/** Ventana ±% del spot donde se busca el cierre. El cierre de HOY no se va más
 *  lejos, y un muro de OI remoto no fija la sesión. */
export const CLOSE_NEAR_PCT = 0.03;

/** Minutos antes del cierre en que el pronóstico entra en vigor (15:00 ET). */
export const CLOSING_WINDOW_MIN = 60;

/** Minutos de una sesión completa (9:30–16:00 ET). Se define aquí y no se
 *  importa de `zerodteScan` porque ese módulo SÍ importa este: evita el ciclo. */
const SESSION_MINUTES = 390;

/** Suelo del tiempo restante para el charm: sin él, 1/T dispara a infinito en
 *  el último tick y la barra de intensidad se vuelve basura. */
export const MIN_CHARM_MINUTES = 1;

/**
 * Fase del pronóstico:
 *  - pending: antes de las 15:00 ET. Max Pain y charm ya se calculan, pero la
 *    confianza se queda en baja: a esa hora el gamma del 0DTE aún se mueve mucho.
 *  - live: 15:00–16:00 ET. El pronóstico está en vigor y converge.
 *  - final: sesión cerrada.
 */
export type ClosePhase = "pending" | "live" | "final";

export interface ZeroDteCharm {
  /** Charm neto ESTRUCTURAL (+call/−put, ponderado por OI), como el GEX.
   *  NO es la dirección del cierre — para eso está `flow`. */
  netCharm: number;
  /** Rebalanceo del dealer hacia el cierre = −Σ charm·OI (sin signo por tipo).
   *  >0 = compra neta (sesgo alcista); <0 = venta neta (bajista). */
  flow: number;
  /** Dirección de `flow`. null si es despreciable. */
  dir: "up" | "down" | null;
  /** Intensidad del efecto AHORA (0-1). Crece hacia el cierre. */
  intensity: number;
  /** Cuántos strikes entraron al cálculo (cerca del dinero y con OI). */
  strikes: number;
}

export interface ZeroDteClose {
  phase: ClosePhase;
  minutesLeft: number;
  spot: number;
  /** Imán de gamma, tal cual lo trae el análisis. */
  magnet: number | null;
  /** Max Pain por Open Interest. null si la cadena no trae OI cerca del dinero. */
  maxPain: number | null;
  /** Max Pain e imán a ±1 strike y en γ+: los dos métodos apuntan al mismo sitio. */
  confluence: boolean;
  regime: "positive" | "negative";
  /**
   * Cierre estimado crudo. NO se redondea a strike a propósito: el strike de
   * cierre lo publica `pinning` (zerodteSignals) y dos cifras rivales para lo
   * mismo en la misma tarjeta se leen como un error. Aquí sirve para saber hacia
   * dónde arrastra el imán y para redactar la nota.
   */
  estimate: number;
  /**
   * Rango ~68% (1σ) al cierre. Se copia TAL CUAL de `expectedRange` del análisis,
   * sin redondear al grid de strikes: con σ (0,52 pts en SPY al filo del cierre)
   * menor que el salto entre strikes ($1), redondear empuja las DOS puntas al
   * mismo lado y la banda 769,53–770,57 se enseñaba como 770–771. Un rango de
   * PRECIO no tiene por qué caer en un strike.
   */
  rangeLow: number;
  rangeHigh: number;
  /** σ en puntos. Es el MISMO cono que enseña `expectedRange`, no otro. */
  sigma: number;
  /** Salto entre strikes de la cadena. Redondea y define qué es "1 strike". */
  step: number;
  confidence: "baja" | "media" | "alta";
  charm: ZeroDteCharm | null;
  note: string;
}

/**
 * Salto entre strikes de la cadena (mediana de las diferencias). Se mide en vez
 * de asumirse: SPY va de 1 en 1, SPX de 5 en 5, y un IWM ilíquido puede saltar.
 * PURA.
 */
export function strikeStep(strikes: ZeroDteStrike[]): number {
  const ks = strikes.map((s) => s.strike).sort((a, b) => a - b);
  const diffs: number[] = [];
  for (let i = 1; i < ks.length; i++) {
    const d = ks[i] - ks[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 1;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/**
 * Max Pain: el precio de cierre donde el valor intrínseco total en manos de los
 * compradores es MÍNIMO. Para cada strike candidato P:
 *
 *     dolor(P) = Σ_K  max(0, P−K)·OI_call(K)  +  max(0, K−P)·OI_put(K)
 *
 * El argmin es el Max Pain. Solo strikes dentro de ±`nearPct` del spot. PURA.
 */
export function maxPainStrike(
  strikes: ZeroDteStrike[],
  spot: number,
  nearPct: number = CLOSE_NEAR_PCT,
): number | null {
  if (!(spot > 0) || strikes.length === 0) return null;
  const lo = spot * (1 - nearPct);
  const hi = spot * (1 + nearPct);

  const near = strikes.filter(
    (s) =>
      s.strike >= lo &&
      s.strike <= hi &&
      ((s.call?.openInterest ?? 0) > 0 || (s.put?.openInterest ?? 0) > 0),
  );
  if (near.length === 0) return null;

  let best: number | null = null;
  let bestPain = Infinity;
  for (const p of near) {
    let pain = 0;
    for (const k of near) {
      if (p.strike > k.strike) pain += (p.strike - k.strike) * (k.call?.openInterest ?? 0);
      else if (p.strike < k.strike) pain += (k.strike - p.strike) * (k.put?.openInterest ?? 0);
    }
    if (pain < bestPain) {
      bestPain = pain;
      best = p.strike;
    }
  }
  return best;
}

/**
 * Agrega el charm de la cadena del día como flujo de cobertura del dealer. PURA.
 *
 * Convención estándar: el dealer está CORTO las opciones que el público compra,
 * así que cubre con +Δ. Al pasar el tiempo el delta cambia en −charm, y el
 * dealer ajusta comprando/vendiendo por −charm·OI. NO es una certeza sobre el
 * posicionamiento real de cada dealer: es el modelo agregado, y lo que sale es
 * una TENDENCIA probabilística.
 *
 * `iv` debe ser la que COBRA la cadena (`chainIv`), no la realizada: el charm es
 * cobertura, y se cubre contra el precio del mercado.
 */
export function dealerCharm(
  strikes: ZeroDteStrike[],
  spot: number,
  iv: number,
  minutesLeft: number,
  nearPct: number = CLOSE_NEAR_PCT,
): ZeroDteCharm | null {
  if (!(spot > 0) || !(iv > 0) || minutesLeft <= 0) return null;

  const lo = spot * (1 - nearPct);
  const hi = spot * (1 + nearPct);
  // Tiempo de CALENDARIO hasta las 4pm, en años: el charm decae por reloj de
  // pared, no por fracción de sesión.
  const T = Math.max(minutesLeft, MIN_CHARM_MINUTES) / (60 * 24 * 365);

  let netCharm = 0;
  let flow = 0;
  let totalOi = 0;
  let n = 0;
  for (const s of strikes) {
    if (s.strike < lo || s.strike > hi) continue;
    const callOi = s.call?.openInterest ?? 0;
    const putOi = s.put?.openInterest ?? 0;
    if (callOi <= 0 && putOi <= 0) continue;
    // Con q = r = 0 el charm es el MISMO para call y put (Δ_put = Δ_call − 1),
    // así que basta calcularlo una vez por strike.
    //
    // Cerca del vencimiento esto se apaga solo a pocos strikes del dinero, y así
    // debe ser: un strike muy OTM ya tiene delta 0 y uno muy ITM ya tiene delta
    // 1 — a ninguno le queda delta que decaer, luego no generan cobertura.
    const ch = bsCharm(spot, s.strike, T, iv);
    if (ch === 0) continue;
    netCharm += ch * (callOi - putOi);
    flow += -ch * (callOi + putOi);
    totalOi += callOi + putOi;
    n++;
  }
  if (n === 0) return null;

  // Charm ~ 1/T: leve a media sesión, pleno en la última hora.
  const intensity = Math.max(0, Math.min(1, 1 - minutesLeft / SESSION_MINUTES));
  // El umbral va RELATIVO al OI de la ventana: un flujo absoluto de 1e-9 no
  // significa lo mismo en SPY (millones de contratos) que en IWM.
  const dir: "up" | "down" | null =
    Math.abs(flow) < 1e-6 * totalOi ? null : flow > 0 ? "up" : "down";

  return { netCharm, flow, dir, intensity, strikes: n };
}

export interface ZeroDteCloseInput {
  a: ZeroDteAnalysis;
  minutesLeft: number;
  /** Solo el vencimiento de HOY tiene cierre que pronosticar. */
  isToday: boolean;
}

/**
 * Pronóstico del cierre. PURA. Devuelve null cuando no aplica (vencimiento
 * futuro o spot inservible).
 *
 * En γ+ el precio tiende al imán, y el estimado se acota al alcance de 2σ que
 * queda: por eso CONVERGE — según pasa el tiempo σ se encoge y el estimado se
 * afina. En γ− no hay pin: el mejor estimado es el precio actual y la confianza
 * baja. El σ es exactamente el de `expectedRange`, para que esta tarjeta y la de
 * escenarios nunca se contradigan.
 */
export function closeForecast(input: ZeroDteCloseInput): ZeroDteClose | null {
  const { a, minutesLeft, isToday } = input;
  if (!isToday || !(a.spot > 0)) return null;

  const phase: ClosePhase =
    minutesLeft <= 0 ? "final" : minutesLeft <= CLOSING_WINDOW_MIN ? "live" : "pending";

  const step = strikeStep(a.strikes);
  const maxPain = maxPainStrike(a.strikes, a.spot);
  // El charm se cubre contra lo que cobra la cadena; `a.iv` (realizada) es para
  // proyectar el cono, no para cubrir.
  const ivHedge = a.chainIv > 0 ? a.chainIv : a.iv;
  const charm = dealerCharm(a.strikes, a.spot, ivHedge, minutesLeft);

  const sigma = (a.spot * a.expectedRange.sigmaPct) / 100;
  const magnet = a.magnet;
  const pinned = a.regime === "positive" && magnet != null;

  // Cuánto puede moverse, como mucho, en lo que queda.
  const reach = 2 * sigma;
  const estimate = pinned
    ? Math.min(a.spot + reach, Math.max(a.spot - reach, magnet as number))
    : a.spot;

  const confluence = pinned && maxPain != null && Math.abs(maxPain - (magnet as number)) <= step;

  let confidence: "baja" | "media" | "alta" = "baja";
  if (phase === "live" && pinned) confidence = minutesLeft <= 15 ? "alta" : "media";

  const pts = (v: number) => v.toFixed(v >= 100 ? 0 : 2);
  // La nota es lo Único que se lee de un vistazo, así que tiene que decir la
  // verdad de la FASE: con la sesión cerrada, "quedan 0 min y el margen es ±0,52"
  // se lee como un pronóstico vivo cuando ya no queda nada que pronosticar.
  let note: string;
  if (phase === "final") {
    note =
      `Sesión cerrada: el vencimiento de hoy ya expiró. Lo de abajo es la foto del ` +
      `posicionamiento con el que cerró (${a.regime === "positive" ? "γ+" : "γ−"}).`;
  } else if (pinned) {
    note =
      `γ+ : los dealers tienden a anclar el cierre cerca de ${pts(magnet as number)}. ` +
      `Quedan ${minutesLeft.toFixed(0)} min y el margen de movimiento es ±${sigma.toFixed(2)} pts.` +
      (phase === "pending" ? " El pronóstico entra en vigor a las 15:00 ET." : "");
  } else {
    note = `γ− : sin anclaje fiable. El mejor estimado es el precio actual y un rompimiento puede alejarlo.`;
  }

  if (maxPain != null) {
    note += confluence
      ? ` Max Pain (OI) coincide en ${pts(maxPain)} → confluencia, pin más firme.`
      : ` Max Pain (OI) en ${pts(maxPain)}.`;
  }
  if (charm?.dir != null) {
    const alcista = charm.dir === "up";
    note +=
      ` Charm al ${(charm.intensity * 100).toFixed(0)}% de intensidad: el dealer ` +
      `${alcista ? "recompra" : "vende"} cobertura, empuje ${alcista ? "alcista" : "bajista"}` +
      `${pinned ? " que en γ+ suele absorberse contra los muros" : ""}.`;
  }

  return {
    phase,
    minutesLeft,
    spot: a.spot,
    magnet,
    maxPain,
    confluence,
    regime: a.regime,
    estimate,
    rangeLow: a.expectedRange.low,
    rangeHigh: a.expectedRange.high,
    sigma,
    step,
    confidence,
    charm,
    note,
  };
}
