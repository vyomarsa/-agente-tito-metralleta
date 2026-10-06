// Lógica PURA del paper trading condicional (Fase 1 "Mis Trades"). Sin red, sin fs:
// todo lo que decide vive aquí y se testea sin montar el server.
//
// Modelo (calcado del plan del grupo, verificado contra su captura):
//  - Los NIVELES del plan (gatillo/objetivo/stop) son del SUBYACENTE (el precio de la
//    acción): "entra al cruzar 82 · objetivo 87 · stop 83".
//  - entrada/salida/actual/pico son la PRIMA de la OPCIÓN (por acción; ×100×contratos
//    = dólares). "Entró a $0.91 · ahora $1.45".
//  - P&L = (salida − entrada) × 100 × contratos. NADA de esto mueve dinero real.
//  - Trailing de GANANCIA: se guarda el pico de la prima y se asegura una fracción del
//    avance. Un stop fijo no protege la prima; este sí. Cerrar por trailing SIEMPRE deja
//    una ganancia (el nivel asegurado nunca baja de la entrada).
//
// SIMULACIÓN: "probabilidad" = fuerza del setup, NUNCA una garantía.

import { commissionOf } from "./commissions";

export type PaperStatus = "pendiente" | "activa" | "ganada" | "perdida" | "expirada";
export type OptionType = "call" | "put";
/** Hacia dónde debe moverse el subyacente para cruzar el gatillo y buscar el objetivo. */
export type Direction = "up" | "down";
export type CloseReason =
  | "objetivo"
  | "stop"
  | "trailing"
  | "expirada"
  | "caducada"
  | "invalidada"
  | "sin_tamano"
  | "manual"
  | null;
export type Source = "manual" | "auto";

export interface PaperTrade {
  id: string;
  createdAt: string; // ISO
  source: Source;

  // --- Contrato ---
  ticker: string;
  optionType: OptionType;
  strike: number;
  expiration: string; // YYYY-MM-DD

  // --- Plan (niveles del SUBYACENTE) ---
  direction: Direction;
  trigger: number; // entra al cruzar
  target: number; // objetivo
  stop: number; // stop de pérdida
  trailing: boolean; // usar stop dinámico de ganancia sobre la prima
  probability: number | null; // 0..100, heurística (fuerza del setup)
  note: string | null; // "Swing", "Day Trading", etc.
  /**
   * Contratos. Editable a mano, pero en los AUTO lo fija `sizeForSwing` AL ENTRAR
   * (ver `evaluate`): antes nacía en 1 y se quedaba en 1 para siempre.
   */
  contracts: number;
  /**
   * Fracción del capital arriesgada al entrar (0.02 = 2%). Se apunta por el mismo
   * motivo que en venta de prima: desde que existe la banda 2–3%, una posición
   * puede nacer al borde bajo o estirada al alto, y sin este dato el win rate
   * mezclaría dos tamaños de apuesta distintos. Ausente en las anteriores al
   * 2026-08-28, que se abrieron todas con 1 contrato sin dimensionar.
   */
  riskPctUsed?: number;

  // --- Ejecución (PRIMA de la opción) ---
  status: PaperStatus;
  entryPrice: number | null; // prima al activarse
  entryAt: string | null;
  exitPrice: number | null; // prima al cerrar
  exitAt: string | null;
  peakPrice: number | null; // pico de la prima (para el trailing)
  currentUnderlying: number | null; // último precio del subyacente visto
  currentPrice: number | null; // última prima vista
  updatedAt: string | null;
  closeReason: CloseReason;
  verdict: string | null; // veredicto en palabras al cerrar
  /**
   * Comisiones cobradas en $ (1 pata: al entrar y, salvo que venza, al salir). Se
   * guarda al cerrar desde el 2026-09-17; en las anteriores se DERIVA con `feesOf`.
   */
  fees?: number;
}

/** Fracción del avance de la prima que asegura el trailing (0.5 = la mitad). */
export const TRAIL_LOCK_FRACTION = 0.5;

const TERMINAL: ReadonlySet<PaperStatus> = new Set(["ganada", "perdida", "expirada"]);
export function isClosed(t: PaperTrade): boolean {
  return TERMINAL.has(t.status);
}
export function isOpen(t: PaperTrade): boolean {
  return t.status === "pendiente" || t.status === "activa";
}

// --- Cruces del subyacente (dependen de la dirección) ---
export function crossedTrigger(t: PaperTrade, u: number): boolean {
  return t.direction === "up" ? u >= t.trigger : u <= t.trigger;
}
export function hitTarget(t: PaperTrade, u: number): boolean {
  return t.direction === "up" ? u >= t.target : u <= t.target;
}
export function hitStop(t: PaperTrade, u: number): boolean {
  return t.direction === "up" ? u <= t.stop : u >= t.stop;
}

// --- P&L y trailing ---
/** Nivel de prima que asegura el trailing. Nunca por debajo de la entrada (no arriesga). */
export function trailStopPrice(entry: number, peak: number, frac = TRAIL_LOCK_FRACTION): number {
  if (peak <= entry) return entry;
  return entry + frac * (peak - entry);
}
/** Ganancia asegurada por el trailing en dólares (0 si aún no hay avance o no aplica). */
export function securedGain(t: PaperTrade, frac = TRAIL_LOCK_FRACTION): number {
  if (!t.trailing || t.entryPrice == null || t.peakPrice == null) return 0;
  const s = trailStopPrice(t.entryPrice, t.peakPrice, frac);
  return Math.max(0, (s - t.entryPrice) * 100 * t.contracts);
}
/** P&L realizado BRUTO (solo si cerró con entrada y salida). */
export function realizedPnl(t: PaperTrade): number {
  if (t.entryPrice == null || t.exitPrice == null) return 0;
  return (t.exitPrice - t.entryPrice) * 100 * t.contracts;
}
/** P&L NO realizado BRUTO de un trade activo (entrada vs. prima actual). */
export function unrealizedPnl(t: PaperTrade): number {
  if (t.status !== "activa" || t.entryPrice == null || t.currentPrice == null) return 0;
  return (t.currentPrice - t.entryPrice) * 100 * t.contracts;
}

/**
 * Comisiones del trade. Lo que nunca entró no pagó nada; uno activo, solo la
 * entrada; uno cerrado, entrada y salida — salvo que venciera, que se liquida sin
 * orden. Si el trade trae `fees` guardado, manda ese.
 */
export function feesOf(t: PaperTrade): number {
  if (t.fees != null) return t.fees;
  if (t.entryPrice == null) return 0;
  if (t.status === "activa") return commissionOf(t.contracts, 1, false);
  return commissionOf(t.contracts, 1, t.closeReason !== "expirada");
}
/** P&L realizado NETO de comisiones. 0 si el cierre no tiene precio (no se inventa). */
export function netRealizedPnl(t: PaperTrade): number {
  if (!isPriced(t)) return 0;
  return realizedPnl(t) - feesOf(t);
}
/** P&L latente NETO: descuenta la comisión de entrada, ya pagada. */
export function netUnrealizedPnl(t: PaperTrade): number {
  if (t.status !== "activa" || t.entryPrice == null || t.currentPrice == null) return 0;
  return unrealizedPnl(t) - feesOf(t);
}

// ---------------------------------------------------------------------------
// DIMENSIONAMIENTO
// ---------------------------------------------------------------------------

/** Capital de partida de la cuenta simulada, igual que venta de prima y 0DTE. */
export const START_EQUITY = 10_000;
/** Banda del mandato §8: se dimensiona al 2% y solo se estira al 3% para UNO. */
export const RISK_PER_TRADE_PCT = 0.02;
export const RISK_PER_TRADE_MAX_PCT = 0.03;

/** ¿Esta posición se abrió con un tamaño calculado, o con el 1 fijo de antes? */
export function wasSized(t: PaperTrade): boolean {
  return t.riskPctUsed != null;
}

/**
 * Capital simulado con el que se DIMENSIONA: parte del capital inicial y suma el P&L
 * de los cierres que se abrieron **dimensionados**.
 *
 * POR QUÉ NO SUMA TODO EL LIBRO, que es lo que uno esperaría. Hasta el 2026-08-28 el
 * piloto abría 1 contrato fuera cual fuera la prima, así que sus dólares no describen
 * una cuenta: describen el bug. Ese libro acumula −$12.630 sobre un capital de
 * $10.000 — más de lo que la cuenta tenía, porque llegó a "comprar" un put de $29.620.
 * Arrastrarlo aquí dejaría el capital NEGATIVO y `sizeForSwing` devolvería 0 contratos
 * para siempre: un bug de medición apagaría el agente de forma permanente y silenciosa.
 *
 * No se borra ni se reescribe nada: `closedPnl` sigue sumando TODOS los cierres con
 * precio y la pantalla enseña los dos números. Lo único que se acota es qué historia
 * puede decidir el tamaño de la próxima entrada, y la respuesta correcta es "solo la
 * que se midió con esta vara".
 */
export function equityOf(trades: PaperTrade[], startEquity = START_EQUITY): number {
  let eq = startEquity;
  for (const t of trades) if (isClosed(t) && isPriced(t) && wasSized(t)) eq += netRealizedPnl(t);
  return Math.round(eq * 100) / 100;
}

/**
 * Contratos de un swing, por la BANDA 2–3% del capital.
 *
 * POR QUÉ EXISTE. Hasta el 2026-08-28 el piloto abría `DEFAULT_CONTRACTS = 1` y ahí
 * se quedaba: la bitácora tenía una prima de $2,40 (IBIT, $240 comprometidos) al
 * lado de una de $296,20 (SNDK, **$29.620** en una cuenta de $10.000). El resultado
 * no medía la señal, medía el precio del contrato que la institución hubiera
 * operado — que el agente ni elige, lo copia del flujo. Las tres peores pérdidas del
 * libro (CAT −$4.488, MSTR −$2.462, BE −$2.310) son de los contratos caros, y la
 * perdedora media (−$1.522) salía 2,33× la ganadora media (+$654): con esa asimetría
 * hacía falta un 70% de acierto para no perder, contra el 38% real.
 *
 * EL RIESGO ES LA PRIMA COMPLETA, no la pérdida estimada en el stop. Es lo mismo que
 * hace `zerodtePaper.maxRiskOf`, y por la misma razón: el stop del plan vive en el
 * SUBYACENTE y **no acota** lo que puede perder la opción — un hueco de apertura o un
 * desplome de IV se la lleva entera, y de hecho el stop de SOXX se comió el 73% de la
 * prima. Medir el riesgo por el delta daría un número más halagüeño y menos cierto.
 *
 * CONSECUENCIA, y es la correcta: con $10.000 solo caben contratos de prima baja.
 * Aplicado al libro histórico, 17 de 21 posiciones no habrían entrado — porque una
 * cuenta de $10.000 no puede comprar un put de $29.620. Que el agente las abriera
 * era ficción, no oportunidad.
 */
export function sizeForSwing(
  entryPrice: number,
  equity: number,
  lo: number = RISK_PER_TRADE_PCT,
  hi: number = RISK_PER_TRADE_MAX_PCT,
): { contracts: number; riskPct: number } {
  const porContrato = entryPrice * 100;
  if (!(porContrato > 0) || !(equity > 0)) return { contracts: 0, riskPct: 0 };

  const conBase = Math.floor((equity * lo) / porContrato);
  if (conBase >= 1) return { contracts: conBase, riskPct: pctOf(porContrato * conBase, equity) };

  // No cabe ni uno al borde bajo: ¿cabe UNO dentro del tope del mandato? Nunca se
  // estira para poner MÁS de uno — estirar la banda para tomar una posición que no
  // cabía es una cosa, y usar el tope como tamaño normal es otra.
  if (porContrato <= equity * hi) return { contracts: 1, riskPct: pctOf(porContrato, equity) };

  return { contracts: 0, riskPct: 0 };
}

/** Fracción del capital que arriesga una posición, redondeada a 4 decimales. */
function pctOf(riesgo: number, equity: number): number {
  if (!(equity > 0)) return 0;
  return Math.round((riesgo / equity) * 10000) / 10000;
}

/**
 * Valor de la opción AL VENCIMIENTO: solo intrínseco, el temporal ya no existe.
 *
 * Es la ÚNICA excepción a "sin cotización no se pone precio", y es legítima porque
 * aquí el precio no se estima: se deduce. Una call vale lo que cuesta ejercerla y
 * ni un centavo más, y si está fuera del dinero vale exactamente 0 — que es un
 * resultado real (pierdes toda la prima), no un dato ausente.
 *
 * OJO — solo vale EL DÍA DEL VENCIMIENTO. Aplicarlo a un cierre a media vida
 * ignoraría el valor temporal y subestimaría la prima, que es inventar en la
 * dirección contraria. Por eso `evaluate` solo lo usa en la rama de expiración.
 *
 * `settleUnderlying` debe ser el cierre del DÍA en que venció, no el precio de
 * hoy: un contrato que murió fuera del dinero el viernes no revive porque el
 * lunes el subyacente suba.
 */
export function intrinsicValue(
  optionType: OptionType,
  strike: number,
  settleUnderlying: number,
): number {
  const bruto = optionType === "call" ? settleUnderlying - strike : strike - settleUnderlying;
  return Math.max(0, Math.round(bruto * 10000) / 10000);
}

/** Fecha de mercado (ET) YYYY-MM-DD para comparar con el vencimiento. */
function marketDateStr(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function isExpired(t: PaperTrade, now: Date): boolean {
  return marketDateStr(now) > t.expiration;
}

/**
 * Días que un plan PENDIENTE espera su gatillo antes de darse por caducado.
 *
 * Un plan condicional no envejece bien: nace de un flujo concreto y de unos niveles
 * de ese momento. Si en una semana el precio no cruzó el gatillo, esa señal ya pasó.
 * Además hay un coste operativo directo: el piloto respeta "una entrada por ticker",
 * así que cada pendiente zombi mantiene su ticker VETADO para señales nuevas. El
 * 2026-08-17 había 58 tickers bloqueados —21 de ellos por planes de 13 días que nunca
 * dispararon— y un escaneo con 25 candidatos válidos abrió CERO por esa razón.
 */
export const PENDING_MAX_DAYS = 7;

/** ¿Lleva demasiado tiempo esperando el gatillo? Se mide desde que se creó. */
export function pendingTooOld(t: PaperTrade, now: Date): boolean {
  const creado = Date.parse(t.createdAt);
  if (!Number.isFinite(creado)) return false; // sin fecha fiable no se caduca nada
  return Math.floor((now.getTime() - creado) / 86_400_000) >= PENDING_MAX_DAYS;
}

function verdictFor(reason: Exclude<CloseReason, null>, prob: number | null): string {
  const tail = prob != null ? ` El modelo daba ${Math.round(prob)}%.` : "";
  switch (reason) {
    case "objetivo":
      return `Certero: el gatillo cruzó y llegó al objetivo.${tail}`;
    case "stop":
      return `Tocó el stop antes del objetivo.${tail}`;
    case "trailing":
      return `El trailing aseguró la ganancia antes de tocar el objetivo.${tail}`;
    case "expirada":
      return `Expiró sin resolverse.${tail}`;
    case "caducada":
      return `Caducada: pasaron ${PENDING_MAX_DAYS} días sin cruzar el gatillo, la señal ya no es la misma.${tail}`;
    case "invalidada":
      return `Invalidada: el subyacente cruzó el stop del plan ANTES de disparar el gatillo, así que la idea ya estaba muerta. Nunca entró.${tail}`;
    case "sin_tamano":
      return `No entró: ni UN contrato cabe en el ${Math.round(RISK_PER_TRADE_MAX_PCT * 100)}% del capital. La señal pudo ser buena; la posición no cabía.${tail}`;
    case "manual":
      return `Cerrada a mano.${tail}`;
  }
}

/**
 * Avanza UN trade con el precio del subyacente (`u`) y la prima de la opción (`mark`)
 * observados ahora. PURA: devuelve una copia nueva, no muta la entrada. Si falta alguno
 * de los precios, actualiza lo que puede y no fuerza transiciones sobre el dato ausente.
 */
export function evaluate(
  trade: PaperTrade,
  u: number | null,
  mark: number | null,
  now: Date,
  /**
   * Cierre del subyacente el DÍA DEL VENCIMIENTO, para liquidar a intrínseco lo que
   * ya venció. `null` si no se pudo averiguar: entonces se cierra sin precio, como
   * antes. Lo trae la ruta (`/api/trades/refresh`) porque exige red; el motor sigue
   * siendo puro.
   */
  settleUnderlying: number | null = null,
  /**
   * Capital simulado, para dimensionar la entrada (`sizeForSwing`). Lo calcula la
   * ruta con `equityOf` sobre la bitácora entera; por defecto el capital de partida,
   * que es lo correcto para un libro vacío y para los tests que no lo pasan.
   */
  equity: number = START_EQUITY,
): PaperTrade {
  if (isClosed(trade)) return trade;
  const nowIso = now.toISOString();
  const t: PaperTrade = {
    ...trade,
    currentUnderlying: u ?? trade.currentUnderlying,
    currentPrice: mark ?? trade.currentPrice,
    updatedAt: nowIso,
  };

  const close = (status: PaperStatus, reason: Exclude<CloseReason, null>, exit: number | null): PaperTrade => ({
    ...t,
    status,
    exitPrice: exit,
    exitAt: nowIso,
    closeReason: reason,
    verdict: verdictFor(reason, t.probability),
    // Solo paga quien entró y salió con precio; vencer no tiene orden de cierre.
    ...(t.entryPrice != null && exit != null
      ? { fees: commissionOf(t.contracts, 1, reason !== "expirada") }
      : {}),
  });

  if (t.status === "pendiente") {
    // Sin activar y ya venció → nunca disparó.
    if (isExpired(t, now)) return close("expirada", "expirada", null);
    // Cruza el gatillo → se activa a la prima actual (necesitamos la prima para la entrada).
    // Va ANTES de la caducidad a propósito: un plan que cruza justo el día 7 SÍ disparó,
    // sería absurdo matarlo por viejo en el mismo instante en que funciona.
    if (u != null && mark != null && crossedTrigger(t, u)) {
      /**
       * El tamaño se fija AQUÍ y no al crear el plan, porque hasta este instante no
       * se conoce la prima: un pendiente no tiene precio de entrada. Es también el
       * único momento en que el dato es el bueno — dimensionar con la prima de hace
       * siete días sería dimensionar otra posición.
       *
       * Sin sitio para un solo contrato el plan NO entra y se CIERRA, en vez de
       * quedarse pendiente: un pendiente sigue reservando su ticker por la regla de
       * "una entrada por ticker" del piloto, y ese veto fantasma es justo lo que el
       * 2026-08-17 dejó 58 tickers bloqueados y un escaneo con 25 candidatos
       * abriendo cero. Se cierra sin precios, así que no cuenta ni como acierto ni
       * como fallo (`outcomeOf`): no fue una idea fallida, fue una que no cupo.
       */
      // SOLO se dimensionan los AUTO. En un trade manual los contratos los tecleó
      // el dueño a sabiendas, y pisar una decisión explícita suya sería peor que el
      // bug que esto arregla; para cambiarlos ya tiene el editor de la bitácora.
      if (t.source !== "auto") {
        return { ...t, status: "activa", entryPrice: mark, entryAt: nowIso, peakPrice: mark };
      }
      const { contracts, riskPct } = sizeForSwing(mark, equity);
      if (contracts < 1) return close("expirada", "sin_tamano", null);
      return {
        ...t,
        status: "activa",
        entryPrice: mark,
        entryAt: nowIso,
        peakPrice: mark,
        contracts,
        riskPctUsed: riskPct,
      };
    }
    /**
     * INVALIDADA: el subyacente cruzó el STOP del plan sin haber cruzado el gatillo.
     *
     * El plan dice "entra en X, objetivo Y, invalida en Z". Si el precio llega a Z
     * primero, la premisa se acabó: el flujo institucional que originó la idea ocurrió
     * a un precio que ya no existe, y para volver al gatillo haría falta el recorrido
     * entero de vuelta. Esperar los 7 días de la caducidad no aporta nada y **cuesta**:
     * un pendiente sigue reservando su ticker por la regla de "una entrada por ticker"
     * del piloto, así que cada zombi es un candidato bueno que no se pudo abrir.
     *
     * Medido en el libro el 2026-08-28: de 33 caducadas, **20 ya habían cruzado su
     * propio stop** — SNDK necesitaba un +32% de vuelta, HL un +15,8%, GOOGL un +11,8%.
     * Ninguna iba a disparar, y entre todas bloquearon 20 tickers durante días.
     *
     * VA DESPUÉS del gatillo, y el orden importa por lo mismo que la caducidad: si en la
     * misma pasada el precio hubiera cruzado el gatillo, ese plan SÍ disparó. (Con los
     * niveles a lados opuestos del precio no pueden cumplirse los dos a la vez, pero el
     * orden deja la intención escrita para el día que los niveles cambien.)
     *
     * Cierra SIN precios, así que `outcomeOf` la deja en `sin_decidir`: no fue una idea
     * fallida, fue una que no llegó a probarse. Contarla como fallo castigaría al modelo
     * por un trade que nunca tomó.
     */
    if (u != null && hitStop(t, u)) return close("expirada", "invalidada", null);
    // No cruzó y la señal ya envejeció → se cierra y LIBERA el ticker.
    if (pendingTooOld(t, now)) return close("expirada", "caducada", null);
    return t; // sigue pendiente
  }

  // status === "activa"
  const peak = mark != null ? Math.max(t.peakPrice ?? t.entryPrice ?? mark, mark) : t.peakPrice;
  const active: PaperTrade = { ...t, peakPrice: peak };
  /**
   * Precio de salida: la prima RECIÉN cotizada, o `null` si no la hay.
   *
   * Antes caía a `currentPrice`, que sin re-cotización es la prima de entrada — y
   * salir al mismo precio al que entraste da P&L exactamente $0. Como el win rate
   * se contaba por el signo del P&L, un acierto real quedaba en "ni ganada ni
   * perdida": el 2026-08-24 había 12 operaciones decididas y el resumen marcaba
   * 0W · 0L. Peor aún, "salió a $17.75" era un dato INVENTADO en el libro.
   *
   * Ahora un cierre sin prima se anota SIN precio: el desenlace de la idea lo
   * decide el subyacente (que es donde vive el plan) y ese sí se conoce; lo que no
   * se sabe es cuánto dinero se hizo, y eso se dice en vez de rellenarlo con cero.
   * Misma norma que el motor de venta de prima: sin precio no se inventa un precio.
   */
  const exitMark = mark;

  /**
   * El VENCIMIENTO se comprueba ANTES que objetivo y stop, y el orden importa.
   *
   * `isExpired` compara la fecha de MERCADO, así que solo es cierto a partir del
   * día SIGUIENTE: durante toda la sesión del vencimiento el objetivo y el stop
   * siguen mandando, como debe ser. Pero una vez muerto el contrato, cerrarlo por
   * "objetivo" con el precio de la sesión siguiente sería apuntarse una ganancia
   * de un contrato que ya no existía cuando el subyacente llegó ahí. Después del
   * vencimiento solo queda liquidar.
   *
   * El intrínseco MANDA sobre `mark`: para un contrato ya vencido, cualquier
   * cotización que llegue es de otro contrato o está rancia. Sin precio de
   * liquidación se cierra SIN precio, en vez de adivinar con otro día.
   */
  if (isExpired(active, now)) {
    const liquidacion =
      settleUnderlying != null
        ? intrinsicValue(active.optionType, active.strike, settleUnderlying)
        : exitMark;
    return { ...close("expirada", "expirada", liquidacion), peakPrice: peak };
  }

  if (u != null && hitTarget(active, u)) return close("ganada", "objetivo", exitMark);
  if (u != null && hitStop(active, u)) return close("perdida", "stop", exitMark);
  if (
    active.trailing &&
    active.entryPrice != null &&
    peak != null &&
    peak > active.entryPrice &&
    mark != null &&
    mark <= trailStopPrice(active.entryPrice, peak)
  ) {
    // Cierra al nivel asegurado (bloquea la fracción del avance), no a la prima actual.
    return { ...close("ganada", "trailing", trailStopPrice(active.entryPrice, peak)) , peakPrice: peak };
  }
  return active;
}

/** ¿El cierre tiene los dos precios y por tanto un P&L real? */
export function isPriced(t: PaperTrade): boolean {
  return t.entryPrice != null && t.exitPrice != null;
}

export type Outcome = "acierto" | "fallo" | "sin_decidir";

/**
 * Desenlace de un trade para el win rate. Se decide por el MOTIVO del cierre, no
 * por el signo del P&L.
 *
 * El cambio importa: el plan (gatillo, objetivo, stop) vive en el SUBYACENTE, y es
 * ahí donde se sabe si la idea acertó. La prima solo dice cuánto dinero hizo. Con
 * el criterio viejo —acierto = P&L > 0— cualquier cierre sin prima fresca daba
 * P&L 0 y desaparecía del marcador: el 2026-08-24 había 10 objetivos y 2 stops
 * alcanzados, y la pantalla decía "0W · 0L · win rate —".
 *
 * Lo que NUNCA cuenta es lo que no llegó a entrar (caducadas y vencidas sin cruzar
 * el gatillo): no fueron ideas fallidas, fueron ideas que no se probaron.
 */
export function outcomeOf(t: PaperTrade): Outcome {
  if (!isClosed(t)) return "sin_decidir";
  if (t.entryPrice == null) return "sin_decidir"; // nunca cruzó el gatillo
  if (t.closeReason === "objetivo" || t.closeReason === "trailing") return "acierto";
  if (t.closeReason === "stop") return "fallo";
  // "expirada" estando activa y "manual" no las decide el plan: las decide el dinero,
  // y solo si hay dinero que mirar.
  if (!isPriced(t)) return "sin_decidir";
  const pnl = netRealizedPnl(t);
  return pnl > 0 ? "acierto" : pnl < 0 ? "fallo" : "sin_decidir";
}

export interface PaperSummary {
  closedPnl: number; // P&L de lo cerrado CON precio, NETO de comisiones (desde 2026-09-17)
  /** El mismo P&L sin comisiones. */
  grossPnl: number;
  /** Comisiones de los cierres con precio + la entrada de los activos. */
  feesPaid: number;
  /** Aciertos POR PLAN, sobre TODO lo decidido (tenga precio de salida o no). */
  wins: number;
  losses: number;
  winRatePct: number | null;
  /**
   * Lo mismo, pero SOLO sobre los cierres con precio — los únicos que suman al
   * P&L.
   *
   * POR QUÉ HAY DOS. `winRatePct` y `closedPnl` se calculaban sobre poblaciones
   * DISTINTAS y se enseñaban juntos, así que no se podían leer en la misma
   * frase: el 2026-08-26 la bitácora marcaba **64% de aciertos junto a
   * −$12.023**, y de los 33 cierres que puntuaban solo 21 tenían dinero medido.
   * Los otros 12 (11 de ellos apuntados como ACIERTO) entraban en el porcentaje
   * y no en el dinero. El dueño lo leyó como "los aciertos no vamos bien" sin
   * poder ver dónde estaba la contradicción.
   *
   * El criterio de acierto NO cambia — lo sigue decidiendo el plan (`outcomeOf`),
   * no el signo del P&L. Lo único que cambia es la población, para que el
   * porcentaje y el dinero hablen por fin de las mismas operaciones.
   */
  winsPriced: number;
  lossesPriced: number;
  winRatePricedPct: number | null;
  pending: number;
  active: number;
  openUnrealized: number; // suma del P&L no realizado de los activos
  /** Cierres que entraron pero se quedaron sin prima de salida: su P&L no se conoce. */
  unpriced: number;
  /** Cierres que sí tienen los dos precios (los únicos que suman al P&L). */
  priced: number;
  /** Capital de partida de la cuenta simulada. */
  startEquity: number;
  /**
   * Capital con el que `sizeForSwing` dimensiona. Solo suma los cierres que nacieron
   * dimensionados — ver `equityOf` para el porqué. Puede diferir de
   * `startEquity + closedPnl`, y esa diferencia es exactamente el P&L del libro viejo.
   */
  equity: number;
  /** Planes que cruzaron el gatillo pero no cabían ni con un contrato. */
  sinTamano: number;
  /** Pendientes que cruzaron su propio stop antes del gatillo: la idea murió sin probarse. */
  invalidadas: number;
  /** Cierres con precio abiertos ANTES del dimensionamiento (1 contrato fijo). */
  unsizedClosed: number;
}

/** Estadísticas de la bitácora. El acierto lo decide `outcomeOf`, no el signo del P&L. */
export function summarize(trades: PaperTrade[]): PaperSummary {
  let closedPnl = 0;
  let grossPnl = 0;
  let feesPaid = 0;
  let wins = 0;
  let losses = 0;
  let pending = 0;
  let active = 0;
  let openUnrealized = 0;
  let unpriced = 0;
  let priced = 0;
  let sinTamano = 0;
  let invalidadas = 0;
  let unsizedClosed = 0;
  let winsPriced = 0;
  let lossesPriced = 0;
  for (const t of trades) {
    if (isClosed(t)) {
      if (isPriced(t)) {
        closedPnl += netRealizedPnl(t);
        grossPnl += realizedPnl(t);
        feesPaid += feesOf(t);
        priced++;
      } else if (t.entryPrice != null) {
        // Entró pero no hay prima de salida: cuenta como acierto/fallo si el plan lo
        // decidió, pero su P&L no se suma — sumarlo como 0 sería inventar.
        unpriced++;
      }
      if (t.closeReason === "sin_tamano") sinTamano++;
      if (t.closeReason === "invalidada") invalidadas++;
      if (isPriced(t) && !wasSized(t)) unsizedClosed++;
      const o = outcomeOf(t);
      if (o === "acierto") wins++;
      else if (o === "fallo") losses++;
      if (isPriced(t)) {
        if (o === "acierto") winsPriced++;
        else if (o === "fallo") lossesPriced++;
      }
    } else if (t.status === "pendiente") {
      pending++;
    } else if (t.status === "activa") {
      active++;
      openUnrealized += netUnrealizedPnl(t);
      if (t.entryPrice != null) feesPaid += feesOf(t);
    }
  }
  const decided = wins + losses;
  const decidedPriced = winsPriced + lossesPriced;
  return {
    closedPnl,
    grossPnl,
    feesPaid,
    wins,
    losses,
    winRatePct: decided > 0 ? (wins / decided) * 100 : null,
    winsPriced,
    lossesPriced,
    winRatePricedPct: decidedPriced > 0 ? (winsPriced / decidedPriced) * 100 : null,
    pending,
    active,
    openUnrealized,
    unpriced,
    priced,
    startEquity: START_EQUITY,
    equity: equityOf(trades),
    sinTamano,
    invalidadas,
    unsizedClosed,
  };
}
