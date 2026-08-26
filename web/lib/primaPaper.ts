// ============================================================================
// PAPER TRADING DE VENTA DE PRIMA — dentro de Tito.
//
// Cierra el traslado: la ESTRATEGIA ya vivía aquí (`lib/creditSpread.ts`, realineada
// al doc del operador en ago 2026), pero la EJECUCIÓN —abrir, seguir, cerrar y
// anotar— se había quedado en el bot Python de `Desktop/Venta Prima`. Esto la trae.
//
// PLAN OPERATIVO DEL DUEÑO (ago 2026):
//   · Escanear y abrir los LUNES y MARTES, disparo a las 11:45 ET.
//   · Tomar 3–5 candidatos, ordenados por PROBABILIDAD (POP) a secas.
//   · Miércoles en adelante: si pierde ≥30% del crédito, cerrar.
//   · Si va en ganancia, aguantar a vencimiento (viernes 16:00) para el 100%.
//   · El viernes, si tocó ≥50% y retrocede de forma material, recoger sobre el 50%.
//
// Nada de esto mueve dinero real. Todo aquí es PURO: la I/O vive en
// `primaPaperStore.ts` y en `app/api/prima-paper/*`. Tests en `primaPaper.test.ts`.
// ============================================================================

import type { SpreadCandidate } from "./creditSpread";

// ---------------------------------------------------------------------------
// Constantes del plan
// ---------------------------------------------------------------------------

/** Capital hipotético de partida. NO se resetea: el equity se deriva del libro. */
export const START_EQUITY = 10_000;
/** Máximo de posiciones que se abren en una sesión. */
export const MAX_NEW_PER_SESSION = 5;
/** Mínimo que se considera una tanda decente (informativo, no bloquea). */
export const MIN_NEW_PER_SESSION = 3;
/** Tope de posiciones abiertas a la vez. */
export const MAX_OPEN = 5;
/** Tope por sector, para no concentrar. */
export const MAX_PER_SECTOR = 2;
/**
 * Días en que se abre (0=domingo … 1=lunes, 2=martes).
 *
 * OJO — con la banda de 4–7 DTE de `creditSpread.ts`, el MARTES el universo
 * efectivo se ENCOGE. Desde un martes el viernes de esa semana queda a 3 DTE
 * (fuera por abajo) y el siguiente a 10 (fuera por arriba), así que solo entran
 * los nombres con vencimientos INTERSEMANALES, cuyo lunes siguiente cae a 6 DTE.
 *
 * Medido contra MarketSnack el 2026-08-17 (martes = 18-ago): AAPL, MSFT y SPY sí
 * tienen (24-ago a 6 DTE; SPY además 25-ago a 7), pero de 12 nombres medianos del
 * S&P 100 probados (SO, DUK, CL, MMM, USB, GD, EMR, KHC, EXC, TGT, LOW, MDT)
 * **ninguno** tenía cadena en banda: sus weeklies son solo de viernes. El lunes no
 * sufre esto (el viernes propio cae a 4 DTE, justo en el borde).
 *
 * Para que el martes cubriera todo el universo habría que bajar `DTE_MIN` a 3, y
 * eso cambia la estrategia, así que no se toca sin pedirlo.
 */
export const OPEN_WEEKDAYS = [1, 2];
/**
 * Ventana de apertura, en minutos desde medianoche **hora de Nueva York**.
 *
 * El plan del dueño es: mirar candidatos de 10:30 a 11:40 y **disparar a las 11:45**.
 * El bot Python permitía hasta las 16:00 (`entry.latest_time`), pero podía: sin
 * recuperación de disparos perdidos, una corrida que no ocurría a las 11:45 no
 * ocurría y punto. Aquí SÍ hay recuperación (para que un PC dormido no pierda la
 * única ventana semanal), así que el tope se ajusta al plan: si el equipo despierta
 * a las 15:00, más vale saltar la semana que abrir cuatro horas fuera de criterio.
 * Las 12:00 dejan margen al disparo de las 11:45 para arrancar Tito y compilar.
 */
export const OPEN_FROM_MIN = 10 * 60 + 30; // 10:30 ET
export const OPEN_TO_MIN = 12 * 60;        // 12:00 ET
/** Desde qué día se revisa la pérdida (3 = miércoles). No antes: el ruido de
 *  lunes y martes cerraría posiciones sanas. */
export const LOSS_CHECK_WEEKDAY = 3;
/** Cierra si la pérdida alcanza este % del crédito cobrado. */
export const MAX_LOSS_PCT = 0.30;
/** Suelo de ganancia el día del vencimiento. */
export const PROFIT_FLOOR_PCT = 0.50;
/** Retroceso mínimo (en puntos de %) para que el suelo dispare: sin esto, un tick
 *  de ruido cerraría una posición sana. */
export const PROFIT_RETRACE_PTS = 0.05;

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

export type PrimaStatus = "abierta" | "ganada" | "perdida" | "neutra";
export type PrimaSpreadType = "put_credit" | "call_credit";

export interface PrimaPosition {
  id: string;
  openedAt: string;          // ISO
  ticker: string;
  sector: string;
  type: PrimaSpreadType;
  shortStrike: number;
  longStrike: number;
  width: number;
  expiration: string;        // YYYY-MM-DD
  contracts: number;
  /** Crédito cobrado por acción (mid corto − mid largo) al abrir. */
  entryCredit: number;
  /** Coste actual de cerrar (débito por acción). Se re-cotiza en cada gestión. */
  currentValue: number;
  /** Máximo de `profitPct` visto. Lo necesita el suelo de ganancia del viernes. */
  peakProfitPct: number;
  /** |Δ| de la pata corta al abrir, y re-cotizado si hay dato. */
  shortDelta: number;
  /** POP con el que se eligió (0-100). Es el criterio de ranking del dueño. */
  popPct: number;
  /**
   * Régimen del escáner que la produjo. Opcional porque el libro es append-only
   * y las filas anteriores a 2026-08-24 nacieron todas en modo seguro; sin este
   * dato, un cambio de régimen mezclaría dos estrategias en el mismo win rate.
   */
  expert?: boolean;
  /**
   * Fracción del capital arriesgada al abrir (0.02 = 2%). Opcional: las posiciones
   * anteriores al 2026-08-24 nacieron todas al borde bajo del mandato. Se guarda
   * porque desde esa fecha una posición puede dimensionarse hasta el 3% cuando al
   * 2% no cabía ni un contrato, y sin este dato el win rate mezclaría dos tamaños
   * de apuesta — el mismo motivo por el que se guarda `expert`.
   */
  riskPctUsed?: number;
  /**
   * En cuántas pasadas de observación (10:30-11:30 ET) se había visto este mismo
   * spread antes de abrirlo. Opcional: las posiciones anteriores a 2026-08-24
   * nacieron sin ventana previa. NO filtra — se guarda para poder contestar con
   * datos si conviene exigir persistencia, en vez de elegir un umbral a ciegas.
   */
  seenInPasses?: number;
  status: PrimaStatus;
  closedAt: string | null;
  closeReason: string | null;
  /** PnL realizado en $ (solo al cerrar). */
  realizedPnl: number | null;
}

/** Riesgo máximo por contrato en $: (ancho − crédito) × 100. */
export function maxRiskOf(p: Pick<PrimaPosition, "width" | "entryCredit">): number {
  return Math.round((p.width - p.entryCredit) * 100 * 100) / 100;
}

/** Fracción del crédito ya capturada. 1 = el spread vale 0 (100% de la prima). */
export function profitPct(p: Pick<PrimaPosition, "entryCredit" | "currentValue">): number {
  if (!(p.entryCredit > 0)) return 0;
  return Math.round(((p.entryCredit - p.currentValue) / p.entryCredit) * 10000) / 10000;
}

/** Pérdida como fracción del crédito (0 si va en ganancia). */
export function lossPct(p: Pick<PrimaPosition, "entryCredit" | "currentValue">): number {
  if (!(p.entryCredit > 0)) return 0;
  const perdida = Math.max(0, p.currentValue - p.entryCredit);
  return Math.round((perdida / p.entryCredit) * 10000) / 10000;
}

/** PnL en dólares: (crédito − coste de cerrar) × 100 × contratos. */
export function pnlOf(p: Pick<PrimaPosition, "entryCredit" | "currentValue" | "contracts">): number {
  return Math.round((p.entryCredit - p.currentValue) * 100 * p.contracts * 100) / 100;
}

/** Días al vencimiento vistos desde `day`. Inyectable a propósito: atarlo al reloj
 *  real hacía que las reglas del viernes fueran imposibles de probar. */
export function dteOn(expiration: string, day: Date): number {
  const [y, m, d] = expiration.split("-").map(Number);
  const exp = Date.UTC(y, m - 1, d);
  const hoy = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return Math.round((exp - hoy) / 86_400_000);
}

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const ET_WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Hora de pared de **Nueva York** (día de la semana + minutos desde medianoche).
 *
 * Se calcula con `Intl` y NO con el reloj local a propósito: esta laptop va en
 * UTC−4 todo el año, pero Nueva York pasa a UTC−5 de noviembre a marzo. Con el
 * reloj local, medio año el disparo "de las 11:45" caería en realidad a las 10:45
 * ET — a quince minutos de quedar fuera de la ventana sin que nadie lo notara.
 * PURA salvo por el calendario de husos, que es dato del sistema.
 */
export function etWallClock(now: Date): { weekday: number; minutes: number } {
  const parts = ET_FMT.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ET_WEEKDAYS[get("weekday")] ?? now.getDay();
  // Algunas versiones de ICU devuelven "24" para la medianoche con hour12:false.
  const hour = Number(get("hour")) % 24;
  return { weekday, minutes: hour * 60 + Number(get("minute")) };
}

/** 705 → "11:45". Solo para los mensajes de bloqueo. */
function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// APERTURA
// ---------------------------------------------------------------------------

export interface OpenPlan {
  /** Candidatos elegidos, ya recortados por los topes de cartera. */
  chosen: SpreadCandidate[];
  /** Por qué no se abrió nada (null si sí se abre). */
  blocked: string | null;
  /** Motivos de descarte por candidato, para poder auditar la elección. */
  skipped: { ticker: string; why: string }[];
}

const WEEKDAY_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/**
 * Decide qué abrir. PURA.
 *
 * Orden por **POP a secas**, que es lo que pidió el dueño. Contrapartida asumida:
 * el POP más alto es el que MENOS paga (más lejos del dinero = más probable = menos
 * crédito). El margen sobre el equilibrio sigue disponible en `stats` para poder
 * comparar los dos criterios a posteriori.
 */
export function planOpen(
  candidates: SpreadCandidate[],
  open: PrimaPosition[],
  now: Date,
  /**
   * `ignoreWindow` salta SOLO la puerta de día y hora, para el ENSAYO
   * (`action:"preview"`), que responde "¿qué abriría?" sin escribir nada. Los topes
   * de cartera y el resto del criterio siguen aplicándose enteros.
   *
   * NUNCA lo use el camino que abre de verdad: esa puerta existe porque fuera de
   * sesión las horquillas se disparan y el crédito que se registraría no existe.
   */
  opts: { ignoreWindow?: boolean } = {},
): OpenPlan {
  const skipped: { ticker: string; why: string }[] = [];

  // Día Y hora se miden en Nueva York, no en el reloj local: son la misma puerta
  // y mezclar husos dejaría un desfase silencioso medio año.
  const et = etWallClock(now);

  if (!opts.ignoreWindow && !OPEN_WEEKDAYS.includes(et.weekday)) {
    const dias = OPEN_WEEKDAYS.map((d) => WEEKDAY_ES[d]).join(" y ");
    return {
      chosen: [], skipped,
      blocked: `solo se abre los ${dias} (hoy es ${WEEKDAY_ES[et.weekday]} en Nueva York)`,
    };
  }

  // Sin esta puerta, un disparo fuera de horario abre con cotizaciones de mercado
  // cerrado: bid-ask desbocado y un crédito que no existe. El bot Python la tenía
  // (`entry_gate`) y se perdió al trasladar el motor; esto la devuelve.
  if (!opts.ignoreWindow && (et.minutes < OPEN_FROM_MIN || et.minutes >= OPEN_TO_MIN)) {
    return {
      chosen: [], skipped,
      blocked: `fuera de la ventana de apertura (${hhmm(OPEN_FROM_MIN)}–${hhmm(OPEN_TO_MIN)} ET; son las ${hhmm(et.minutes)} ET)`,
    };
  }

  const vivas = open.filter((p) => p.status === "abierta");
  const hueco = MAX_OPEN - vivas.length;
  if (hueco <= 0) {
    return { chosen: [], skipped, blocked: `ya hay ${vivas.length} posiciones abiertas (tope ${MAX_OPEN})` };
  }

  const porSector = new Map<string, number>();
  for (const p of vivas) porSector.set(p.sector, (porSector.get(p.sector) ?? 0) + 1);
  const yaAbierto = new Set(vivas.map((p) => p.ticker));

  const ordenados = [...candidates].sort((a, b) => b.stats.probOtmPct - a.stats.probOtmPct);

  const chosen: SpreadCandidate[] = [];
  for (const c of ordenados) {
    if (chosen.length >= Math.min(hueco, MAX_NEW_PER_SESSION)) break;
    if (yaAbierto.has(c.ticker)) { skipped.push({ ticker: c.ticker, why: "ya hay una posición abierta en ese subyacente" }); continue; }
    const n = porSector.get(c.sector) ?? 0;
    if (n >= MAX_PER_SECTOR) { skipped.push({ ticker: c.ticker, why: `tope de ${MAX_PER_SECTOR} por sector (${c.sector})` }); continue; }
    chosen.push(c);
    yaAbierto.add(c.ticker);
    porSector.set(c.sector, n + 1);
  }

  return { chosen, skipped, blocked: chosen.length === 0 ? "ningún candidato pasó los topes de cartera" : null };
}

/** Convierte un candidato en posición abierta. PURA (el id y la hora se inyectan). */
export function positionFrom(
  c: SpreadCandidate,
  contracts: number,
  id: string,
  now: Date,
  expert = false,
  seenInPasses?: number,
  riskPctUsed?: number,
): PrimaPosition {
  return {
    id,
    openedAt: now.toISOString(),
    ticker: c.ticker,
    sector: c.sector,
    type: c.type === "put" ? "put_credit" : "call_credit",
    shortStrike: c.shortLeg.strike,
    longStrike: c.longLeg.strike,
    width: c.economics.width,
    expiration: c.expiration,
    contracts,
    entryCredit: c.economics.credit,
    currentValue: c.economics.credit,   // al abrir, cerrarlo cuesta lo mismo que cobraste
    peakProfitPct: 0,
    shortDelta: c.shortLeg.absDelta,
    popPct: c.stats.probOtmPct,
    expert,
    seenInPasses,
    riskPctUsed,
    status: "abierta",
    closedAt: null,
    closeReason: null,
    realizedPnl: null,
  };
}

/**
 * Contratos según el riesgo por operación. El saldo NUNCA llega al servidor en el
 * resto de la app, pero aquí la cuenta es SIMULADA y su capital es público
 * ($10.000), así que se puede dimensionar sin tocar datos del usuario.
 *
 * `riskPct` es el borde BAJO del mandato §8 (2–3% del capital) por defecto, que es
 * lo que usa la cuenta de paper. La ficha de /spreads pasa también el 3% para
 * enseñar la banda: el mandato da un rango, no un número, y ver los dos extremos
 * dice más que ver uno solo. PURA — corre igual en el servidor y en el cliente.
 */
export const RISK_PER_TRADE_PCT = 0.02;
export const RISK_PER_TRADE_MAX_PCT = 0.03;
export function sizeFor(
  c: SpreadCandidate,
  equity: number,
  riskPct: number = RISK_PER_TRADE_PCT,
): number {
  if (!(equity > 0) || !(riskPct > 0)) return 0;
  const riesgo = equity * riskPct;
  const porContrato = c.economics.maxRisk;
  if (!(porContrato > 0)) return 0;
  return Math.max(0, Math.floor(riesgo / porContrato));
}

/**
 * Contratos usando la BANDA del mandato §8 (2–3%), no su borde bajo.
 *
 * Por qué existe: `sizeFor` al 2% clavado convertía el borde bajo en un suelo DURO,
 * y con $10.000 de capital eso son $200 por operación. Un spread de $2,50 de ancho
 * arriesga ~$230 (2,3% — dentro de la banda), así que `floor(200/230)` daba **cero
 * contratos** y el candidato se caía. Y el ancho no es una preferencia: los strikes
 * de AAPL a $325 van de $2,50 en $2,50, así que el spread MÁS ESTRECHO que existe
 * ahí ya es de $2,50.
 *
 * Resultado medido el 2026-08-24: de 16 candidatos que pasaron TODOS los filtros
 * —AAPL, AMZN, NVDA, ORCL entre ellos— se abrieron 2, y los dos eran índices. No
 * porque el motor los prefiera, sino porque **SPY, QQQ e IWM son los únicos con grid
 * de $1**, el único ancho que cabía en $200. Con el tope de 2 por sector, la cuenta
 * salía SPY + QQQ todas las semanas.
 *
 * Regla: se dimensiona al borde BAJO como siempre; solo si eso da 0 se comprueba si
 * UN contrato cabe dentro del borde ALTO. Nunca se estira para poner más de uno —
 * estirar el mandato para tomar una posición que no cabía es una cosa, y usar el
 * tope como tamaño normal es otra.
 */
export function sizeForBand(
  c: SpreadCandidate,
  equity: number,
  lo: number = RISK_PER_TRADE_PCT,
  hi: number = RISK_PER_TRADE_MAX_PCT,
): { contracts: number; riskPct: number } {
  const riesgoUnitario = c.economics.maxRisk;
  const conBase = sizeFor(c, equity, lo);
  if (conBase >= 1) return { contracts: conBase, riskPct: pctOf(riesgoUnitario * conBase, equity) };

  // No cabe ni uno al borde bajo: ¿cabe UNO dentro del tope del mandato?
  if (sizeFor(c, equity, hi) >= 1) return { contracts: 1, riskPct: pctOf(riesgoUnitario, equity) };

  return { contracts: 0, riskPct: 0 };
}

/** Fracción del capital que arriesga una posición, redondeada a 4 decimales. */
function pctOf(riesgo: number, equity: number): number {
  if (!(equity > 0)) return 0;
  return Math.round((riesgo / equity) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// GESTIÓN
// ---------------------------------------------------------------------------

export type PrimaAction = "mantener" | "cerrar" | "avisar";

export interface ManageDecision {
  action: PrimaAction;
  reason: string;
}

/**
 * Decide qué hacer con una posición abierta. PURA.
 *
 * OJO al orden: la válvula de pérdida va PRIMERO. Si la posición está hundida, da
 * igual lo que diga el suelo de ganancia.
 */
export function managePosition(p: PrimaPosition, day: Date): ManageDecision {
  const dte = dteOn(p.expiration, day);
  const ganancia = profitPct(p);
  const perdida = lossPct(p);
  const pico = Math.max(p.peakProfitPct, ganancia);

  // 1) Válvula de pérdida, de miércoles en adelante.
  if (day.getDay() >= LOSS_CHECK_WEEKDAY && perdida >= MAX_LOSS_PCT) {
    return {
      action: "cerrar",
      reason: `Pérdida ${Math.round(perdida * 100)}% del crédito (≥ ${Math.round(MAX_LOSS_PCT * 100)}%) en la revisión de ${WEEKDAY_ES[day.getDay()]}.`,
    };
  }

  // 2) Suelo de ganancia, SOLO el día del vencimiento y con tres condiciones:
  //    llegó al suelo, SIGUE por encima (se cierra CON más del 50%, que es el
  //    objetivo) y el retroceso es material.
  if (dte <= 0) {
    const retroceso = pico - ganancia;
    if (pico >= PROFIT_FLOOR_PCT && ganancia >= PROFIT_FLOOR_PCT && retroceso >= PROFIT_RETRACE_PTS) {
      return {
        action: "cerrar",
        reason: `Suelo de ganancia: tocó ${Math.round(pico * 100)}% y retrocedió a ${Math.round(ganancia * 100)}% (−${Math.round(retroceso * 100)} puntos). Se recoge por encima del ${Math.round(PROFIT_FLOOR_PCT * 100)}%.`,
      };
    }
    if (dte < 0) {
      return { action: "cerrar", reason: `Venció el ${p.expiration}: se liquida al valor final.` };
    }
  }

  // 3) Aviso de gamma: no cierra (el plan es aguantar), pero se ve en el log.
  if (dte <= 2 && p.shortDelta >= 0.40) {
    return {
      action: "avisar",
      reason: `Aviso de gamma: DTE=${dte} y Δ corto ${p.shortDelta.toFixed(2)} ≥ 0.40. El plan es aguantar a vencimiento; vigilar.`,
    };
  }

  return { action: "mantener", reason: `Dentro de parámetros (DTE=${dte}, ${Math.round(ganancia * 100)}% capturado).` };
}

/** Sella el cierre en la posición. Devuelve una copia cerrada. */
export function closePosition(p: PrimaPosition, reason: string, day: Date): PrimaPosition {
  const pnl = pnlOf(p);
  return {
    ...p,
    status: pnl > 0 ? "ganada" : pnl < 0 ? "perdida" : "neutra",
    closedAt: day.toISOString(),
    closeReason: reason,
    realizedPnl: pnl,
    peakProfitPct: Math.max(p.peakProfitPct, profitPct(p)),
  };
}

/** Actualiza el precio y el pico. El pico hay que marcarlo en CADA re-cotización:
 *  si solo se mirara al decidir, un máximo alcanzado entre dos pasadas se perdería. */
export function reprice(p: PrimaPosition, currentValue: number, shortDelta?: number): PrimaPosition {
  const next = { ...p, currentValue, shortDelta: shortDelta ?? p.shortDelta };
  next.peakProfitPct = Math.max(p.peakProfitPct, profitPct(next));
  return next;
}

// ---------------------------------------------------------------------------
// CUENTA
// ---------------------------------------------------------------------------

export interface PrimaSummary {
  startEquity: number;
  realizedPnl: number;
  equity: number;
  returnPct: number;
  trades: number;
  wins: number;
  losses: number;
  neutral: number;
  /** null (no 0) mientras no haya operaciones decididas. */
  winRate: number | null;
  openCount: number;
  unrealizedPnl: number;
  committed: number;
  equityCurve: number[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function summarize(
  closed: PrimaPosition[],
  open: PrimaPosition[],
  startEquity = START_EQUITY,
): PrimaSummary {
  const realized = r2(closed.reduce((s, p) => s + (p.realizedPnl ?? 0), 0));
  const curve: number[] = [r2(startEquity)];
  let acc = startEquity;
  for (const p of closed) { acc += p.realizedPnl ?? 0; curve.push(r2(acc)); }

  const wins = closed.filter((p) => p.status === "ganada").length;
  const losses = closed.filter((p) => p.status === "perdida").length;
  const neutral = closed.filter((p) => p.status === "neutra").length;
  const decided = wins + losses;

  const vivas = open.filter((p) => p.status === "abierta");
  return {
    startEquity: r2(startEquity),
    realizedPnl: realized,
    equity: r2(startEquity + realized),
    returnPct: startEquity ? Math.round((realized / startEquity) * 10000) / 100 : 0,
    trades: closed.length,
    wins, losses, neutral,
    winRate: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null,
    openCount: vivas.length,
    unrealizedPnl: r2(vivas.reduce((s, p) => s + pnlOf(p), 0)),
    committed: r2(vivas.reduce((s, p) => s + maxRiskOf(p) * p.contracts, 0)),
    equityCurve: curve,
  };
}
