// ============================================================================
// GEX Unpin: la señal post-cierre del "unpin" (el resorte que se suelta cuando
// la 0DTE expira a las 4pm ET y el pin de gamma deja de retener el precio). Solo
// aplica a los FUTUROS /ES y /NQ, que siguen cotizando 4:00–5:00pm mientras el
// cash (SPX/NDX) ya cerró. La dirección va EN CONTRA de cómo se defendió el pin:
// precio flotando SOBRE el imán (dealer vendía para clavarlo) → compra reprimida
// → POP; precio BAJO el imán (dealer compraba) → venta reprimida → DROP. PURA.
//
// Se muestra SIEMPRE (como GEX Pinning): fuera de la ventana 3-5pm entra en
// estado "waiting" con un preview del sesgo; se arma 3-4pm y se juega 4-5pm.
// ============================================================================

export type UnpinState = "armed" | "post" | "waiting" | "idle";
export type UnpinDir = "up" | "down";

export interface UnpinCtx {
  spot: number;
  /** El pin (strike de cierre más probable): closing.strike ?? kingStrike. */
  magnet: number | null;
  /** Premium agresivo BIEN CLASIFICADO hacia el cierre (burstBull = call-buy+put-sell;
   *  burstBear = put-buy+call-sell). Confirma la dirección y desempata cuando el
   *  precio está pegado al pin. NO se usa el signo del CVD (ciego a call/put). */
  burstBull: number | null;
  burstBear: number | null;
  /** Minutos desde medianoche ET (de etNow().min). */
  etMin: number;
  isWeekday: boolean;
  /** Sesión de futuros abierta: fuera de ella la tarjeta no se muestra. */
  sessionOpen: boolean;
  /** El unpin necesita que exista el pin: solo hay señal en gamma positiva. */
  regime: "positive" | "negative";
}

export interface UnpinRead {
  state: UnpinState;
  dir: UnpinDir | null;
  defendedFrom: "above" | "below" | null;
  /** Rango del snapback esperado en puntos (magnitud, siempre positiva). */
  lo: number;
  hi: number;
  /** Solo en "post": cuánto se ha movido el futuro desde el pin (spot − imán). */
  move: number | null;
  /** El flujo agresivo clasificado confirma la dirección del unpin. */
  flowConfirms: boolean;
  /** Minutos al cierre de las 4pm. */
  minToClose: number;
  /** γ+ con imán → hay un pin que se puede soltar. En γ− no hay unpin esperable. */
  hasPin: boolean;
}

// Ventanas en minutos desde medianoche ET: 3:00pm=900, 4:00pm=960, 5:00pm=1020.
const ARMED_FROM = 900, CLOSE_MIN = 960, POST_END = 1020;
// Magnitud del snapback ≈ 0.10%–0.20% del valor del índice. Es un RELEASE
// estructural (fracción del precio), no la σ de tiempo que se encoge a 0 al cierre;
// por eso escala solo entre /ES (~7800→8-16 pts) y /NQ (~30000→30-60 pts).
const MAG_LO = 0.0010, MAG_HI = 0.0020;

const IDLE: UnpinRead = { state: "idle", dir: null, defendedFrom: null, lo: 0, hi: 0, move: null, flowConfirms: false, minToClose: 0, hasPin: false };

/** Umbral de dominancia del premium agresivo para llamar dirección (mismo 58/42). */
const FLOW_DIR_MIN = 0.58;

export function unpinRead(ctx: UnpinCtx): UnpinRead {
  // Sin imán o con la sesión de futuros cerrada no hay nada que mostrar.
  if (ctx.magnet == null || !(ctx.spot > 0) || !ctx.sessionOpen) return IDLE;

  const hasPin = ctx.regime === "positive";
  const inArmed = ctx.isWeekday && ctx.etMin >= ARMED_FROM && ctx.etMin < CLOSE_MIN;
  const inPost = ctx.isWeekday && ctx.etMin >= CLOSE_MIN && ctx.etMin < POST_END;

  // Estado: en γ− siempre "waiting" (no hay pin que soltar). En γ+, armed/post
  // dentro de la ventana, y "waiting" (preview del sesgo) el resto del tiempo.
  let state: UnpinState;
  if (!hasPin) state = "waiting";
  else if (inArmed) state = "armed";
  else if (inPost) state = "post";
  else state = "waiting";

  // Dirección del flujo agresivo BIEN CLASIFICADO (no el signo del CVD).
  const bb = ctx.burstBull ?? 0, br = ctx.burstBear ?? 0, bt = bb + br;
  const flowBull = bt > 0 ? bb / bt : null; // ≥0.58 alcista, ≤0.42 bajista

  const gap = ctx.spot - ctx.magnet;
  const eps = ctx.spot * 0.0003; // "pegado al pin": desempata con el flujo clasificado
  let dir: UnpinDir | null = null;
  if (hasPin) {
    if (Math.abs(gap) < eps) dir = flowBull == null ? null : flowBull >= FLOW_DIR_MIN ? "up" : flowBull <= 1 - FLOW_DIR_MIN ? "down" : null;
    else dir = gap > 0 ? "up" : "down";
  }

  const flowConfirms = flowBull != null && dir != null &&
    ((dir === "up" && flowBull >= FLOW_DIR_MIN) || (dir === "down" && flowBull <= 1 - FLOW_DIR_MIN));

  return {
    state,
    dir,
    defendedFrom: dir === "up" ? "above" : dir === "down" ? "below" : null,
    lo: Math.round(ctx.spot * MAG_LO),
    hi: Math.round(ctx.spot * MAG_HI),
    move: state === "post" ? gap : null,
    flowConfirms,
    minToClose: Math.max(0, CLOSE_MIN - ctx.etMin),
    hasPin,
  };
}
