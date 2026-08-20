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

export type PaperStatus = "pendiente" | "activa" | "ganada" | "perdida" | "expirada";
export type OptionType = "call" | "put";
/** Hacia dónde debe moverse el subyacente para cruzar el gatillo y buscar el objetivo. */
export type Direction = "up" | "down";
export type CloseReason = "objetivo" | "stop" | "trailing" | "expirada" | "caducada" | "manual" | null;
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
  contracts: number; // editable

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
/** P&L realizado (solo si cerró con entrada y salida). */
export function realizedPnl(t: PaperTrade): number {
  if (t.entryPrice == null || t.exitPrice == null) return 0;
  return (t.exitPrice - t.entryPrice) * 100 * t.contracts;
}
/** P&L NO realizado de un trade activo (entrada vs. prima actual). */
export function unrealizedPnl(t: PaperTrade): number {
  if (t.status !== "activa" || t.entryPrice == null || t.currentPrice == null) return 0;
  return (t.currentPrice - t.entryPrice) * 100 * t.contracts;
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
  });

  if (t.status === "pendiente") {
    // Sin activar y ya venció → nunca disparó.
    if (isExpired(t, now)) return close("expirada", "expirada", null);
    // Cruza el gatillo → se activa a la prima actual (necesitamos la prima para la entrada).
    // Va ANTES de la caducidad a propósito: un plan que cruza justo el día 7 SÍ disparó,
    // sería absurdo matarlo por viejo en el mismo instante en que funciona.
    if (u != null && mark != null && crossedTrigger(t, u)) {
      return { ...t, status: "activa", entryPrice: mark, entryAt: nowIso, peakPrice: mark };
    }
    // No cruzó y la señal ya envejeció → se cierra y LIBERA el ticker.
    if (pendingTooOld(t, now)) return close("expirada", "caducada", null);
    return t; // sigue pendiente
  }

  // status === "activa"
  const peak = mark != null ? Math.max(t.peakPrice ?? t.entryPrice ?? mark, mark) : t.peakPrice;
  const active: PaperTrade = { ...t, peakPrice: peak };
  const exitMark = mark ?? active.currentPrice;

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
  if (isExpired(active, now)) return { ...close("expirada", "expirada", exitMark), peakPrice: peak };
  return active;
}

export interface PaperSummary {
  closedPnl: number; // P&L neto de lo cerrado
  wins: number;
  losses: number;
  winRatePct: number | null;
  pending: number;
  active: number;
  openUnrealized: number; // suma del P&L no realizado de los activos
}

/** Estadísticas de la bitácora. Un cierre cuenta como acierto/fallo por el signo del P&L. */
export function summarize(trades: PaperTrade[]): PaperSummary {
  let closedPnl = 0;
  let wins = 0;
  let losses = 0;
  let pending = 0;
  let active = 0;
  let openUnrealized = 0;
  for (const t of trades) {
    if (isClosed(t)) {
      const pnl = realizedPnl(t);
      closedPnl += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    } else if (t.status === "pendiente") {
      pending++;
    } else if (t.status === "activa") {
      active++;
      openUnrealized += unrealizedPnl(t);
    }
  }
  const decided = wins + losses;
  return {
    closedPnl,
    wins,
    losses,
    winRatePct: decided > 0 ? (wins / decided) * 100 : null,
    pending,
    active,
    openUnrealized,
  };
}
