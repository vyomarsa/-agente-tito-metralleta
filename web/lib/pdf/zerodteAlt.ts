// ============================================================================
// Capa ALTERNA (experimental, no-destructiva) del Agente 0DTE — versiones del
// "próximo tramo" y del "mejor trade" que SÍ usan el flujo en vivo (CVD +
// premium clasificado), para compararlas contra las originales sin tocarlas.
// PURA (sin fs/servidor): se evalúa en el cliente en cada refresco.
//
//  1) altOutlook: mezcla el lean del GEX con el lean del flujo, ponderado por
//     un peso `w` que se auto-activa (alto en γ− y con cinta fuerte; ~0 en calma).
//  2) despinEstimate: si el precio ROMPE el pin en la dirección del flujo, a
//     dónde tiende (muro de gamma o movimiento medido).
//  3) momentumEntry: en γ− (aceleración), si el flujo confirma una ruptura,
//     sugiere un trade de MOMENTUM a favor (donde la original dice "no operar").
//
// Adaptación respecto al proyecto standalone: allá `burstBull`/`burstBear` son
// PREMIUM ($) de "bursts" — clusters de órdenes grandes y recientes, detectados
// sobre el Flow Feed trade a trade. Visionary Trades no tiene ese feed para
// 0DTE (su acumulador, `lib/zerodteFlow.ts`, guarda CONTRATOS por ask/bid/mid
// desde la apertura, no premium por trade individual). Acá `burstBull`/
// `burstBear` son CONTRATOS clasificados acumulados de la SESIÓN completa
// (`classifiedFlow` en zerodteFlow.ts) — misma clasificación (call comprado +
// put vendido = alcista), menos sensible a un giro de último minuto que la
// versión de bursts recientes, pero con datos 100% reales de MarketSnack, no
// inventados. Se documenta acá para no confundirlo con el original si se
// compara código.
// ============================================================================

import type { Direction, EntryDecision } from "./zerodteStrategy";

export type Lean = "alcista" | "bajista" | "lateral";
export type Conf = "baja" | "media" | "alta";

export interface AltFlowCtx {
  regime: "positive" | "negative";
  /** Agresor neto acumulado (>0 compra, <0 venta). Ciego a call/put: NO se usa
   *  para dirección (ver flowLean), solo como magnitud/fuerza. */
  cvd: number | null;
  /** Dominancia del CVD 0-1 = |ask−bid|/total — fuerza, no dirección. */
  cvdDom?: number | null;
  /** Velocidad de volumen (×) del último ciclo vs el resto de la ventana. */
  velocity: number | null;
  /** Contratos clasificados alcistas (calls comprados + puts vendidos) de la sesión. */
  burstBull: number;
  /** Contratos clasificados bajistas (puts comprados + calls vendidos) de la sesión. */
  burstBear: number;
  netGex: number | null;
  spot: number;
  magnet: number | null;
  /** Expected move a cierre (pts). */
  sigma: number | null;
}

// Dominancia de CVD que cuenta como fuerza PLENA (1.0). Más bajo = el CVD pesa
// más (dispara con menos desbalance); más alto = exige agresor más de un lado.
export const CVD_FULL = 0.15;

// Umbrales de dominancia del flujo clasificado para llamar dirección: ≥58%
// alcista, ≤42% bajista, en medio = lateral.
export const FLOW_BULL = 0.58;
export const FLOW_BEAR = 0.42;

/** Peso del flujo 0-1: cuánto pesa el CVD/flujo clasificado en la lectura. Se auto-activa. */
export function flowWeight(ctx: AltFlowCtx): number {
  const vel = ctx.velocity ?? 1;
  const velC = Math.max(0, Math.min(1, (vel - 1) / 1.5)); // vel 1→0, 2.5→1
  const bt = ctx.burstBull + ctx.burstBear;
  const burstDom = bt > 0 ? Math.abs(ctx.burstBull - ctx.burstBear) / bt : 0; // 0-1
  const cvdC = ctx.cvdDom != null ? Math.max(0, Math.min(1, ctx.cvdDom / CVD_FULL)) : 0;
  const strength = Math.max(velC, burstDom, cvdC); // la señal de flujo más fuerte disponible
  const regimeFactor = ctx.regime === "negative" ? 1 : 0.55; // γ−: el flujo manda; γ+: el pin lo amortigua
  let w = regimeFactor * strength;
  // En γ+ pegado al imán el pin domina → baja el peso del flujo.
  if (ctx.regime === "positive" && ctx.magnet != null && ctx.sigma != null && ctx.sigma > 0) {
    if (Math.abs(ctx.spot - ctx.magnet) / ctx.sigma < 0.3) w *= 0.5;
  }
  return Math.max(0, Math.min(1, w));
}

/**
 * Dirección del flujo. Sale del flujo YA clasificado (`burstBull` = calls
 * comprados + puts vendidos; `burstBear` = puts comprados + calls vendidos),
 * NO del signo del CVD. El CVD (ask−bid) es ciego al call/put y su signo se
 * INVIERTE con flujo de puts (vender puts es alcista pero baja el CVD), así
 * que solo se usa como FUERZA/vol (flowWeight), nunca como dirección. Sin
 * flujo clasificable → lateral (sin lectura direccional).
 */
export function flowLean(ctx: AltFlowCtx): Lean {
  const bt = ctx.burstBull + ctx.burstBear;
  if (!(bt > 0)) return "lateral";
  const bullShare = ctx.burstBull / bt;
  return bullShare >= FLOW_BULL ? "alcista" : bullShare <= FLOW_BEAR ? "bajista" : "lateral";
}

const score = (l: Lean) => (l === "alcista" ? 1 : l === "bajista" ? -1 : 0);

// Multiplicador de σ para el objetivo de DESPIN (a dónde tiende el precio si
// rompe el pin en la dirección del flujo).
export const DESPIN_K = 1.0;
// El muro solo sirve de objetivo si está dentro de reachK·σ (alcanzable en lo
// que queda de sesión). Un muro a 6σ no es un objetivo, es ruido → se cae a σ.
export const DESPIN_REACH_K = 2.0;

export interface DespinEstimate {
  dir: "up" | "down";   // dirección del despin (la del flujo agresivo)
  target: number;       // muro de gamma (si alcanzable) o spot ± k·σ (mov. medido)
  pts: number;          // |target − spot|
  wall: number | null;  // muro de gamma en esa dirección, o null
  anchored: boolean;    // true = target ES el muro (estructural); false = fallback σ
  weak: boolean;        // γ+ → pin fuerte, despin poco probable (nota atenuada)
}

/**
 * Objetivo de DESPIN: si el precio ROMPE el pin en la dirección del flujo, a
 * dónde tiende. Dirección = flujo (flowLean, ya bien clasificado). Objetivo:
 * el MURO de gamma de ese lado (callWall arriba / putWall abajo) si está del
 * lado correcto y es ALCANZABLE (≤ reachK·σ) — nivel estructural, primer
 * destino real; si no hay muro alcanzable, el movimiento medido `spot ± k·σ`
 * hace de objetivo. σ = expected move a cierre. PURA. null si no hay σ o el
 * flujo es lateral.
 */
export function despinEstimate(
  spot: number,
  sigma: number | null,
  lean: Lean,
  regime: "positive" | "negative",
  callWall: number | null,
  putWall: number | null,
  k: number = DESPIN_K,
  reachK: number = DESPIN_REACH_K,
): DespinEstimate | null {
  if (!(spot > 0) || !(sigma != null && sigma > 0) || lean === "lateral") return null;
  const up = lean === "alcista";
  const wall = up ? callWall : putWall;
  const wallOk = wall != null && (up ? wall > spot : wall < spot); // del lado del despin
  const anchored = wallOk && Math.abs((wall as number) - spot) <= reachK * sigma;
  const target = anchored ? (wall as number) : up ? spot + k * sigma : spot - k * sigma;
  return {
    dir: up ? "up" : "down",
    target,
    pts: Math.abs(target - spot),
    wall: wallOk ? wall : null,
    anchored,
    weak: regime === "positive",
  };
}

export interface AltOutlook {
  lean: Lean;
  confidence: Conf;
  w: number;
  flowLean: Lean;
  flowNote: string;
}

/** Outlook ALTERNO: mezcla el lean del GEX (original) con el del flujo por peso w. */
export function altOutlook(gexLean: Lean, gexConf: Conf, ctx: AltFlowCtx): AltOutlook {
  const w = flowWeight(ctx);
  const fl = flowLean(ctx);
  const blended = (1 - w) * score(gexLean) + w * score(fl);
  const lean: Lean = blended > 0.33 ? "alcista" : blended < -0.33 ? "bajista" : "lateral";
  let confidence = gexConf;
  if (w >= 0.4 && fl !== "lateral") {
    if (fl === gexLean) confidence = "alta";
    else if (gexLean !== "lateral" && fl !== gexLean) confidence = "baja";
    else if (gexLean === "lateral") confidence = "media";
  }
  const bt = ctx.burstBull + ctx.burstBear;
  const bullPct = bt > 0 ? Math.round((ctx.burstBull / bt) * 100) : 0;
  const domPct = bullPct >= 50 ? bullPct : 100 - bullPct;
  const dirWord = fl === "alcista" ? "alcista" : fl === "bajista" ? "bajista" : "mixto";
  const tilt = lean === "alcista" ? "inclina al alza" : lean === "bajista" ? "inclina a la baja" : "sin sesgo neto";
  const flowNote = w < 0.1
    ? `flujo neutral (peso ${w.toFixed(2)}) → sin cambio`
    : bt <= 0
      ? `flujo sin clasificar (peso ${w.toFixed(2)}) → ${tilt}`
      : fl === "lateral"
        ? `flujo repartido ${bullPct}/${100 - bullPct} (peso ${w.toFixed(2)}) → ${tilt}`
        : `${domPct}% flujo ${dirWord} (peso ${w.toFixed(2)}) → ${tilt}`;
  return { lean, confidence, w, flowLean: fl, flowNote };
}

/** Muros de gamma direccionales: Call Wall (mayor gamma de calls ARRIBA del
 *  spot) y Put Wall (mayor gamma de puts ABAJO del spot). Son el objetivo del
 *  momentum en γ−: hacia donde acelera hasta que la gamma lo frena. */
export function gammaWalls(
  nodes: { strike: number; callGex: number; putGex: number }[],
  spot: number,
): { callWall: number | null; putWall: number | null } {
  let callWall: number | null = null, cMax = 0;
  let putWall: number | null = null, pMax = 0;
  for (const n of nodes) {
    if (n.strike > spot && n.callGex > cMax) { cMax = n.callGex; callWall = n.strike; }
    if (n.strike < spot && n.putGex > pMax) { pMax = n.putGex; putWall = n.strike; }
  }
  return { callWall, putWall };
}

/** Parámetros del momentum de γ− (tunables). */
export interface MomentumParams {
  minRR: number;        // R:B mínimo al muro
  reachSigmaK: number;  // el muro debe estar dentro de reachSigmaK·σ (alcanzable)
  stopSigmaK: number;   // stop = max(minStopPts, stopSigmaK·σ)
  minStopPts: number;
  minStrength: number;  // fuerza mínima del flujo (medio-estricto)
  fallbackSigmaK: number; // si no hay muro del lado correcto, objetivo = spot ± k·σ
}
export const MOMENTUM_DEFAULTS: MomentumParams = {
  minRR: 1.5, reachSigmaK: 2, stopSigmaK: 0.5, minStopPts: 8, minStrength: 0.5, fallbackSigmaK: 1.2,
};

/**
 * MOMENTUM en γ−: si el flujo confirma la dirección y el precio ya rompió el
 * pivote (imán/flip), sugiere seguir el movimiento hacia el próximo muro. Con
 * guardas: R:B ≥ minRR, muro dentro de reachSigmaK·σ, stop con piso. Devuelve
 * null (→ no operar) si no hay ruptura confirmada o las guardas no pasan.
 */
export function momentumEntry(
  ctx: AltFlowCtx,
  callWall: number | null,
  putWall: number | null,
  flip: number | null,
  params: MomentumParams = MOMENTUM_DEFAULTS,
): EntryDecision | null {
  if (ctx.regime !== "negative" || !(ctx.spot > 0)) return null;
  const sigma = ctx.sigma != null && ctx.sigma > 0 ? ctx.sigma : null;
  if (!sigma) return null;

  const w = flowWeight(ctx); // en γ− regimeFactor=1 → w = fuerza del flujo
  const fl = flowLean(ctx);
  if (fl === "lateral" || w < params.minStrength) return null; // sin confirmación → afuera
  const long = fl === "alcista";

  // El movimiento debe estar en marcha: precio del lado del flujo respecto al pivote.
  const pivot = ctx.magnet ?? flip;
  if (pivot != null) {
    if (long && ctx.spot < pivot) return null;
    if (!long && ctx.spot > pivot) return null;
  }

  // Objetivo = MURO DE GAMMA del lado correcto (Call Wall arriba / Put Wall abajo).
  const wall = long ? callWall : putWall;
  const wallOk = wall != null && (long ? wall > ctx.spot : wall < ctx.spot);
  const target = wallOk ? (wall as number) : (long ? ctx.spot + params.fallbackSigmaK * sigma : ctx.spot - params.fallbackSigmaK * sigma);
  const reach = Math.abs(target - ctx.spot);
  if (reach > params.reachSigmaK * sigma) return null; // objetivo inalcanzable en el horizonte

  const stopDist = Math.max(params.minStopPts, params.stopSigmaK * sigma);
  const stop = long ? ctx.spot - stopDist : ctx.spot + stopDist;
  if (reach / stopDist < params.minRR) return null; // R:B insuficiente

  const dir: Direction = long ? "long" : "short";
  const tgt = wallOk ? `el muro ${Math.round(target)}` : `~${Math.round(target)} (mov. medido)`;
  const reason = `γ− (aceleración): precio ${long ? "sobre" : "bajo"} el pivote ${pivot != null ? Math.round(pivot) : "—"} con flujo ${long ? "comprador" : "vendedor"} fuerte → momentum ${long ? "al alza" : "a la baja"}, objetivo ${tgt}, stop ${Math.round(stop)}.`;
  return { direction: dir, entry: ctx.spot, target, stop, reason };
}

// ============================================================================
// GEX Trade ALTERNO unificado: un solo estado que cubre γ+ (fade al imán) y
// γ− (momentum al muro), con NIVELES DE CONVICCIÓN por confirmación de flujo
// y aviso vivo de reversión. PURA.
//  - strong: el flujo (CVD + clasificado) CONFIRMA la dirección del trade.
//  - soft:   (solo γ+) el setup está pero el flujo está callado → drift del pin.
//  - waiting: pegado al imán / sin ruptura, o flujo claramente EN CONTRA.
//  - reversal (overlay): el flujo GIRA en contra con fuerza (aviso antes de invalidar).
// ============================================================================

export type AltTier = "strong" | "soft" | "waiting";
export interface AltTradeRead {
  tier: AltTier;
  trade: EntryDecision | null; // el trade activo (fade γ+ o momentum γ−), o null si waiting
  isMomentum: boolean;
  reversal: boolean;           // aviso inline de posible reversión
}

/** Fuerza CRUDA del flujo (0-1), sin el factor de régimen — para confirmar/negar un trade. */
export function flowStrength(ctx: AltFlowCtx): number {
  const vel = ctx.velocity ?? 1;
  const velC = Math.max(0, Math.min(1, (vel - 1) / 1.5));
  const bt = ctx.burstBull + ctx.burstBear;
  const burstDom = bt > 0 ? Math.abs(ctx.burstBull - ctx.burstBear) / bt : 0;
  const cvdC = ctx.cvdDom != null ? Math.max(0, Math.min(1, ctx.cvdDom / CVD_FULL)) : 0;
  return Math.max(velC, burstDom, cvdC);
}

/**
 * Estado unificado del GEX Trade alterno. `fadeTrade` = evaluateEntry (base
 * γ+); `momentumTrade` = momentumEntry (γ−). El régimen elige cuál. El flujo
 * (dirección por flowLean, fuerza por flowStrength) decide el nivel y el
 * aviso de reversión.
 */
export function altTradeState(
  ctx: AltFlowCtx,
  fadeTrade: EntryDecision | null,
  momentumTrade: EntryDecision | null,
  confirm = 0.5,
  invalidate = 0.65,
): AltTradeRead {
  const isMomentum = ctx.regime === "negative";
  const t = isMomentum ? momentumTrade : fadeTrade;
  const idle: AltTradeRead = { tier: "waiting", trade: null, isMomentum, reversal: false };
  if (!t) return idle;

  const fl = flowLean(ctx);
  const s = flowStrength(ctx);
  const up = t.direction === "long";
  const favors = (up && fl === "alcista") || (!up && fl === "bajista");
  const against = (up && fl === "bajista") || (!up && fl === "alcista");

  if (against && s >= invalidate) return idle;                                    // giro fuerte y sostenido → invalidado
  if (against && s >= confirm) return { tier: isMomentum ? "strong" : "soft", trade: t, isMomentum, reversal: true }; // giro claro → avisa, trade sigue
  if (favors && s >= confirm) return { tier: "strong", trade: t, isMomentum, reversal: false };                       // flujo confirma
  return isMomentum ? idle : { tier: "soft", trade: t, isMomentum, reversal: false };                                 // callado: γ+ drift, γ− sin confirmación
}
