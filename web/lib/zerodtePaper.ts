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
 * Horquilla máxima del contrato (% del mid) para abrir. Por encima, el coste de
 * entrar y salir se come cualquier ventaja del modelo.
 */
export const MAX_SPREAD_PCT = 15;

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

export type ZeroPaperStatus = "abierta" | "ganada" | "perdida" | "expirada";
export type ZeroPaperCloseReason = "objetivo" | "stop" | "cierre_de_sesion";

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
  side: ZeroDteTrade["side"];
  /** Niveles del SUBYACENTE con los que se decide (no del contrato). */
  entrySpot: number;
  target: number;
  stop: number;
  status: ZeroPaperStatus;
  closedAt: string | null;
  closeReason: ZeroPaperCloseReason | null;
  /** PnL realizado en $ (solo al cerrar). */
  realizedPnl: number | null;
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
  /** Minutos que restan de sesión. 0 = cerrada. */
  minutesLeft: number;
  sessionOpen: boolean;
  now: Date;
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
  if (!trade || !ticket) return no("El agente no tiene trade ni contrato que sugerir ahora mismo.");
  if (open.length >= MAX_OPEN) return no(`Ya hay ${open.length} posiciones abiertas (tope ${MAX_OPEN}).`);
  if (open.some((p) => p.model === trade.model)) {
    return no(`El modelo ${trade.model} ya tiene una posición abierta.`);
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
  if (!sessionOpen || minutesLeft <= 0) {
    return { action: "cerrar", reason: "cierre_de_sesion", detail: "Cierre de sesión: el 0DTE no sobrevive al día." };
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

/** Cierra la posición y fija el P&L. PURA. */
export function closePosition(
  p: ZeroPaperPosition,
  reason: ZeroPaperCloseReason,
  now: Date,
): ZeroPaperPosition {
  const pnl = pnlOf(p);
  // "expirada" es un desenlace propio: no es que el modelo acertara o fallara,
  // es que se acabó el día. Se cuenta aparte para no ensuciar el win rate.
  const status: ZeroPaperStatus =
    reason === "cierre_de_sesion" ? "expirada" : pnl >= 0 ? "ganada" : "perdida";
  return { ...p, status, closedAt: now.toISOString(), closeReason: reason, realizedPnl: pnl };
}

// ---------------------------------------------------------------------------
// RESUMEN
// ---------------------------------------------------------------------------

export interface ZeroPaperSummary {
  equity: number;
  startEquity: number;
  realizedPnl: number;
  openPnl: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  expired: number;
  /** 0-100. null sin cierres decididos — un 0% falso desanima sin motivo. */
  winRate: number | null;
  /** Por modelo, para ver cuál de los dos aporta. */
  byModel: { model: ZeroDteTrade["model"]; closed: number; wins: number; pnl: number; winRate: number | null }[];
}

export function summarize(
  closed: ZeroPaperPosition[],
  open: ZeroPaperPosition[],
  startEquity = START_EQUITY,
): ZeroPaperSummary {
  const realizedPnl = round2(closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0));
  const openPnl = round2(open.reduce((s, p) => s + pnlOf(p), 0));
  const wins = closed.filter((p) => p.status === "ganada").length;
  const losses = closed.filter((p) => p.status === "perdida").length;
  const expired = closed.filter((p) => p.status === "expirada").length;
  const decided = wins + losses;

  const models: ZeroDteTrade["model"][] = ["magnet", "momentum"];
  const byModel = models.map((model) => {
    const mine = closed.filter((p) => p.model === model);
    const w = mine.filter((p) => p.status === "ganada").length;
    const l = mine.filter((p) => p.status === "perdida").length;
    return {
      model,
      closed: mine.length,
      wins: w,
      pnl: round2(mine.reduce((s, p) => s + (p.realizedPnl ?? 0), 0)),
      winRate: w + l > 0 ? Math.round((w / (w + l)) * 100) : null,
    };
  });

  return {
    equity: round2(startEquity + realizedPnl),
    startEquity,
    realizedPnl,
    openPnl,
    openCount: open.length,
    closedCount: closed.length,
    wins,
    losses,
    expired,
    winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
    byModel,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
