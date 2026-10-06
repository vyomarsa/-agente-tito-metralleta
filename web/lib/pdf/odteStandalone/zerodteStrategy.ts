// ============================================================================
// Estrategia "pin al imán en γ+" — lógica PURA, sin dependencias de servidor.
//
// Vive aparte del simulador (zerodteSim.ts, que usa fs) para poder importarse
// también en el CLIENTE: el panel "mejor trade ahora" la evalúa en vivo en cada
// refresco, sin llamar al servidor.
// ============================================================================

import type { Lang } from "./i18n";

export type Direction = "long" | "short";

/** Parámetros de la estrategia (todos en PUNTOS de SPX). Tunables. */
export interface SimParams {
  /** Distancia mínima al imán para que haya ventaja (si el precio ya está
   *  encima del imán, no hay recorrido que capturar). */
  minGapPts: number;
  /** Stop fijo cuando no hay un flip útil del lado correcto. */
  fixedStopPts: number;
  /** Distancia MÍNIMA del stop a la entrada. Un stop de 2 pts saltaría al
   *  instante y haría la simulación inútil. */
  minStopPts: number;
  /** R:B mínimo para mostrar el trade como "listo" (gate #5). */
  minRR: number;
  /** Velocidad de volumen a partir de la cual el agresor en contra "pesa" (gate #1). */
  flowFastVel: number;
  /** Fracción de dominancia de bursts para considerar el flujo en contra (gate #2). */
  flowBurstShare: number;
  /** Piso de |Net GEX| para fiarse del pin; 0 = desactivado (gate #3, tunable por ticker). */
  netGexFloor: number;
}

export const DEFAULT_PARAMS: SimParams = {
  minGapPts: 5, fixedStopPts: 15, minStopPts: 8,
  minRR: 1.2, flowFastVel: 1.5, flowBurstShare: 0.60, netGexFloor: 0,
};

// Fracción de σ (expected move a cierre) que escala cada distancia. Tunables.
const GAP_SIGMA_K = 0.5;   // distancia de activación al imán
const FIXED_SIGMA_K = 0.6; // stop fijo (cuando el flip no sirve)
const MINSTOP_SIGMA_K = 0.3; // stop mínimo
// SPX: el usuario considera bueno un fade de ~10 pts. Por eso su activación es
// FLAT a 10 (no escala hacia arriba con σ) y su R:B se afloja a 0.65 — así 10 pts
// contra el stop ancho (15) = R:B 0.67 muestra READY. Los stops quedan anchos; en
// vol extrema el stop se ensancha y el R:B auto-suprime el 10-pt (protección natural).
const SPX_MIN_RR = 0.65;
// Umbral de dominancia del premium agresivo para llamar "dirección" en el gate #1
// (mismo que la Opción A del flujo alterno: ≥58% de un lado = direccional).
const FLOW_DIR_MIN = 0.58;

/**
 * Parámetros DINÁMICOS por volatilidad. El fijo de 5 pts estaba mis-calibrado
 * entre tickers (5 pts = 0.06% en SPX pero 0.65% en SPY). Ahora la distancia de
 * activación y los stops se escalan con σ (expected move a cierre) — más recorrido
 * exigido cuando hay más vol — con un PISO por instrumento para que nunca sea
 * absurdamente chico. SPX usa 10/15/8 pts fijos (petición del usuario); los demás
 * escalan esos mismos pisos por su precio (misma proporción ≈ 0.13%/0.19%/0.10%).
 */
export function dynamicParams(spot: number, sigma: number | null, ticker: string): SimParams {
  const s = sigma != null && sigma > 0 ? sigma : 0;
  const isSpx = ticker.trim().toUpperCase().replace(/^\//, "") === "SPX";
  const gapFloor = isSpx ? 10 : spot * 0.0013;
  const fixedFloor = isSpx ? 15 : spot * 0.0019;
  const minStopFloor = isSpx ? 8 : spot * 0.0010;
  return {
    ...DEFAULT_PARAMS,
    // SPX: activación FLAT a 10 (no sube con σ) para permitir fades de 10 pts;
    // los demás sí escalan la distancia de activación con σ.
    minGapPts: isSpx ? gapFloor : Math.max(gapFloor, GAP_SIGMA_K * s),
    fixedStopPts: Math.max(fixedFloor, FIXED_SIGMA_K * s),
    minStopPts: Math.max(minStopFloor, MINSTOP_SIGMA_K * s),
    // SPX afloja el R:B (0.65) para que un fade de 10 pts pase el gate; el resto 1.2.
    minRR: isSpx ? SPX_MIN_RR : DEFAULT_PARAMS.minRR,
  };
}

export interface EntryDecision {
  direction: Direction;
  entry: number;
  target: number;
  stop: number;
  reason: string;
}

/**
 * ¿Hay entrada AHORA con la señal dada? Estrategia pin-al-imán en γ+. PURA.
 *
 * Solo en gamma positiva y solo si el precio está a `minGapPts` o más del imán.
 * Se apuesta a que el precio VUELVE al imán: short si está por encima, long si
 * por debajo. El stop es el flip si cae del lado correcto y con margen; si no,
 * un stop fijo — nunca más pegado que `minStopPts`. Devuelve null si no hay setup.
 */
export function evaluateEntry(
  spot: number,
  regime: "positive" | "negative",
  magnet: number | null,
  flip: number | null,
  params: SimParams = DEFAULT_PARAMS,
  // Solo para el TEXTO del `reason`: en futuros (/ES, /NQ) el imán se cita en el
  // precio del futuro (índice + basis, tick 0.25). entry/target/stop se quedan
  // en el índice — el consumidor les aplica el basis. Con basis 0 es identidad.
  basis = 0,
  locale: Lang = "es",
): EntryDecision | null {
  if (!(spot > 0) || regime !== "positive" || magnet == null) return null;
  const gap = Math.abs(spot - magnet);
  if (gap < params.minGapPts) return null;

  const direction: Direction = spot > magnet ? "short" : "long";
  const target = magnet;

  let stop: number;
  if (direction === "short") {
    const cand = flip != null && flip > spot ? flip : spot + params.fixedStopPts;
    stop = Math.max(cand, spot + params.minStopPts);
  } else {
    const cand = flip != null && flip < spot ? flip : spot - params.fixedStopPts;
    stop = Math.min(cand, spot - params.minStopPts);
  }

  const mDisp = basis ? Math.round((magnet + basis) * 4) / 4 : magnet;
  const reason =
    locale === "es"
      ? `γ+ y el precio está ${gap.toFixed(0)} pts ${direction === "short" ? "por encima" : "por debajo"} del imán ${mDisp}; se apuesta a la vuelta al imán.`
      : `γ+ and price is ${gap.toFixed(0)} pts ${direction === "short" ? "above" : "below"} the magnet ${mDisp}; betting on the return to the magnet.`;

  return { direction, entry: spot, target, stop, reason };
}

// ============================================================================
// Capa de GATE en vivo: la reversión al imán (evaluateEntry) es la tesis BASE,
// pero solo tiene ventaja cuando la cinta NO corre en contra. Aquí se filtra con
// las señales de momentum/flujo que la estrategia base ignora, para no recomendar
// "puts al imán" mientras el precio sube sin parar. evaluateEntry queda intacto
// (lo usa el backtest); esto es la capa que consume el panel en vivo.
// ============================================================================

/** Contexto de flujo/momentum para el gate (todo opcional; lo que falte no filtra). */
export interface FlowCtx {
  /** Agresor neto (CVD): >0 compra, <0 venta. */
  cvd?: number | null;
  /** Velocidad de volumen (×). Alta = el CVD en contra pesa. */
  velocity?: number | null;
  /** Premium agresivo alcista de los bursts (calls compradas + puts vendidas). */
  burstBull?: number | null;
  /** Premium agresivo bajista de los bursts. */
  burstBear?: number | null;
  /** Net GEX total (fuerza del pin). */
  netGex?: number | null;
}

export type EntryStatus = "ready" | "wait";

export interface LiveVerdict {
  status: EntryStatus;   // "ready" = entrar; "wait" = hay setup base pero el flujo/odds lo frenan
  reason: string;        // por qué (listo, o por qué esperar)
  rr: number;            // riesgo/beneficio del setup base
}

/**
 * Aplica los gates a un setup base (de evaluateEntry) con el flujo en vivo. PURA.
 * Suprime el trade (status "wait") si: R:B bajo (#5); el agresor/CVD va fuerte en
 * contra (#1); los bursts dominan en contra (#2); el flip está entre el precio y el
 * imán —habría que cruzar la zona de aceleración— o el pin es débil (#3).
 */
export function gateEntry(
  d: EntryDecision,
  ctx: FlowCtx,
  flip: number | null,
  params: SimParams = DEFAULT_PARAMS,
  locale: Lang = "es",
): LiveVerdict {
  const es = locale === "es";
  const rr = riskReward(d);
  const short = d.direction === "short";

  // #5 Riesgo/beneficio: poco recorrido al imán para el riesgo → esperar mejor precio.
  if (rr < params.minRR) {
    return { status: "wait", rr, reason: es
      ? `R:B bajo (${rr.toFixed(1)}:1) — poco recorrido al imán para el riesgo; espera mejor precio.`
      : `Low R:R (${rr.toFixed(1)}:1) — too little room to the magnet for the risk; wait for a better price.` };
  }

  // #3 Flip entre el precio y el imán: para llegar al objetivo habría que cruzar la
  // zona de inversión (cambia de régimen) → la tesis del pin no es limpia.
  if (flip != null) {
    const crosses = short ? (flip < d.entry && flip > d.target) : (flip > d.entry && flip < d.target);
    if (crosses) {
      return { status: "wait", rr, reason: es
        ? `El flip (${flip.toFixed(0)}) está entre el precio y el imán — para llegar habría que cruzar la zona de aceleración; el pin no es limpio.`
        : `The flip (${flip.toFixed(0)}) sits between price and magnet — reaching it means crossing the acceleration zone; the pin isn't clean.` };
    }
  }

  // #1 Flujo agresivo fuerte y RÁPIDO en contra del pin. La DIRECCIÓN sale del
  // premium agresivo BIEN CLASIFICADO (burstBull = call-buy + put-sell; burstBear =
  // put-buy + call-sell), NO del signo del CVD — que es ciego a call/put y se INVIERTE
  // con flujo de puts (vender puts = alcista pero baja el CVD). La velocidad del
  // volumen (`velocity`) mide "qué tan rápido/fuerte" corre la cinta.
  const vel = ctx.velocity ?? 1;
  const bb1 = ctx.burstBull ?? 0, br1 = ctx.burstBear ?? 0, bt1 = bb1 + br1;
  if (bt1 > 0 && vel >= params.flowFastVel) {
    const bull = bb1 / bt1;
    const against = short ? bull >= FLOW_DIR_MIN : bull <= 1 - FLOW_DIR_MIN;
    if (against) {
      const w = short ? (es ? "alcista" : "bullish") : (es ? "bajista" : "bearish");
      return { status: "wait", rr, reason: es
        ? `El flujo agresivo va ${w} con fuerza (vel ${vel.toFixed(1)}×) EN CONTRA del pin — espera que la cinta se calme o gire hacia el imán.`
        : `Aggressive flow is ${w} hard (vel ${vel.toFixed(1)}×) AGAINST the pin — wait for the tape to calm or turn toward the magnet.` };
    }
  }

  // #2 Flujo agresivo (bursts) dominando EN CONTRA.
  const bb = ctx.burstBull ?? 0, br = ctx.burstBear ?? 0, bt = bb + br;
  if (bt > 0) {
    const bull = bb / bt;
    const againstShare = short ? bull : 1 - bull; // fracción del flujo que empuja en contra
    if (againstShare >= params.flowBurstShare) {
      return { status: "wait", rr, reason: es
        ? `El flujo agresivo domina ${short ? "alcista" : "bajista"} (${Math.round(againstShare * 100)}%) contra el pin — espera a que se agote o gire.`
        : `Aggressive flow dominates ${short ? "bullish" : "bearish"} (${Math.round(againstShare * 100)}%) against the pin — wait for it to exhaust or turn.` };
    }
  }

  // #3 Pin débil (Net GEX por debajo del piso). Desactivado por defecto (floor 0).
  if (params.netGexFloor > 0 && ctx.netGex != null && Math.abs(ctx.netGex) < params.netGexFloor) {
    return { status: "wait", rr, reason: es
      ? `Pin débil (Net GEX bajo) — la gravedad al imán es floja; mejor no fadear.`
      : `Weak pin (low Net GEX) — magnet gravity is soft; better not to fade.` };
  }

  return { status: "ready", rr, reason: d.reason };
}

/** Riesgo/beneficio: recorrido al objetivo ÷ recorrido al stop. PURA. */
export function riskReward(d: EntryDecision): number {
  const reward = Math.abs(d.target - d.entry);
  const risk = Math.abs(d.stop - d.entry);
  return risk > 0 ? reward / risk : 0;
}

/** Por qué NO hay setup ahora (para mostrarlo en el panel en vivo). PURA. */
export function noSetupReason(
  spot: number | null,
  regime: "positive" | "negative",
  magnet: number | null,
  params: SimParams = DEFAULT_PARAMS,
  locale: Lang = "es",
): string {
  const es = locale === "es";
  if (regime === "negative") return es ? "GEX negativo — el pin no aplica (régimen de aceleración)" : "GEX negative — the pin doesn't apply (acceleration regime)";
  if (magnet == null) return es ? "sin imán de gamma identificable" : "no identifiable gamma magnet";
  if (spot == null || !(spot > 0)) return es ? "sin precio" : "no price";
  const gap = Math.abs(spot - magnet);
  if (gap < params.minGapPts) {
    // "Pegado" solo si el gap es realmente chico. Con sustancia pero bajo el
    // umbral dinámico (0.5σ) es "estiramiento insuficiente" — no está pegado,
    // le falta recorrido relativo a la vol de hoy. Se muestra el umbral objetivo.
    const gluedCut = Math.max(3, 0.25 * params.minGapPts);
    const need = params.minGapPts.toFixed(0);
    if (gap < gluedCut) {
      return es ? `el precio está pegado al imán (${gap.toFixed(0)} pts) — sin recorrido` : `price is glued to the magnet (${gap.toFixed(0)} pts) — no room`;
    }
    return es
      ? `estiramiento insuficiente: ${gap.toFixed(0)} de ${need} pts — el fade necesita más recorrido vs la vol de hoy`
      : `not enough stretch: ${gap.toFixed(0)} of ${need} pts — the fade needs more room vs today's vol`;
  }
  return es ? "sin condiciones de entrada" : "no entry conditions";
}
