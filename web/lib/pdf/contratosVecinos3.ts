// "Contratos vecinos 3.0" — a diferencia de "Contratos vecinos 2.0"
// (lib/magnetWall.ts, el imán del GEX decide la dirección y el dinero real
// solo confirma), acá NO hay GEX: el dinero real de MarketSnack decide TODO.
// Pedido explícito (ago 2026), con un ejemplo práctico dado a mano:
//
//   1. Dónde hay más "Premium Traded" (actividad total, ambos lados, sin
//      importar dirección) en el vecindario marca los puntos donde "está el
//      dinero" — soportes/resistencias candidatos, sin importar todavía si
//      son alcistas o bajistas.
//   2. El Net Premium en ESOS puntos confirma la dirección: en calls,
//      positivo = compra agresiva = alcista, negativo = venta = resistencia;
//      en puts, positivo = compra agresiva = bajista/cobertura, negativo =
//      venta = soporte (misma convención que ya usa lib/magnetWall.ts). Es
//      la lectura del ÚLTIMO bucket de 5 min, NUNCA acumulado del día — ver
//      `summarizeActivity`. Pedido explícito (2026-08-24, con un
//      ejemplo real de MarketSnack): "¿ahora mismo se está comprando o
//      vendiendo?", no "¿quién ganó el día completo?".
//   3. Donde la actividad es baja, es candidato a stop-loss/límite — se
//      confirma también con el Net Premium ahí (si es negativo del lado que
//      se está mirando).
//
// Solo mira CALLS arriba del spot y PUTS abajo (nunca puts arriba ni calls
// abajo) — así lo pidió el usuario en el ejemplo: "buscar los contratos en call
// de 7750 hasta 7795... y los puts de 7750 hasta 7715". PURA — no toca red.

export const NEIGHBOR_COUNT = 10; // 10 strikes arriba (calls) y 10 abajo (puts)
export const MAX_TARGETS = 2;

/**
 * Un strike cuenta como "actividad alta" (candidato a target) si su Premium
 * Traded es al menos este % del máximo del propio vecindario — sin esto,
 * cualquier strike con algo de actividad "confirmaría" algo.
 */
export const HIGH_ACTIVITY_RATIO = 0.5;
/** Un strike cuenta como "actividad baja" (candidato a stop-loss) por debajo de este %. */
export const LOW_ACTIVITY_RATIO = 0.15;

/**
 * Cuántos strikes más cercanos al spot se revisan para el stop-loss — MENOS
 * que `NEIGHBOR_COUNT` (10) a propósito. Backtest real (SPX, 2026-08-13,
 * 12:15 ET): sin este tope, el stop-loss cayó en un strike de baja actividad
 * a 49 puntos de la entrada — matemáticamente correcto según la regla, pero
 * inservible como gestión de riesgo real. Mejor no sugerir stop-loss
 * (`null`) que sugerir uno a 10 strikes de distancia.
 */
export const STOP_LOSS_MAX_STRIKES = 4;

export type ActivityTrend = "subiendo" | "bajando" | "estable";

export interface TradeSummaryBucketLike {
  t: string;
  ask_premium: number;
  bid_premium: number;
  mid_premium: number;
}

export interface ActivitySummary {
  totalPremium: number; // "Premium Traded": ask + bid + mid, toda la actividad de hoy
  netPremium: number; // ask − bid: compra vs. venta agresiva
  trend: ActivityTrend;
  /**
   * Totales crudos del día (ask/bid/mid por separado, sin reducir a
   * `netPremium`) — opcionales para no romper los fixtures de test viejos
   * que construyen `ActivitySummary` a mano sin ellos (nadie más los lee;
   * solo los usa `orderBookSentiment`, ver más abajo). `summarizeActivity`
   * SIEMPRE los rellena en uso real.
   */
  askPremium?: number;
  bidPremium?: number;
  midPremium?: number;
}

/**
 * Cuántos buckets de 5 min (10 min con RECENT_WINDOW_BUCKETS=2) cuentan como
 * "ahora mismo" para detectar un salto repentino — ni un solo bucket (mucho
 * ruido, un solo trade grande lo dispara) ni tantos que dejen de ser "recién".
 */
export const RECENT_WINDOW_BUCKETS = 2;
/** Ritmo reciente ≥ este múltiplo del ritmo previo del propio contrato → "subiendo" (salto real, no ruido de un bucket). */
export const SPIKE_UP_RATIO = 2;
/** Ritmo reciente ≤ este múltiplo del ritmo previo → "bajando". Simétrico a SPIKE_UP_RATIO. */
export const SPIKE_DOWN_RATIO = 0.5;

/**
 * Resume los buckets de 5 min de UN contrato en actividad total + neta +
 * tendencia reciente. A diferencia de `summarizeTradeBuckets`
 * (neighborContracts.ts, que descarta el mid a propósito porque solo le
 * interesa la dirección), acá el mid SÍ cuenta en `totalPremium` —
 * "Premium Traded" es toda la plata que se movió en el día, no solo la
 * agresiva, y por eso SÍ es acumulado: dónde está el dinero es una pregunta
 * de todo el día.
 *
 * `netPremium`, en cambio, NO se acumula (pedido explícito,
 * 2026-08-24, con un ejemplo real de MarketSnack a mano): es el ask−bid del
 * ÚLTIMO bucket de 5 min nada más — "¿ahora mismo se está comprando o
 * vendiendo?", no "¿quién ganó la pulseada del día completo?". Un contrato
 * puede llevar toda la mañana vendido en acumulado y en ESTE momento estar
 * comprándose fuerte — con la versión acumulada eso quedaba invisible hasta
 * que el acumulado del día entero cruzaba a positivo, mucho después de que
 * la compra real ya había empezado. Sin buckets, `netPremium` es 0.
 *
 * La tendencia (`trend`) SÍ sigue siendo sobre una ventana — es un concepto
 * distinto (detectar un salto repentino en el RITMO de actividad, no la
 * dirección) y necesita comparar contra una base para saber qué es "repentino".
 * Compara el ritmo por bucket de los últimos `RECENT_WINDOW_BUCKETS` contra
 * el ritmo por bucket de todo lo anterior en el día — sin actividad previa
 * pero SÍ actividad reciente cuenta como salto (dinero apareciendo de la
 * nada es el caso más repentino de todos). Con menos de 4 buckets no hay
 * suficiente historia todavía ("estable").
 */
export function summarizeActivity(buckets: TradeSummaryBucketLike[]): ActivitySummary {
  let askPremium = 0;
  let bidPremium = 0;
  let midPremium = 0;
  for (const b of buckets) {
    askPremium += b.ask_premium;
    bidPremium += b.bid_premium;
    midPremium += b.mid_premium;
  }
  const totalPremium = askPremium + bidPremium + midPremium;

  const sorted = [...buckets].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const latest = sorted[sorted.length - 1] ?? null;
  const netPremium = latest ? latest.ask_premium - latest.bid_premium : 0;

  let trend: ActivityTrend = "estable";
  if (sorted.length >= 4) {
    const sum = (xs: TradeSummaryBucketLike[]) =>
      xs.reduce((s, x) => s + x.ask_premium + x.bid_premium + x.mid_premium, 0);
    const recentCount = Math.min(RECENT_WINDOW_BUCKETS, sorted.length - 2); // deja al menos 2 buckets de base
    const recentBuckets = sorted.slice(sorted.length - recentCount);
    const baseBuckets = sorted.slice(0, sorted.length - recentCount);
    const recentRate = sum(recentBuckets) / recentBuckets.length;
    const baseRate = sum(baseBuckets) / baseBuckets.length;

    if (baseRate > 0) {
      if (recentRate >= baseRate * SPIKE_UP_RATIO) trend = "subiendo";
      else if (recentRate <= baseRate * SPIKE_DOWN_RATIO) trend = "bajando";
    } else if (recentRate > 0) {
      trend = "subiendo"; // no había nada antes y ahora sí: el salto más repentino posible
    }
  }

  return { totalPremium, netPremium, trend, askPremium, bidPremium, midPremium };
}

export interface ActivityLevel {
  strike: number;
  /** El tipo PRIMARIO de este strike para el motor — call arriba del spot, put abajo (ver cabecera del archivo). */
  type: "call" | "put";
  /** Actividad del tipo primario — lo único que usan `walkSide`/`contratosVecinos3Signal`. */
  activity: ActivitySummary;
  /**
   * Actividad del tipo CONTRARIO en el mismo strike (put arriba del spot,
   * call abajo) — pedido explícito para mostrar en la tabla junto
   * al net premium del tipo primario. Puramente informativo: el motor
   * (`walkSide`/`contratosVecinos3Signal`) nunca la lee, solo la pestaña.
   * `null`/`undefined` si ese strike no tiene contrato del tipo contrario.
   */
  otherActivity?: ActivitySummary | null;
}

export interface ContratosVecinos3Target {
  strike: number;
  totalPremium: number;
  netPremium: number;
  /**
   * `true` si el Premium Traded de este strike venía en tendencia "subiendo"
   * (ver `summarizeActivity`) al momento de la lectura — actividad real
   * entrando AHORA, no solo un número grande acumulado en el día. Pedido
   * explícito: distinguir "aquí siempre hubo mucho dinero" de "aquí
   * está entrando mucho dinero de golpe" (actividad inusual/repentina).
   */
  unusual: boolean;
}

/**
 * Confirmación de "punto máximo de llegada" con Net Premium (distinta de
 * `capStrike`, que solo mira si el Premium Traded TOTAL cae). Pedido
 * explícito, dos chequeos independientes sobre el ÚLTIMO target
 * confirmado del lado ganador:
 *
 *   1. `contraSideAggressive` — en el MISMO strike, el tipo CONTRARIO
 *      también se está comprando agresivamente (ask): si vas en CALL y ahí
 *      mismo los PUTS también entran al ask, hay tensión real en ese punto —
 *      los dos lados apostando fuerte al mismo tiempo, posible agotamiento.
 *   2. `nextStrikeSelling` — el siguiente contrato (mismo tipo, un strike
 *      más allá) ya tiene net premium NEGATIVO — venta real confirmándose
 *      justo después, reforzando que el camino no sigue mucho más.
 *
 * Cualquiera de los dos ya es señal (no hace falta que se den los dos a la
 * vez) — se exponen por separado para que se vea cuál disparó.
 */
export interface CapReversalSignal {
  strike: number;
  contraSideAggressive: boolean;
  nextStrikeSelling: boolean;
}

export interface StopLossLevel {
  strike: number;
  netPremium: number;
  type: "call" | "put";
}

interface SideWalk {
  type: "call" | "put";
  targets: ContratosVecinos3Target[];
  /** Strike donde la pared de venta (actividad alta + net premium en contra) frenó el camino, si pasó. */
  wallStrike: number | null;
  /**
   * Compra real (actividad alta + net premium positivo) encontrada DETRÁS de
   * la primera pared — no se promueve a target porque el precio necesita
   * romper la pared antes de llegar ahí, pero es evidencia real que vale la
   * pena vigilar. Caso real: SPX 2026-08-14, 10:05 ET, spot $7807 — el put
   * $7805 (más cercano) era pared vendida y frenaba el camino, pero el put
   * $7800, un strike más atrás, tenía compra agresiva real y CRECIENTE
   * (net premium +$36,778 y subiendo cada 5 min) que antes quedaba invisible.
   */
  beyondWall: ContratosVecinos3Target | null;
  /** Strike donde el Premium Traded empezó a caer justo después del último target — probable máximo. */
  capStrike: number | null;
  /** Confirmación con Net Premium (tensión en el mismo strike y/o venta en el siguiente) de que el último target es el punto máximo — ver `CapReversalSignal`. */
  capReversal: CapReversalSignal | null;
  /** Primer strike de actividad baja (posible stop-loss), confirmado con net premium negativo ahí. */
  lowActivity: StopLossLevel | null;
  /**
   * Premium Traded del primer strike de actividad alta encontrado (target O
   * pared) — usado para decidir qué lado "gana" en `contratosVecinos3Signal`.
   * Una pared real (mucha actividad, vendida) también es evidencia de "acá
   * está el dinero", no solo los targets confirmados.
   */
  leadPremium: number;
}

/**
 * Camina un solo lado (calls arriba o puts abajo), ya ordenado del strike más
 * cercano al spot hacia afuera. Junta hasta `MAX_TARGETS` strikes de
 * actividad alta cuyo net premium confirma compra agresiva (positivo,
 * misma convención en call y put — ver cabecera del archivo). Si encuentra
 * actividad alta pero con net premium en contra (venta real), es una pared
 * real: frena ahí mismo, no sigue buscando más targets detrás de una
 * resistencia/soporte confirmado.
 *
 * `globalMaxPremium` (el máximo de TODO el vecindario, ambos lados) es la
 * vara para "baja actividad" — comparar contra el máximo del propio lado
 * fallaba en el caso real: el lado perdedor puede no tener ningún
 * strike gigante, pero igual estar lleno de actividad relativa a SÍ mismo sin
 * serlo respecto a dónde está el dinero de verdad.
 */
function walkSide(levels: ActivityLevel[], type: "call" | "put", globalMaxPremium: number): SideWalk {
  const empty: SideWalk = {
    type, targets: [], wallStrike: null, beyondWall: null, capStrike: null, capReversal: null, lowActivity: null, leadPremium: 0,
  };
  if (levels.length === 0) return empty;

  const maxPremium = Math.max(...levels.map((l) => l.activity.totalPremium));
  if (!(maxPremium > 0)) return empty;

  const targets: ContratosVecinos3Target[] = [];
  let wallStrike: number | null = null;
  let beyondWall: ContratosVecinos3Target | null = null;
  let leadPremium = 0;
  let stopIndex = -1;

  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    const isHighActivity = lvl.activity.totalPremium >= maxPremium * HIGH_ACTIVITY_RATIO;
    if (!isHighActivity) continue;
    if (leadPremium === 0) leadPremium = lvl.activity.totalPremium;

    if (lvl.activity.netPremium > 0) {
      const unusual = lvl.activity.trend === "subiendo";
      if (wallStrike == null) {
        targets.push({ strike: lvl.strike, totalPremium: lvl.activity.totalPremium, netPremium: lvl.activity.netPremium, unusual });
        stopIndex = i;
        if (targets.length >= MAX_TARGETS) break;
      } else {
        // Ya pasamos una pared real — esto NO es un target (el precio
        // primero tiene que romper la pared), pero es compra real que antes
        // quedaba invisible porque el camino frenaba en la primera pared.
        beyondWall = { strike: lvl.strike, totalPremium: lvl.activity.totalPremium, netPremium: lvl.activity.netPremium, unusual };
        break;
      }
    } else if (wallStrike == null) {
      // Actividad alta pero vendida agresivamente = pared real (resistencia si
      // es call, soporte si es put). Antes esto frenaba el camino del todo;
      // ahora solo deja de contar targets nuevos — se sigue mirando un poco
      // más allá por si hay compra real detrás (`beyondWall`).
      wallStrike = lvl.strike;
      stopIndex = i;
    }
  }

  // "También puedes verificar 7775, y si el Premium traded es menor que el
  // 7770, puede que 7770 sea su punto máximo" — mirar el siguiente strike CON
  // actividad después del último target confirmado; si decae, ese último
  // target es el probable techo del movimiento.
  let capStrike: number | null = null;
  let capReversal: CapReversalSignal | null = null;
  if (targets.length > 0 && wallStrike == null) {
    const next = levels[stopIndex + 1];
    const last = targets[targets.length - 1];
    const lastLevel = levels[stopIndex];
    if (next && next.activity.totalPremium < last.totalPremium) capStrike = last.strike;

    // Confirmación con Net Premium (independiente de `capStrike`, que solo
    // mira volumen total): ¿el tipo contrario en el MISMO strike también
    // entra al ask (tensión real)? ¿el siguiente strike ya vende (net
    // premium negativo)? Cualquiera de los dos ya cuenta.
    const contraSideAggressive = lastLevel?.otherActivity != null && lastLevel.otherActivity.netPremium > 0;
    const nextStrikeSelling = next != null && next.activity.netPremium < 0;
    if (contraSideAggressive || nextStrikeSelling) {
      capReversal = { strike: last.strike, contraSideAggressive, nextStrikeSelling };
    }
  }

  // Zona de baja actividad = candidato a stop-loss, confirmado por net
  // premium negativo del mismo tipo que se está caminando (venta real, no
  // solo silencio). Se busca en TODO el lado, no solo después de los
  // targets — puede ser el primer strike ya de entrada. Limitado a los
  // `STOP_LOSS_MAX_STRIKES` strikes más cercanos al spot — más allá de eso,
  // un stop-loss deja de ser útil aunque sea "correcto" (ver constante).
  let lowActivity: StopLossLevel | null = null;
  for (const lvl of levels.slice(0, STOP_LOSS_MAX_STRIKES)) {
    if (lvl.activity.totalPremium <= globalMaxPremium * LOW_ACTIVITY_RATIO && lvl.activity.netPremium < 0) {
      lowActivity = { strike: lvl.strike, netPremium: lvl.activity.netPremium, type };
      break;
    }
  }

  return { type, targets, wallStrike, beyondWall, capStrike, capReversal, lowActivity, leadPremium };
}

export interface SupportingWall {
  strike: number;
  type: "call" | "put";
  label: "resistencia" | "soporte";
  netPremium: number;
}

/** Compra real detrás de la pared del lado PERDEDOR (ver `ContratosVecinos3Signal.reversalWatch`). */
export interface ReversalWatch extends ContratosVecinos3Target {
  type: "call" | "put";
}

export interface ContratosVecinos3Signal {
  type: "call" | "put" | null;
  target1: ContratosVecinos3Target | null;
  target2: ContratosVecinos3Target | null;
  /** Strike donde la actividad ya empezó a decaer — probable techo del movimiento. `null` si no se detectó. */
  capStrike: number | null;
  /** Confirmación del punto máximo con Net Premium (tensión en el mismo strike y/o venta en el siguiente) — ver `CapReversalSignal`. `null` si ninguna de las dos se dio. */
  capReversal: CapReversalSignal | null;
  /** Pared de venta real (lado ganador) que frenó el camino antes de completar los targets, si pasó. */
  wallStrike: number | null;
  /** Nivel de baja actividad del lado CONTRARIO a la dirección — referencia de stop-loss. */
  stopLoss: StopLossLevel | null;
  /**
   * Pared real (actividad alta + venta agresiva) del lado CONTRARIO a la
   * dirección — evidencia que REFUERZA la tesis (venta de puts abajo cuando
   * la señal es CALL = soporte real; venta de calls arriba cuando es PUT =
   * resistencia real). Pedido explícito, confirmado con datos
   * reales: SPX 2026-08-13 09:36 ET, señal CALL en $7785, con venta real de
   * puts en $7780 — soporte que reforzaba la tesis alcista. `null` sin pared
   * real del lado contrario todavía.
   */
  supportingWall: SupportingWall | null;
  /**
   * Compra real detrás de la primera pared del lado GANADOR (ver
   * `SideWalk.beyondWall`) — informativo, no un target: el precio necesita
   * romper la pared antes de que este nivel sea alcanzable.
   */
  breakoutWatch: ContratosVecinos3Target | null;
  /**
   * Compra real detrás de la pared del lado PERDEDOR — caso real: SPX
   * 2026-08-14, 10:05 ET, spot $7807.01. El lado CALL ganó (pared en $7810
   * con más dólares acumulados que la pared PUT en $7805), pero detrás de esa
   * pared PUT ya había compra real y CRECIENTE en $7800 (net premium
   * +$36,778, subiendo cada 5 min) — invisible antes porque solo se miraba
   * el lado ganador. Distinto de `supportingWall` (que es una pared VENDIDA
   * del lado perdedor, reforzando la tesis actual): esto es compra real del
   * lado perdedor, una posible reversión gestándose.
   */
  reversalWatch: ReversalWatch | null;
  /** Validación de camino limpio hacia el strike de actividad EXPLOTANDO del lado ganador — ver `evaluateCapCandidate`. `null` sin candidato (nada con tendencia "subiendo" todavía). */
  capCandidate: CapCandidateConfirmation | null;
  reason: string;
}

export interface ContratosVecinos3Input {
  spot: number;
  /** Strikes > spot, actividad de CALLS, ordenados del más cercano al spot hacia afuera. */
  above: ActivityLevel[];
  /** Strikes < spot, actividad de PUTS, ordenados del más cercano al spot hacia afuera. */
  below: ActivityLevel[];
}

/** Un strike del camino spot→candidato, con lo mínimo para mostrar por qué pasó o falló. */
export interface CapCandidatePathStep {
  strike: number;
  totalPremium: number;
  netPremium: number;
  /** Net premium del tipo CONTRARIO en el mismo strike — `null` si ese strike no tiene contrato contrario con datos. */
  otherNetPremium: number | null;
}

/**
 * Validación de "camino limpio" hacia un strike con actividad EXPLOTANDO
 * (pedido explícito, con dos ejemplos prácticos a mano — SPX en
 * 7700 con actividad disparándose en 7725 arriba / 7680 abajo). Solo se
 * calcula cuando el strike de más Premium Traded del lado viene en tendencia
 * "subiendo" (`summarizeActivity` — un salto real, no un número grande de
 * siempre — "le están dando duro" literalmente significa esto). Cuatro
 * chequeos, cada uno puede fallar solo:
 *
 *   1. `pathAllPositive` — TODOS los strikes entre el spot y el candidato
 *      (7705, 7710, 7715, 7720 en el ejemplo) tienen net premium POSITIVO del
 *      tipo primario, sin importar si son de actividad alta o baja — a
 *      diferencia de `walkSide`, que ignora los strikes de baja actividad sin
 *      mirar su signo.
 *   2. `pathBuildingUp` — el Premium Traded va aumentando strike a strike a
 *      medida que se acerca al candidato (no un pico aislado en medio de un
 *      camino plano).
 *   3. `pathOppositeClean` — en esos MISMOS strikes del camino, el tipo
 *      CONTRARIO (puts arriba del spot, calls abajo) tiene net premium
 *      negativo o nulo — no hay compra agresiva contraria compitiendo en el
 *      camino.
 *   4. `opposingSideClean` — el lado OPUESTO del tablero entero (puts abajo
 *      del spot si el candidato es un call arriba) no muestra agresión propia
 *      (net premium positivo) — "que no haya tanta agresividad debajo".
 *
 * Más allá del candidato, reusa la misma idea de `capReversal`/`capStrike`:
 * el siguiente strike (7730 en el ejemplo) no debería haber crecido tanto en
 * Premium Traded y su net premium debería ser negativo — `nextStrikeConfirms`.
 */
export interface CapCandidateConfirmation {
  strike: number;
  path: CapCandidatePathStep[];
  pathAllPositive: boolean;
  pathBuildingUp: boolean;
  pathOppositeClean: boolean;
  nextStrikeConfirms: boolean;
  opposingSideClean: boolean;
  /** `true` solo si los cinco chequeos pasaron — candidato fuerte a punto máximo real. */
  confirmed: boolean;
}

export function evaluateCapCandidate(levels: ActivityLevel[], opposingLevels: ActivityLevel[]): CapCandidateConfirmation | null {
  if (levels.length === 0) return null;
  const candidate = levels.reduce((a, b) => (b.activity.totalPremium > a.activity.totalPremium ? b : a));
  if (candidate.activity.trend !== "subiendo") return null; // sin salto real, no es "le están dando duro"

  const idx = levels.indexOf(candidate);
  const pathLevels = levels.slice(0, idx);
  const path: CapCandidatePathStep[] = pathLevels.map((l) => ({
    strike: l.strike,
    totalPremium: l.activity.totalPremium,
    netPremium: l.activity.netPremium,
    otherNetPremium: l.otherActivity?.netPremium ?? null,
  }));

  const pathAllPositive = path.every((p) => p.netPremium > 0);
  const pathBuildingUp = path.every((p, i) => (i === 0 || p.totalPremium >= path[i - 1].totalPremium));
  const pathOppositeClean = path.every((p) => p.otherNetPremium == null || p.otherNetPremium <= 0);

  const next = levels[idx + 1] ?? null;
  const nextStrikeConfirms = next == null || (next.activity.totalPremium < candidate.activity.totalPremium && next.activity.netPremium <= 0);

  const opposingSideClean = opposingLevels.every((l) => l.activity.netPremium <= 0);

  return {
    strike: candidate.strike, path, pathAllPositive, pathBuildingUp, pathOppositeClean, nextStrikeConfirms, opposingSideClean,
    confirmed: pathAllPositive && pathBuildingUp && pathOppositeClean && nextStrikeConfirms && opposingSideClean,
  };
}

/**
 * Compara ambos lados y decide cuál gana. Un target CONFIRMADO (compra
 * agresiva real) pesa más que una simple pared, sin importar cuántos dólares
 * acumuló esa pared — una pared es resistencia/freno, no una señal de
 * entrada. Bug real encontrado con datos en vivo (SPX, 2026-08-13, 10:35 ET,
 * pico del día en $7816): antes de esto, el lado CALL "ganaba" solo porque su
 * pared en $7820 llevaba acumulados más dólares en el día, mientras el lado
 * PUT ya tenía DOS targets confirmados (compra agresiva real) en $7810 y
 * $7805 — la herramienta seguía diciendo CALL justo en el techo real, cuando
 * el dinero real ya estaba confirmando la baja. Con targets confirmados de
 * los dos lados, gana el de mayor Premium Traded en su primer target; sin
 * ningún target confirmado en ningún lado (solo paredes o nada), se cae al
 * criterio de magnitud de siempre.
 */
function pickWinner(above: SideWalk, below: SideWalk): { winner: SideWalk; loser: SideWalk } {
  const aboveConfirmed = above.targets.length > 0;
  const belowConfirmed = below.targets.length > 0;
  if (aboveConfirmed && !belowConfirmed) return { winner: above, loser: below };
  if (belowConfirmed && !aboveConfirmed) return { winner: below, loser: above };
  if (aboveConfirmed && belowConfirmed) {
    return above.targets[0].totalPremium >= below.targets[0].totalPremium
      ? { winner: above, loser: below }
      : { winner: below, loser: above };
  }
  return above.leadPremium >= below.leadPremium ? { winner: above, loser: below } : { winner: below, loser: above };
}

export function contratosVecinos3Signal(input: ContratosVecinos3Input): ContratosVecinos3Signal {
  const globalMaxPremium = Math.max(
    0,
    ...input.above.map((l) => l.activity.totalPremium),
    ...input.below.map((l) => l.activity.totalPremium),
  );
  const above = walkSide(input.above, "call", globalMaxPremium);
  const below = walkSide(input.below, "put", globalMaxPremium);

  if (above.leadPremium <= 0 && below.leadPremium <= 0) {
    return {
      type: null, target1: null, target2: null, capStrike: null, capReversal: null, wallStrike: null, stopLoss: null,
      supportingWall: null, breakoutWatch: null, reversalWatch: null, capCandidate: null,
      reason: "Sin actividad real (Premium Traded) suficiente en el vecindario todavía — no operar.",
    };
  }

  const { winner, loser } = pickWinner(above, below);
  const stopLoss = loser.lowActivity;
  const supportingWall: SupportingWall | null =
    loser.wallStrike != null
      ? {
          strike: loser.wallStrike,
          type: loser.type,
          label: loser.type === "call" ? "resistencia" : "soporte",
          netPremium: (loser.type === "call" ? input.above : input.below).find((l) => l.strike === loser.wallStrike)
            ?.activity.netPremium ?? 0,
        }
      : null;

  const sideWord = winner.type === "call" ? "calls" : "puts";
  const dirWord = winner.type === "call" ? "CALL" : "PUT";
  const t1 = winner.targets[0] ?? null;
  const t2 = winner.targets[1] ?? null;

  let reason =
    `Mayor actividad real (Premium Traded) del lado de ${sideWord}` +
    (t1 ? `, confirmada con net premium positivo en $${t1.strike}` : "") +
    (t2 ? ` y $${t2.strike}` : "") +
    ` — sesgo ${dirWord}.`;
  const unusualStrikes = [t1, t2].filter((t): t is ContratosVecinos3Target => t != null && t.unusual).map((t) => `$${t.strike}`);
  if (unusualStrikes.length > 0) {
    reason += ` Actividad inusual (Premium Traded subiendo AHORA, no solo acumulado) en ${unusualStrikes.join(" y ")}.`;
  }
  if (winner.wallStrike != null) {
    reason += ` El camino se frenó en $${winner.wallStrike}: ahí hay actividad alta pero VENDIDA (pared real), no compra.`;
  } else if (winner.capStrike != null) {
    reason += ` La actividad cae justo después de $${winner.capStrike} — probable techo del movimiento.`;
  }
  if (winner.capReversal) {
    const contraWord = winner.type === "call" ? "puts" : "calls";
    const bits: string[] = [];
    if (winner.capReversal.contraSideAggressive) bits.push(`los ${contraWord} también se están comprando agresivamente en $${winner.capReversal.strike} (mismo strike)`);
    if (winner.capReversal.nextStrikeSelling) bits.push(`ya hay venta real en el strike siguiente`);
    reason += ` Posible agotamiento en $${winner.capReversal.strike}: ${bits.join(" y ")}.`;
  }
  if (supportingWall) {
    reason += ` Refuerza la tesis: venta real de ${supportingWall.type === "call" ? "calls" : "puts"} en $${supportingWall.strike} — ${supportingWall.label} real del lado contrario.`;
  }
  if (stopLoss) {
    reason += ` Zona de baja actividad en $${stopLoss.strike} (${stopLoss.type === "call" ? "calls" : "puts"}) con net premium negativo — referencia de stop-loss.`;
  }
  if (winner.beyondWall) {
    reason += ` Detrás de la pared, ya hay compra real acumulándose en $${winner.beyondWall.strike} — vigilar si la pared en $${winner.wallStrike} cede.`;
  }
  const reversalWatch: ReversalWatch | null = loser.beyondWall ? { ...loser.beyondWall, type: loser.type } : null;
  if (reversalWatch) {
    const loserSideWord = loser.type === "call" ? "calls" : "puts";
    reason += ` Ojo: del otro lado, detrás de su propia pared, ya hay compra real de ${loserSideWord} en $${reversalWatch.strike} — posible reversión gestándose.`;
  }

  const winnerLevels = winner.type === "call" ? input.above : input.below;
  const opposingLevels = winner.type === "call" ? input.below : input.above;
  const capCandidate = evaluateCapCandidate(winnerLevels, opposingLevels);
  if (capCandidate) {
    if (capCandidate.confirmed) {
      reason += ` Actividad explotando en $${capCandidate.strike} con el camino desde el spot limpio (todo comprado, en aumento, contrario vendiendo) — candidato fuerte a punto máximo real.`;
    } else {
      const fails: string[] = [];
      if (!capCandidate.pathAllPositive) fails.push("algún strike del camino no está comprado");
      if (!capCandidate.pathBuildingUp) fails.push("el Premium Traded no viene en aumento parejo");
      if (!capCandidate.pathOppositeClean) fails.push("el tipo contrario compite en algún strike del camino");
      if (!capCandidate.nextStrikeConfirms) fails.push("el strike siguiente todavía no confirma");
      if (!capCandidate.opposingSideClean) fails.push("el lado opuesto del tablero tiene agresión propia");
      reason += ` Actividad explotando en $${capCandidate.strike}, pero el camino no confirma del todo (${fails.join("; ")}) — no tratarlo todavía como punto máximo confiable.`;
    }
  }

  return {
    type: winner.type, target1: t1, target2: t2,
    capStrike: winner.capStrike, capReversal: winner.capReversal, wallStrike: winner.wallStrike, stopLoss, supportingWall,
    breakoutWatch: winner.beyondWall, reversalWatch, capCandidate, reason,
  };
}

// ── Orden book balanceado + sesgo call/put (rebote vs. "desangrando") ──────
//
// Pedido explícito (2026-08-25), inspirado en dos paneles reales de
// MarketSnack ("Asset Order Book Side" y "Asset Premium Sentiment"):
//
//   1. Cuando el ORDER BOOK está BALANCEADO (el dinero ejecutado al bid y al
//      ask del vecindario son casi iguales) → señal de posible REBOTE — el
//      mercado no tiene un lado claro empujando, así que el precio tiende a
//      rebotar en vez de seguir de largo.
//   2. El PREMIUM SENTIMENT (cuánto dinero hay en calls vs. puts) dice DÓNDE
//      está la atención; si ADEMÁS ese lado dominante se está comprando
//      agresivamente al ask (no vendiendo), confirma la DIRECCIÓN — call al
//      ask = alcista, put al ask = bajista (misma convención de siempre).
//   3. Ejemplo dado por el usuario a mano: tras un rebote, si el put empieza a
//      dominar Y el order book se desbalancea hacia el ask (compra agresiva
//      de esos puts) → "se va a desangrar" — sesgo bajista real, no solo un
//      rebote fallido.
//
// Solo INFORMATIVO por ahora (pedido explícito): no toca `walkSide` ni
// `contratosVecinos3Signal` — es un panel aparte que el usuario lee y decide.
//
// Alcance de los datos: pedido explícito "cuando estás en vivo operando es
// 0DTE... va a ser de ese día" — se calcula con el MISMO vecindario
// (`ContratosVecinos3Input.above`/`below`, ya sea la cadena 0DTE de SPX/SPY/QQQ
// o los vencimientos "de esta semana" de Grandes Empresas) y los MISMOS
// totales de HOY que ya trae `summarizeActivity` — cero llamadas nuevas a
// MarketSnack. El endpoint propio de MarketSnack (`/api/assets/{t}/sentiment`)
// se investigó pero agrega TODO el historial/todos los vencimientos, no solo
// hoy — no calzaba con lo que el usuario mira en vivo.

/**
 * Qué tan cerca tienen que estar el % ejecutado al bid y al ask (del total
 * bid+mid+ask) para contar como "balanceado" — primer número, a ajustar tras
 * ver esto en vivo unos días (mismo espíritu que el resto de umbrales del
 * archivo, todos documentados y fáciles de tocar en un solo lugar).
 */
export const ORDER_BOOK_BALANCE_THRESHOLD_PCT = 8;

export interface OrderBookSentiment {
  askPremium: number;
  bidPremium: number;
  midPremium: number;
  askPct: number;
  bidPct: number;
  midPct: number;
  /** `true` si |askPct − bidPct| ≤ ORDER_BOOK_BALANCE_THRESHOLD_PCT. */
  balanced: boolean;
  callPremium: number;
  putPremium: number;
  /** El lado con más Premium Traded (calls vs puts) del vecindario — `null` si no hay actividad todavía. */
  dominantSide: "call" | "put" | null;
  /** Net premium AGREGADO (suma de todos los niveles) del lado dominante — positivo = se está comprando agresivamente al ask ahí. */
  dominantNetPremium: number;
  message: string;
}

function sumSide(levels: ActivityLevel[], pick: (l: ActivityLevel) => ActivitySummary | null | undefined) {
  let ask = 0, bid = 0, mid = 0, total = 0, net = 0;
  for (const l of levels) {
    const a = pick(l);
    if (!a) continue;
    ask += a.askPremium ?? 0;
    bid += a.bidPremium ?? 0;
    mid += a.midPremium ?? 0;
    total += a.totalPremium;
    net += a.netPremium;
  }
  return { ask, bid, mid, total, net };
}

export function orderBookSentiment(input: ContratosVecinos3Input): OrderBookSentiment {
  // Orden book: TODA la actividad del vecindario, sin importar tipo — calls
  // arriba + puts abajo (los primarios) + el tipo contrario en cada strike.
  const primary = sumSide([...input.above, ...input.below], (l) => l.activity);
  const other = sumSide([...input.above, ...input.below], (l) => l.otherActivity);
  const askPremium = primary.ask + other.ask;
  const bidPremium = primary.bid + other.bid;
  const midPremium = primary.mid + other.mid;
  const bookTotal = askPremium + bidPremium + midPremium;
  const askPct = bookTotal > 0 ? (askPremium / bookTotal) * 100 : 0;
  const bidPct = bookTotal > 0 ? (bidPremium / bookTotal) * 100 : 0;
  const midPct = bookTotal > 0 ? (midPremium / bookTotal) * 100 : 0;
  const balanced = bookTotal > 0 && Math.abs(askPct - bidPct) <= ORDER_BOOK_BALANCE_THRESHOLD_PCT;

  // Premium sentiment: calls = primario de `above` + contrario de `below`; puts = primario de `below` + contrario de `above`.
  const calls = sumSide(input.above, (l) => l.activity);
  const callsOther = sumSide(input.below, (l) => l.otherActivity);
  const puts = sumSide(input.below, (l) => l.activity);
  const putsOther = sumSide(input.above, (l) => l.otherActivity);
  const callPremium = calls.total + callsOther.total;
  const putPremium = puts.total + putsOther.total;
  const callNet = calls.net + callsOther.net;
  const putNet = puts.net + putsOther.net;

  let dominantSide: "call" | "put" | null = null;
  let dominantNetPremium = 0;
  if (callPremium > 0 || putPremium > 0) {
    dominantSide = callPremium >= putPremium ? "call" : "put";
    dominantNetPremium = dominantSide === "call" ? callNet : putNet;
  }

  let message: string;
  if (bookTotal === 0) {
    message = "Sin actividad real todavía — sin lectura de order book.";
  } else if (balanced) {
    message = `⚖️ Order book balanceado (bid ${bidPct.toFixed(0)}% · ask ${askPct.toFixed(0)}%) — posible rebote.`;
  } else if (dominantSide && dominantNetPremium > 0) {
    // "Desangrando" solo tiene sentido bajista (pedido explícito:
    // "si va a subir dime como to the moon ahahaha") — el lado alcista usa su
    // propia frase, no la versión invertida de la bajista.
    message =
      dominantSide === "call"
        ? `🚀 To the moon — más dinero en calls y comprándose agresivamente al ask (bid ${bidPct.toFixed(0)}% · ask ${askPct.toFixed(0)}%).`
        : `🩸 Desangrando BAJISTA — más dinero en puts y comprándose agresivamente al ask (bid ${bidPct.toFixed(0)}% · ask ${askPct.toFixed(0)}%).`;
  } else if (dominantSide) {
    const sideWord = dominantSide === "call" ? "calls" : "puts";
    message = `Order book desbalanceado (bid ${bidPct.toFixed(0)}% · ask ${askPct.toFixed(0)}%), más dinero en ${sideWord}, pero sin compra agresiva confirmando todavía.`;
  } else {
    message = "Sin lectura clara todavía.";
  }

  return {
    askPremium, bidPremium, midPremium, askPct, bidPct, midPct, balanced,
    callPremium, putPremium, dominantSide, dominantNetPremium, message,
  };
}

// ── Filtro de persistencia (evita operar parpadeos de 1-2 lecturas) ────────
//
// Backtest real (SPX, 2026-08-13): con precio actualizándose cada minuto, la
// señal CALL de las 09:36-10:35 ET se sostuvo ~1 hora — real. Pero la señal
// PUT de las 12:15 ET desapareció al minuto siguiente (12:16), y la de las
// 14:50 ET duró un solo minuto — ninguna de las dos era operable de verdad.
// Pedido explícito: exigir que la dirección se sostenga varias
// lecturas seguidas antes de confiar en ella. PURA — el caller (la pestaña)
// es quien acumula el historial de lecturas crudas; esta función solo decide
// si ese historial alcanza para confiar.

/** Lecturas seguidas que tiene que sostenerse la misma dirección para contar como confirmada. */
export const PERSISTENCE_REQUIRED = 3;

export interface PersistentSignal extends ContratosVecinos3Signal {
  /**
   * `true` si `type` y la presencia de `target1` se sostuvieron en las
   * últimas `PERSISTENCE_REQUIRED` lecturas seguidas (el STRIKE de target1
   * puede haber subido/bajado mientras tanto — "dejar correr" una posición
   * real no debe resetear la confirmación, solo un cambio de dirección o una
   * pérdida de confirmación sí).
   */
  confirmed: boolean;
}

const EMPTY_SIGNAL: ContratosVecinos3Signal = {
  type: null, target1: null, target2: null, capStrike: null, capReversal: null, wallStrike: null, stopLoss: null,
  supportingWall: null, breakoutWatch: null, reversalWatch: null, capCandidate: null, reason: "Sin lecturas todavía.",
};

/**
 * Toma el historial de lecturas crudas más recientes (la última al final) y
 * devuelve la última con `confirmed` marcado según si se sostuvo. Con menos
 * de `PERSISTENCE_REQUIRED` lecturas en el historial, o si la última lectura
 * no tiene dirección/target1, nunca puede estar confirmada todavía.
 */
export function applyPersistence(history: ContratosVecinos3Signal[], persistenceRequired: number = PERSISTENCE_REQUIRED): PersistentSignal {
  const latest = history.at(-1) ?? EMPTY_SIGNAL;
  if (latest.type == null || latest.target1 == null) {
    return { ...latest, confirmed: false };
  }
  const window = history.slice(-persistenceRequired);
  const confirmed =
    window.length >= persistenceRequired &&
    window.every((s) => s.type === latest.type && s.target1 != null);
  return { ...latest, confirmed };
}
