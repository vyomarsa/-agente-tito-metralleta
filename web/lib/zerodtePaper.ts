// ============================================================================
// PAPER TRADING DEL 0DTE — la cuenta simulada del agente de cero días.
//
// Gemelo de `lib/primaPaper.ts`, para que las dos pestañas de Mis Trades se lean
// igual: capital, abiertas, cerradas, win rate. Pero la mecánica es la contraria:
//
//   · Venta de prima VENDE spreads y gana con el paso del tiempo (theta a favor).
//   · El 0DTE COMPRA una opción suelta y necesita movimiento YA (theta en contra).
//
// De ahí las tres diferencias que importan:
//   1. El riesgo máximo de una opción comprada es la prima pagada, ni un dólar
//      más. Eso hace el dimensionamiento trivial y el stop, opcional.
//   2. Las reglas se evalúan sobre el SUBYACENTE (el modelo habla de spot,
//      objetivo y stop), pero el P&L se calcula sobre el CONTRATO re-cotizado.
//      Mezclar los dos planos es el error clásico y aquí están separados.
//   3. Todo vence hoy: al cerrar la sesión no queda nada abierto. Lo que siga
//      vivo a las 16:00 ET se liquida a su último mid.
//
// Nada de esto mueve dinero real. Todo aquí es PURO: la I/O vive en
// `zerodtePaperStore.ts` y en `app/api/0dte-paper/*`. Tests en `zerodtePaper.test.ts`.
// ============================================================================

import type { ZeroDteTicket, ZeroDteTrade } from "./zerodteSignals";
import { commissionOf } from "./commissions";
import { marketDateStr } from "./occ";

// ---------------------------------------------------------------------------
// Constantes del plan
// ---------------------------------------------------------------------------

/** Capital hipotético de partida. NO se resetea: el equity se deriva del libro. */
export const START_EQUITY = 10_000;
/** Riesgo por operación. En una opción comprada, el riesgo ES la prima pagada. */
export const RISK_PER_TRADE_PCT = 0.02;
/** Tope de posiciones abiertas a la vez. */
export const MAX_OPEN = 3;
/** Un modelo sostiene UNA idea a la vez (igual que el marcador en vivo). */
export const MAX_OPEN_PER_MODEL = 1;
/**
 * No se abre nada en los últimos minutos de sesión. Un 0DTE comprado a las 15:55
 * no es una idea, es una apuesta a la campana: no queda tiempo para que el
 * movimiento ocurra y el theta a esa hora es vertical.
 */
export const NO_OPEN_LAST_MIN = 30;

/**
 * CIERRE POR RELOJ: se liquida todo lo abierto a las **15:30 ET**, media hora
 * antes de la campana. Expresado en minutos que restan de sesión.
 *
 * Un 0DTE que llega a las 16:00 sin estar ITM vale CERO, así que aguantar hasta
 * el final convertía en pérdida del 100% toda posición que no tocara su objetivo,
 * pasara lo que pasara antes. Medido sobre las 45 primeras cerradas (2026-09-07):
 * las 8 que llegaron al cierre de sesión cargaban **−$784 de los −$1.109 del libro
 * entero — el 71% de la pérdida**, y CINCO de ellas habían llegado a ir de +45% a
 * +155% antes de morir en 0,015. La peor abrió en 0,64, tocó 1,63 y cerró en
 * −$187,50.
 *
 * A las 15:30 el contrato todavía se cotiza, así que el cierre es una salida REAL
 * al mid en vez de una liquidación a cero. **Coincide a propósito con
 * `NO_OPEN_LAST_MIN`**: nada se abre después de la hora a la que todo se cierra,
 * así que no puede nacer una posición condenada a vivir un minuto.
 */
export const CIERRE_RELOJ_MIN = 30;

/**
 * STOP POR DEVOLUCIÓN DE PICO (trailing de ganancia).
 *
 * Se arma cuando la posición ha ganado `TRAIL_ARMA_PCT`, y cierra si devuelve
 * `TRAIL_DEVOLUCION_PCT` de esa GANANCIA — no del precio. La distinción importa:
 * medir sobre el precio dispara con el ruido de cerca de la entrada, mientras que
 * medir sobre la ganancia responde a la pregunta que interesa ("¿cuánto de lo que
 * llegué a ganar estoy dispuesto a devolver?").
 *
 * El problema medido: sobre las 45 primeras cerradas (2026-09-07), **6 llegaron a
 * ir +25% o más y acabaron en pérdida, −$655**. El cierre por reloj rescata algunas
 * de esas, pero solo las que sobreviven hasta las 15:30.
 *
 * HISTORIA. La v3 (2026-09-07) los puso POR CRITERIO en +30% / 50%, porque el libro
 * guarda entrada, pico y precio final pero NO el camino, y una simulación sin camino
 * es ciega justo al coste del trail (supone que el precio subió al pico y bajó, así
 * que nunca recorta una ganadora y "mejora" cuanto más se aprieta).
 *
 * RECALIBRADO EL 2026-09-17 (v4) CON EL CAMINO REAL. Con velas de 1 minuto de SPY
 * se reconstruyó el precio de la opción minuto a minuto (IV implícita en la entrada,
 * Black-Scholes sobre el recorrido real del subyacente, mismo muestreo de 1 minuto
 * que el cron) y se repitieron las 27 operaciones de v3. **Validación:** el replay
 * con +30%/50% reproduce el motivo de salida de 25 de 27 y un neto de −$550 contra
 * −$473 reales. Resultado de la rejilla (neto con comisiones):
 *
 *   sin trailing            −$904   ← quitarlo es lo peor
 *   +30% / 50% (v3)         −$550
 *   +40..+150%, cualquiera  −$650 .. −$1.080   ← armar más tarde EMPEORA
 *   +20% / 25%  (v4)        −$349   (mitades −$48 / −$301 contra −$88 / −$462)
 *   +20% / 20%              −$331   (el mejor, pero en el borde de la meseta)
 *
 * O sea, lo contrario de "dar aire al trail": en estos 0DTE, lo que se devuelve
 * cuesta más que los objetivos que el trail corta. Se eligió 20/25 y no el mejor
 * absoluto porque está en el centro de una meseta (+15% y +25% también mejoran a
 * v3, y 20–25% de devolución da resultados casi iguales), y un punto así sobrevive
 * mejor a una muestra de 27 operaciones que un máximo aislado.
 *
 * **NO ARREGLA LA CUENTA:** sigue en negativo. Mejora ~$200 sobre 27 operaciones,
 * dentro de muestra, casi todas `momentum` corto en 7 sesiones, y con IV constante
 * en el modelo. Recalibrar con la misma herramienta cuando v4 acumule sesiones.
 */
export const TRAIL_ARMA_PCT = 0.20;
export const TRAIL_DEVOLUCION_PCT = 0.25;
/**
 * Horquilla máxima del contrato (% del mid) para abrir. Por encima, el coste de
 * entrar y salir se come cualquier ventaja del modelo.
 */
export const MAX_SPREAD_PCT = 15;

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

export type ZeroPaperStatus = "abierta" | "ganada" | "perdida" | "expirada";
export type ZeroPaperCloseReason = "objetivo" | "stop" | "trailing" | "cierre_reloj" | "cierre_de_sesion";

/**
 * Versión de la GEOMETRÍA con la que se abrió la posición. Se sube cada vez que
 * cambia lo que decide el objetivo o el stop.
 *
 *   v1  hasta el 2026-08-26 — el cono de 1σ se construía con la IV ATM de la
 *       cadena, que en un 0DTE se dispara por el artefacto del vencimiento:
 *       proyectaba 12× el recorrido real de SPY. Como el objetivo de momentum se
 *       acota justo a 1σ, acababa donde el precio no llega. De las 7 operaciones
 *       con el objetivo a más del 0,58%, ninguna llegó.
 *   v2  desde el 2026-08-26 — el cono usa vol REALIZADA (`coneIv` en zerodte.ts).
 *
 * POR QUÉ SE GUARDA EN CADA POSICIÓN Y NO SOLO EN EL CÓDIGO: sin esto, las
 * operaciones de mañana se promedian con las de v1 en el MISMO win rate y ya no
 * hay forma de saber si el arreglo funcionó. Es la misma razón por la que las
 * posiciones de Venta Prima guardan `expert`.
 *
 * Las 12 cerradas antes de que este campo existiera no lo traen: `undefined` se
 * lee como v1, que es lo que eran. No se reescribe el libro.
 */
/**
 * v4 (2026-09-17): trailing recalibrado con el camino real, +20% / devuelve 25%
 *     (ver `TRAIL_ARMA_PCT`), y límite diario: tras la primera pérdida del día no
 *     se abre nada más (ver `MAX_PERDIDAS_DIA`). Las dos cosas entraron el mismo
 *     día, antes de que ninguna posición naciera con v4, así que comparten versión.
 * v3 (2026-09-07): cierre por reloj a las 15:30 + stop por devolución de pico
 *     (+30% / devuelve 50%).
 * v2: cono con volatilidad realizada. v1: cono con la IV de la cadena (roto).
 *
 * Se sube al cambiar las REGLAS, no solo la geometría, por el mismo motivo de
 * siempre: sin esto las operaciones con las dos salidas nuevas se promediarían
 * con las 46 de antes y no habría forma de saber si sirvieron.
 */
export const MODELO_VERSION = 4;

export interface ZeroPaperPosition {
  id: string;
  openedAt: string;            // ISO
  ticker: string;
  expiration: string;          // YYYY-MM-DD
  optionSymbol: string;
  type: "call" | "put";
  strike: number;
  contracts: number;
  /** Prima pagada por acción al abrir (el mid del contrato). */
  entryPrice: number;
  /** Prima actual por acción. Se re-cotiza en cada gestión. */
  currentPrice: number;
  /** Máxima prima vista. Sirve para saber cuánto se dejó sobre la mesa. */
  peakPrice: number;
  /** Modelo que la generó: reversión al imán o momentum γ−. */
  model: ZeroDteTrade["model"];
  /** Geometría con la que nació. Ausente = v1 (ver MODELO_VERSION). */
  modelVersion?: number;
  side: ZeroDteTrade["side"];
  /** Niveles del SUBYACENTE con los que se decide (no del contrato). */
  entrySpot: number;
  target: number;
  stop: number;
  status: ZeroPaperStatus;
  closedAt: string | null;
  closeReason: ZeroPaperCloseReason | null;
  /** PnL realizado en $ (solo al cerrar), BRUTO: sin comisiones. */
  realizedPnl: number | null;
  /**
   * Comisiones cobradas en $ (apertura + cierre; sin cierre si venció). Se guarda
   * al cerrar desde el 2026-09-17; en las anteriores se DERIVA con `feesOf`.
   */
  fees?: number;
}

/**
 * Comisiones de la posición: una opción suelta = 1 pata. Abierta, solo la de
 * apertura (ya pagada). Cerrada por fin de sesión, igual: el contrato venció y no
 * hubo orden de cierre. Si la posición trae `fees` guardado, manda ese.
 */
export function feesOf(p: Pick<ZeroPaperPosition, "contracts" | "status" | "closeReason" | "fees">): number {
  if (p.fees != null) return p.fees;
  const huboCierre = p.status !== "abierta" && p.closeReason !== "cierre_de_sesion";
  return commissionOf(p.contracts, 1, huboCierre);
}

/** P&L NETO de una cerrada: el bruto menos las comisiones. */
export function netPnlOf(p: ZeroPaperPosition): number {
  return round2((p.realizedPnl ?? 0) - feesOf(p));
}

/** Riesgo máximo en $: la prima pagada. Una opción comprada no pierde más. */
export function maxRiskOf(p: Pick<ZeroPaperPosition, "entryPrice" | "contracts">): number {
  return round2(p.entryPrice * 100 * p.contracts);
}

/** PnL en dólares: (prima actual − prima pagada) × 100 × contratos. */
export function pnlOf(p: Pick<ZeroPaperPosition, "entryPrice" | "currentPrice" | "contracts">): number {
  return round2((p.currentPrice - p.entryPrice) * 100 * p.contracts);
}

/** Rendimiento sobre la prima pagada. −1 = el contrato expiró sin valor. */
export function returnPct(p: Pick<ZeroPaperPosition, "entryPrice" | "currentPrice">): number {
  if (!(p.entryPrice > 0)) return 0;
  return Math.round(((p.currentPrice - p.entryPrice) / p.entryPrice) * 10000) / 10000;
}

/**
 * Contratos según el riesgo por operación. En una opción comprada el riesgo por
 * contrato es la prima × 100, así que sale directo. Devuelve 0 si ni uno cabe:
 * abrir "por lo menos uno" saltándose el límite es como se revientan las cuentas.
 */
export function sizeFor(entryPrice: number, equity: number, riskPct = RISK_PER_TRADE_PCT): number {
  if (!(equity > 0) || !(riskPct > 0) || !(entryPrice > 0)) return 0;
  return Math.max(0, Math.floor((equity * riskPct) / (entryPrice * 100)));
}

// ---------------------------------------------------------------------------
// APERTURA
// ---------------------------------------------------------------------------

export interface OpenPlan {
  /** La posición a abrir, ya dimensionada. null si no toca. */
  position: Omit<ZeroPaperPosition, "id"> | null;
  /** Por qué no se abrió (vacío si sí se abrió). */
  blocked: string;
}

export interface OpenInput {
  ticker: string;
  expiration: string;
  ticket: ZeroDteTicket | null;
  trade: ZeroDteTrade | null;
  spot: number;
  equity: number;
  open: ZeroPaperPosition[];
  /**
   * Cerradas de la sesión, INCLUIDAS las que se acaban de cerrar en este mismo tick.
   * Solo se usan para el enfriamiento (`REOPEN_COOLDOWN_MIN`), y por eso tienen que
   * traer las de este ciclo: el caso que hay que cortar es justo ese.
   */
  closed: ZeroPaperPosition[];
  /** Minutos que restan de sesión. 0 = cerrada. */
  minutesLeft: number;
  sessionOpen: boolean;
  now: Date;
}

/**
 * Minutos que el modelo debe esperar tras CUALQUIER cierre antes de volver a abrir.
 *
 * POR QUÉ EXISTE, y es el hallazgo más caro del libro del 0DTE. No había ninguna
 * espera: el tick que cerraba una posición podía abrir otra **en el mismo instante**,
 * y lo hacía. Medido el 2026-08-28 sobre las 32 cerradas: **15 reentradas con hueco
 * ≤1 min suman −$937 de los −$1.158,50 del libro entero — el 81% de la pérdida**. Y
 * **11 de esas 15 GIRABAN DE LADO** (LONG→SHORT o al revés), o sea el latigazo
 * clásico: el precio cruza el stop, la señal se da la vuelta, se abre lo contrario y
 * el siguiente vaivén lo vuelve a barrer.
 *
 * La raíz es conceptual, no de parámetros: el cierre y la reapertura salían de **la
 * MISMA foto del spot**. Un tick observa un precio; decidir con él que una idea ha
 * muerto y a la vez que la contraria acaba de nacer es reaccionar dos veces al mismo
 * dato. El enfriamiento obliga a que la segunda decisión mire una foto nueva.
 *
 * EL VALOR NO ESTÁ AJUSTADO A LA MUESTRA. Simulado sobre el libro real, 1, 2 y 5 min
 * dan EXACTAMENTE el mismo resultado (−$438,50 y 50% de acierto, contra −$1.158,50 y
 * 42%), porque los huecos reales son de 0 min o de 8+; no hay nada entre medias que
 * ajustar. Alargarlo EMPEORA (15 min → −$649, 30 min → −$773): a partir de ahí se
 * bloquean setups nuevos de verdad, no rebotes del mismo. Se toma el extremo alto del
 * tramo indiferente.
 *
 * Se aplica a los DOS modelos. El daño está repartido: 10 de las 15 son de `magnet`
 * y 5 de `momentum` — no era un defecto del momentum, era del ciclo.
 */
export const REOPEN_COOLDOWN_MIN = 5;

/**
 * LÍMITE DIARIO DE PÉRDIDAS: tras esta cantidad de operaciones cerradas HOY en
 * pérdida NETA, no se abre nada más hasta la sesión siguiente. Las abiertas se
 * siguen gestionando con normalidad: el límite corta entradas, no salidas.
 *
 * Medido el 2026-09-17 contra el libro real (con las horas reales de cierre) y
 * contra la repetición de v3 con el trailing de v4 (ver `TRAIL_ARMA_PCT`), netos
 * de comisiones:
 *
 *                          libro (73)   v2+v3 (60)   replay v4 (27)
 *   sin límite              −$1.757      −$1.036        −$349
 *   parar tras 1 pérdida      −$657        −$186        −$102   ← elegido
 *   parar tras 2 pérdidas   −$1.135        −$611        −$267
 *   parar tras 3 pérdidas     −$967        −$355        −$304
 *   parar tras −$50 en el día −$831        −$359        −$135
 *   parar tras −$100          −$1.216      −$692        −$209
 *
 * Es la única regla que gana en las TRES poblaciones, y por margen. La lectura es
 * la del latigazo que ya motivó `REOPEN_COOLDOWN_MIN`: los días en que la primera
 * idea sale mal son días de vaivén, y las siguientes entradas de ese día pierden
 * también (el 16-sep: cinco stops, tres de ellos girando de lado en 19 minutos).
 * Se prefiere contar pérdidas a contar dólares porque el tamaño de cada operación
 * ya está acotado al 2% del capital, y un umbral en dólares envejece con el capital.
 *
 * EL COSTE, que hay que tener presente: bloquea muchas entradas (40 de 73 en el
 * libro), así que la cuenta acumulará muestra MÁS DESPACIO. Y la medición es dentro
 * de muestra.
 */
export const MAX_PERDIDAS_DIA = 1;

/**
 * Cerradas de HOY (fecha de mercado de Nueva York), abiertas también hoy. Se exige
 * la apertura de hoy para que la liquidación de una posición vencida de otro día
 * —que el tick puede cerrar cualquier mañana— no cuente contra la sesión actual.
 */
function cerradasDeHoy(closed: ZeroPaperPosition[], now: Date): ZeroPaperPosition[] {
  const hoy = marketDateStr(now);
  return closed.filter((p) =>
    p.closedAt != null &&
    marketDateStr(new Date(p.closedAt)) === hoy &&
    marketDateStr(new Date(p.openedAt)) === hoy,
  );
}

/** Operaciones de hoy cerradas en pérdida NETA (con comisiones). PURA. */
export function perdidasDelDia(closed: ZeroPaperPosition[], now: Date): number {
  return cerradasDeHoy(closed, now).filter((p) => netPnlOf(p) < 0).length;
}

/** P&L neto realizado hoy. PURA. */
export function pnlDelDia(closed: ZeroPaperPosition[], now: Date): number {
  return round2(cerradasDeHoy(closed, now).reduce((s, p) => s + netPnlOf(p), 0));
}

/**
 * Minutos desde el último cierre de ese modelo. `null` si nunca cerró ninguna.
 * PURA. Ignora las que no tienen `closedAt` (no deberían estar en el libro cerrado,
 * pero un dato a medias no puede desbloquear una entrada).
 */
export function minutesSinceLastClose(
  closed: ZeroPaperPosition[],
  model: ZeroDteTrade["model"],
  now: Date,
): number | null {
  let ultimo = -Infinity;
  for (const p of closed) {
    if (p.model !== model || !p.closedAt) continue;
    const t = Date.parse(p.closedAt);
    if (Number.isFinite(t) && t > ultimo) ultimo = t;
  }
  if (ultimo === -Infinity) return null;
  return (now.getTime() - ultimo) / 60_000;
}

/**
 * Decide si abrir. PURA.
 *
 * El orden de las comprobaciones importa: primero las de sesión (baratas y
 * absolutas), luego las de cartera, y solo al final las del contrato. Así el
 * motivo que se registra es el primero que de verdad impide operar, no el último
 * que se evaluó.
 */
export function planOpen(input: OpenInput): OpenPlan {
  const { ticket, trade, sessionOpen, minutesLeft, open, equity, now } = input;

  if (!sessionOpen) return no("Fuera de sesión (9:30-16:00 ET).");
  if (minutesLeft <= NO_OPEN_LAST_MIN) {
    return no(`Quedan ${minutesLeft} min de sesión: no se abren 0DTE en los últimos ${NO_OPEN_LAST_MIN}.`);
  }
  // Antes que la señal: el límite manda aunque el agente tenga una idea viva.
  const perdidasHoy = perdidasDelDia(input.closed, now);
  if (perdidasHoy >= MAX_PERDIDAS_DIA) {
    return no(
      `Límite diario: ${perdidasHoy} ${perdidasHoy === 1 ? "operación" : "operaciones"} en pérdida hoy (tope ${MAX_PERDIDAS_DIA}). ` +
        `No se abre nada más hasta la próxima sesión.`,
    );
  }
  if (!trade || !ticket) return no("El agente no tiene trade ni contrato que sugerir ahora mismo.");
  if (open.length >= MAX_OPEN) return no(`Ya hay ${open.length} posiciones abiertas (tope ${MAX_OPEN}).`);
  if (open.some((p) => p.model === trade.model)) {
    return no(`El modelo ${trade.model} ya tiene una posición abierta.`);
  }
  const desdeElCierre = minutesSinceLastClose(input.closed, trade.model, now);
  if (desdeElCierre != null && desdeElCierre < REOPEN_COOLDOWN_MIN) {
    return no(
      `${trade.model} cerró hace ${desdeElCierre < 1 ? "menos de 1" : Math.floor(desdeElCierre)} min: ` +
        `enfriamiento de ${REOPEN_COOLDOWN_MIN} min antes de volver a entrar.`,
    );
  }
  if (open.some((p) => p.ticker === input.ticker && p.type === ticket.type && p.strike === ticket.strike)) {
    return no("Ese mismo contrato ya está abierto.");
  }
  if (ticket.spreadPct != null && ticket.spreadPct > MAX_SPREAD_PCT) {
    return no(`Horquilla del ${ticket.spreadPct.toFixed(1)}% (> ${MAX_SPREAD_PCT}%): entrar y salir se come el edge.`);
  }
  if (!(ticket.mid > 0)) return no("El contrato no tiene precio utilizable.");

  const contracts = sizeFor(ticket.mid, equity);
  if (contracts < 1) {
    const necesario = ticket.mid * 100 / RISK_PER_TRADE_PCT;
    return no(
      `Un contrato cuesta $${(ticket.mid * 100).toFixed(0)}, más del ${(RISK_PER_TRADE_PCT * 100).toFixed(0)}% de $${Math.round(equity)}. Harían falta ~$${Math.round(necesario)}.`,
    );
  }

  return {
    blocked: "",
    position: {
      openedAt: now.toISOString(),
      ticker: input.ticker,
      expiration: input.expiration,
      optionSymbol: ticket.optionSymbol,
      type: ticket.type,
      strike: ticket.strike,
      contracts,
      entryPrice: ticket.mid,
      currentPrice: ticket.mid,
      peakPrice: ticket.mid,
      model: trade.model,
      modelVersion: MODELO_VERSION,
      side: trade.side,
      entrySpot: trade.entry,
      target: trade.target,
      stop: trade.stop,
      status: "abierta",
      closedAt: null,
      closeReason: null,
      realizedPnl: null,
    },
  };
}

function no(blocked: string): OpenPlan {
  return { position: null, blocked };
}

// ---------------------------------------------------------------------------
// GESTIÓN
// ---------------------------------------------------------------------------

export interface ManageDecision {
  action: "mantener" | "cerrar";
  reason: ZeroPaperCloseReason | null;
  detail: string;
}

/**
 * Qué hacer con una posición abierta, mirando el SUBYACENTE. PURA.
 *
 * El objetivo y el stop del modelo están definidos sobre el spot, así que es ahí
 * donde se deciden — no sobre la prima. Un contrato puede valer menos que la
 * entrada por puro theta con el subyacente yendo a favor, y cerrarlo por eso
 * sería cerrar una idea que va bien.
 *
 * Al cerrar la sesión se liquida todo: es 0DTE, no hay mañana.
 */
/**
 * Precio al que salta el trailing, o `null` si todavía no está armado.
 *
 * Armado = el PICO llegó a `TRAIL_ARMA_PCT` sobre la entrada. Se mira el pico y no
 * el precio actual a propósito: la protección se gana por haber llegado, y no se
 * desarma porque el precio haya vuelto.
 */
export function gatilloTrailing(
  p: Pick<ZeroPaperPosition, "entryPrice" | "peakPrice">,
): number | null {
  if (!(p.entryPrice > 0)) return null;
  if (p.peakPrice < p.entryPrice * (1 + TRAIL_ARMA_PCT)) return null;
  return p.entryPrice + (p.peakPrice - p.entryPrice) * (1 - TRAIL_DEVOLUCION_PCT);
}

export function managePosition(
  p: ZeroPaperPosition,
  spot: number,
  minutesLeft: number,
  sessionOpen: boolean,
): ManageDecision {
  const alcanzoObjetivo = p.side === "LONG" ? spot >= p.target : spot <= p.target;
  const alcanzoStop = p.side === "LONG" ? spot <= p.stop : spot >= p.stop;

  // El objetivo manda sobre el stop: si el precio pasó por los dos entre dos
  // consultas, no hay forma de saber el orden, y darle la peor lectura a una
  // idea que llegó a su objetivo falsearía el win rate a la baja.
  if (alcanzoObjetivo) {
    return { action: "cerrar", reason: "objetivo", detail: `El subyacente alcanzó el objetivo ${p.target.toFixed(2)}.` };
  }
  if (alcanzoStop) {
    return { action: "cerrar", reason: "stop", detail: `El subyacente alcanzó el stop ${p.stop.toFixed(2)}.` };
  }
  // Con la sesión ya terminada el motivo es el FIN DE SESIÓN, no el reloj: a esas
  // horas el contrato ya venció y no hay nada que vender. Va primero para que una
  // posición que se coló hasta la campana —el tick no corrió entre las 15:30 y las
  // 16:00— no se etiquete como una salida al mid que nunca ocurrió.
  if (!sessionOpen || minutesLeft <= 0) {
    return { action: "cerrar", reason: "cierre_de_sesion", detail: "Cierre de sesión: el 0DTE no sobrevive al día." };
  }
  // Trailing de ganancia: solo si la posición llegó a correr y está devolviendo.
  // Va antes del reloj porque es el motivo MÁS ESPECÍFICO — a las 15:30 los dos
  // podrían dispararse, y "devolvió parte de la ganancia" dice más que "se hizo la hora".
  const trail = gatilloTrailing(p);
  if (trail != null && p.currentPrice <= trail) {
    return {
      action: "cerrar",
      reason: "trailing",
      detail: `Devolución de pico: llegó a ${p.peakPrice.toFixed(2)} y bajó a ${p.currentPrice.toFixed(2)}; se asegura el ${Math.round((1 - TRAIL_DEVOLUCION_PCT) * 100)}% de la ganancia (${trail.toFixed(2)}).`,
    };
  }

  // Cierre por reloj: DESPUÉS de objetivo y stop, porque si el precio llegó a uno
  // de los dos ese trade lo decidió su plan y así debe contarse. Solo lo que sigue
  // vivo a las 15:30, con mercado abierto, se liquida por hora.
  if (minutesLeft <= CIERRE_RELOJ_MIN) {
    return {
      action: "cerrar",
      reason: "cierre_reloj",
      detail: `Cierre por reloj: quedan ${minutesLeft} min y un 0DTE que llega a la campana sin estar ITM vale cero.`,
    };
  }
  return { action: "mantener", reason: null, detail: "" };
}

/** Aplica una cotización nueva del contrato. Devuelve una copia. PURA. */
export function reprice(p: ZeroPaperPosition, price: number | null): ZeroPaperPosition {
  // Sin precio utilizable NO se toca nada: aplicar una regla sobre un valor
  // rancio puede cerrar una posición sana. Misma norma que primaReprice.
  if (price == null || !Number.isFinite(price) || price < 0) return p;
  return { ...p, currentPrice: price, peakPrice: Math.max(p.peakPrice, price) };
}

/**
 * Cierra la posición y fija el P&L. PURA.
 *
 * Ganada/perdida se decide por el NETO: una salida que gana $0,50 brutos y paga
 * $1,30 de comisiones es una pérdida en la cuenta real.
 */
export function closePosition(
  p: ZeroPaperPosition,
  reason: ZeroPaperCloseReason,
  now: Date,
): ZeroPaperPosition {
  const pnl = pnlOf(p);
  const fees = commissionOf(p.contracts, 1, reason !== "cierre_de_sesion");
  // "expirada" es un desenlace propio: no es que el modelo acertara o fallara, es
  // que se acabó el día. Se cuenta aparte para no ensuciar el win rate.
  //
  // El CIERRE POR RELOJ no entra ahí: a las 15:30 el contrato se vende a un precio
  // real de mercado, así que es una salida como la del objetivo o el stop y su
  // resultado lo decide el dinero. Meterlo en "expirada" volvería a esconder del
  // win rate justo las operaciones que esta regla existe para rescatar.
  const status: ZeroPaperStatus =
    reason === "cierre_de_sesion" ? "expirada" : pnl - fees >= 0 ? "ganada" : "perdida";
  return { ...p, status, closedAt: now.toISOString(), closeReason: reason, realizedPnl: pnl, fees };
}

// ---------------------------------------------------------------------------
// RESUMEN
// ---------------------------------------------------------------------------

export interface ZeroPaperSummary {
  equity: number;
  startEquity: number;
  /** P&L cerrado NETO de comisiones (desde el 2026-09-17; antes era bruto). */
  realizedPnl: number;
  /** El mismo P&L sin descontar comisiones, para ver cuánto se llevan. */
  grossPnl: number;
  /** Comisiones de todas las cerradas + la apertura de las abiertas. */
  feesPaid: number;
  /** P&L latente de las abiertas, descontada la comisión de apertura ya pagada. */
  openPnl: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  expired: number;
  /**
   * 0-100 POR DESENLACE: solo objetivo y stop. Las `expirada` quedan fuera.
   * null sin cierres decididos — un 0% falso desanima sin motivo.
   */
  winRate: number | null;
  /** Ganadoras y perdedoras por el SIGNO del P&L, sobre TODAS las cerradas. */
  winsMoney: number;
  lossesMoney: number;
  /**
   * 0-100 CON DINERO: mismas operaciones que suma `realizedPnl`.
   *
   * Hacen falta los dos porque miden POBLACIONES DISTINTAS, y presentar solo el
   * primero al lado del P&L es engañoso: `winRate` excluye las `expirada`
   * (cerradas a las 16:00 por fin de sesión) pero `realizedPnl` sí las suma.
   * Medido el 2026-09-07 sobre 45 cerradas: **49% por desenlace contra 42% con
   * dinero**, y las 8 expiradas que el primero no ve cargaban **−$784, el 71% de
   * toda la pérdida**. Es exactamente el desajuste que ya obligó a separar
   * `winRatePricedPct` en la bitácora de swing; aquí se había quedado sin aplicar.
   */
  winRateMoneyPct: number | null;
  /** Por modelo, para ver cuál de los dos aporta. */
  byModel: { model: ZeroDteTrade["model"]; closed: number; wins: number; pnl: number; winRate: number | null }[];
  /**
   * Lo mismo, pero por VERSIÓN de la geometría. Es lo que responde "¿el arreglo
   * del cono sirvió?": mezclar v1 y v2 en un solo win rate lo haría indistinguible.
   */
  byVersion: { version: number; closed: number; wins: number; pnl: number; winRate: number | null }[];
  /**
   * Modelo × VERSIÓN, que es el único corte que permite juzgar un modelo hoy.
   *
   * `byModel` a secas mezcla las dos geometrías, y con eso `momentum` aparecía con un
   * **25%** que en realidad son 10 operaciones de v1 (el cono con la IV de la cadena,
   * que proyectaba 12× el movimiento real) y UNA sola de v2. Ese número no describe el
   * modelo que hoy corre, y presentarlo al lado del 50% de `magnet` invita justo a la
   * conclusión equivocada: retirar el momentum por un historial que ya no le
   * corresponde. Es el mismo error de poblaciones mezcladas que ya obligó a separar
   * `winRatePricedPct` en la bitácora de swing.
   */
  byModelVersion: {
    model: ZeroDteTrade["model"]; version: number;
    closed: number; wins: number; pnl: number; winRate: number | null;
  }[];
  /**
   * Por LADO, y cruzado con la versión.
   *
   * Faltaba, y por eso el desequilibrio tardó en verse: el corte por lado solo
   * aparecía parseando el libro a mano. Medido el 2026-09-07 sobre las 46
   * cerradas, **en v2 el largo iba 58% y +$148 y el corto 36% y −$623**.
   *
   * El cruce con la versión no es adorno: `momentum` —que es el modelo que más
   * corto va— tiene casi todas sus operaciones en v1, la geometría del cono roto,
   * así que `bySide` a secas mezcla un defecto ya arreglado con el lado. Es el
   * mismo motivo por el que existe `byModelVersion`.
   *
   * El win rate va **por el signo del P&L** (mismas operaciones que la suma), no
   * por desenlace: si excluyera las expiradas escondería justo donde el corto
   * pierde — 4 de sus 9 pérdidas de v2 murieron en la campana.
   */
  bySide: {
    side: ZeroDteTrade["side"]; version: number;
    closed: number; wins: number; pnl: number; winRate: number | null;
  }[];
}

export function summarize(
  closed: ZeroPaperPosition[],
  open: ZeroPaperPosition[],
  startEquity = START_EQUITY,
): ZeroPaperSummary {
  // Todo lo que habla de DINERO va neto de comisiones; los desenlaces no cambian.
  const realizedPnl = round2(closed.reduce((s, p) => s + netPnlOf(p), 0));
  const grossPnl = round2(closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0));
  const openFees = open.reduce((s, p) => s + feesOf(p), 0);
  const feesPaid = round2(closed.reduce((s, p) => s + feesOf(p), 0) + openFees);
  const openPnl = round2(open.reduce((s, p) => s + pnlOf(p), 0) - openFees);
  const wins = closed.filter((p) => p.status === "ganada").length;
  const losses = closed.filter((p) => p.status === "perdida").length;
  const expired = closed.filter((p) => p.status === "expirada").length;
  const decided = wins + losses;
  const winsMoney = closed.filter((p) => netPnlOf(p) > 0).length;
  const lossesMoney = closed.filter((p) => netPnlOf(p) < 0).length;

  const models: ZeroDteTrade["model"][] = ["magnet", "momentum"];
  const byModel = models.map((model) => {
    const mine = closed.filter((p) => p.model === model);
    const w = mine.filter((p) => p.status === "ganada").length;
    const l = mine.filter((p) => p.status === "perdida").length;
    return {
      model,
      closed: mine.length,
      wins: w,
      pnl: round2(mine.reduce((s, p) => s + netPnlOf(p), 0)),
      winRate: w + l > 0 ? Math.round((w / (w + l)) * 100) : null,
    };
  });

  // `undefined` = v1: son las que se cerraron antes de que el campo existiera.
  const versiones = [...new Set(closed.map((p) => p.modelVersion ?? 1))].sort((a, b) => a - b);
  const byVersion = versiones.map((version) => {
    const mine = closed.filter((p) => (p.modelVersion ?? 1) === version);
    const w = mine.filter((p) => p.status === "ganada").length;
    const l = mine.filter((p) => p.status === "perdida").length;
    return {
      version,
      closed: mine.length,
      wins: w,
      pnl: round2(mine.reduce((s, p) => s + netPnlOf(p), 0)),
      winRate: w + l > 0 ? Math.round((w / (w + l)) * 100) : null,
    };
  });

  const byModelVersion = models.flatMap((model) =>
    versiones.map((version) => {
      const mine = closed.filter((p) => p.model === model && (p.modelVersion ?? 1) === version);
      const w = mine.filter((p) => p.status === "ganada").length;
      const l = mine.filter((p) => p.status === "perdida").length;
      return {
        model,
        version,
        closed: mine.length,
        wins: w,
        pnl: round2(mine.reduce((s, p) => s + netPnlOf(p), 0)),
        winRate: w + l > 0 ? Math.round((w / (w + l)) * 100) : null,
      };
    }),
  ).filter((r) => r.closed > 0);

  const lados: ZeroDteTrade["side"][] = ["LONG", "SHORT"];
  const bySide = lados.flatMap((side) =>
    versiones.map((version) => {
      const mine = closed.filter((p) => p.side === side && (p.modelVersion ?? 1) === version);
      const w = mine.filter((p) => netPnlOf(p) > 0).length;
      const l = mine.filter((p) => netPnlOf(p) < 0).length;
      return {
        side,
        version,
        closed: mine.length,
        wins: w,
        pnl: round2(mine.reduce((s, p) => s + netPnlOf(p), 0)),
        winRate: w + l > 0 ? Math.round((w / (w + l)) * 100) : null,
      };
    }),
  ).filter((r) => r.closed > 0);

  return {
    equity: round2(startEquity + realizedPnl),
    startEquity,
    realizedPnl,
    grossPnl,
    feesPaid,
    openPnl,
    openCount: open.length,
    closedCount: closed.length,
    wins,
    losses,
    expired,
    winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
    winsMoney,
    lossesMoney,
    winRateMoneyPct:
      winsMoney + lossesMoney > 0
        ? Math.round((winsMoney / (winsMoney + lossesMoney)) * 100)
        : null,
    byModel,
    byVersion,
    byModelVersion,
    bySide,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
