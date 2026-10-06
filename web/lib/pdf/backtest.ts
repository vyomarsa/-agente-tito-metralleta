// "Prueba de Fuego" — backtest de day-trading de opciones ATM de TSLA.
//
// PURO — no toca red ni disco. La ruta (app/api/backtest) reconstruye cada día
// histórico (trades de MarketSnack + barras de Massive) y llama a estas funciones,
// incluyendo `gexAnalysis` (lib/gex.ts) SIN MODIFICAR — es el mismo motor que usa
// el dashboard en vivo, solo que alimentado con datos de un día pasado en vez de hoy.
//
// Limitación asumida y declarada: el "chain" reconstruido de un día histórico solo
// incluye los contratos que SÍ operaron ese día en MarketSnack (con su Open Interest
// de ese momento) — no la cadena completa como la da Massive hoy. Es una aproximación
// razonable (los contratos con volumen real son justo los que más pesan en el GEX),
// pero no es idéntica a lo que el agente habría visto en vivo ese día.

import type { Row } from "./types";
import { parseOcc } from "./occ";
import { aggressionOf, type Aggression } from "./flow";

// ── Reconstrucción de la cadena del día desde trades de MarketSnack ────────

export interface RawDayTrade {
  symbol: string;
  price: number;
  size: number;
  open_interest: number;
  timestamp: string;
}

/**
 * Agrupa trades de un mismo contrato (mismo símbolo OCC) en una fila de cadena:
 * el Open Interest usado es el del trade MÁS RECIENTE del día (la foto más fresca
 * disponible), el volumen es la suma de contratos operados, y el precio es el del
 * trade más reciente (proxy de "último" — igual que hace Massive con `last_trade`).
 */
export function reconstructRowsFromTrades(trades: RawDayTrade[]): Row[] {
  const bySymbol = new Map<string, { latest: RawDayTrade; volume: number }>();
  for (const t of trades) {
    const info = parseOcc(t.symbol);
    if (!info) continue;
    const entry = bySymbol.get(t.symbol);
    if (!entry) {
      bySymbol.set(t.symbol, { latest: t, volume: t.size });
    } else {
      entry.volume += t.size;
      if (Date.parse(t.timestamp) > Date.parse(entry.latest.timestamp)) entry.latest = t;
    }
  }

  const rows: Row[] = [];
  for (const [symbol, { latest, volume }] of bySymbol) {
    const info = parseOcc(symbol);
    if (!info) continue;
    const openInterest = Math.max(0, latest.open_interest);
    const price = latest.price > 0 ? latest.price : null;
    rows.push({
      optionTicker: symbol,
      contractType: info.type,
      expiration: info.expiration,
      strike: info.strike,
      openInterest,
      volume,
      price,
      priceSource: price != null ? "last_trade" : "none",
      openPremium: price != null ? openInterest * price : null,
      notionalValue: openInterest * 100 * info.strike,
    });
  }
  return rows;
}

// ── Selección del contrato ATM ──────────────────────────────────────────────

export interface ContractCandidate {
  strike: number;
  expiration: string;
  dte: number;
}

/**
 * Contrato más cercano al dinero: entre los vencimientos dentro de [minDte, maxDte]
 * y strikes a no más de `maxStrikeDistance` puntos del spot, se queda con el
 * vencimiento más próximo y, dentro de ese vencimiento, el strike más cercano al
 * spot. Sin `maxStrikeDistance` no hay tope — puede alejarse si no hay nada mejor.
 */
export function pickAtmContract(
  candidates: ContractCandidate[],
  spot: number,
  opts: { minDte: number; maxDte: number; maxStrikeDistance?: number },
): ContractCandidate | null {
  if (!(spot > 0)) return null;
  const dist = opts.maxStrikeDistance;
  const inWindow = candidates.filter(
    (c) => c.dte >= opts.minDte && c.dte <= opts.maxDte && (dist == null || Math.abs(c.strike - spot) <= dist),
  );
  if (inWindow.length === 0) return null;
  const minDte = Math.min(...inWindow.map((c) => c.dte));
  const nearest = inWindow.filter((c) => c.dte === minDte);
  return nearest.reduce((best, c) =>
    Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best,
  );
}

// ── Sizing y simulación de la operación ─────────────────────────────────────

const MULTIPLIER = 100;

/**
 * Contratos que caben en `riskPct` % del balance actual. 0 si no alcanza ni para 1.
 *
 * Con `allowMinimumOne`: si el presupuesto de riesgo no cubre ni 1 contrato pero el
 * BALANCE COMPLETO sí, compra 1 de todas formas (el riesgo real de esa operación
 * termina siendo mayor a `riskPct`, a cambio de no saltarse el día entero solo
 * porque el tamaño ideal no calzó — es lo que sube la frecuencia de operaciones).
 */
export function sizeContracts(
  balance: number,
  entryPrice: number,
  riskPct: number,
  allowMinimumOne = false,
): number {
  if (!(balance > 0) || !(entryPrice > 0) || !(riskPct > 0)) return 0;
  const budget = balance * (riskPct / 100);
  const n = Math.floor(budget / (entryPrice * MULTIPLIER));
  if (n > 0) return n;
  if (allowMinimumOne && entryPrice * MULTIPLIER <= balance) return 1;
  return 0;
}

// ── Confirmación por sentimiento de MarketSnack ─────────────────────────────

/**
 * Dirección que sugiere el sentimiento agregado de MarketSnack (`bullish`/`bearish`
 * por trade), ponderado por premium — mismo criterio que el resto del agente usa
 * para pesar "dinero real" sobre solo contar trades. `flat` si no hay mayoría clara
 * (por encima de `thresholdPct`) o no hay trades con sentimiento.
 */
export function sentimentDirection(
  trades: { premium: number; sentiment: string }[],
  thresholdPct = 55,
): Direction | "flat" {
  let bullish = 0, bearish = 0;
  for (const t of trades) {
    if (t.sentiment === "bullish") bullish += t.premium;
    else if (t.sentiment === "bearish") bearish += t.premium;
  }
  const total = bullish + bearish;
  if (total <= 0) return "flat";
  const bullPct = (bullish / total) * 100;
  if (bullPct >= thresholdPct) return "call";
  if (bullPct <= 100 - thresholdPct) return "put";
  return "flat";
}

/**
 * Cruza la señal del GEX con el sentimiento del día. Sin `requireConfirm`, el GEX
 * manda solo (comportamiento de siempre). Con `requireConfirm`: si el sentimiento
 * no tiene mayoría clara, no bloquea (no hay con qué contradecir); si SÍ la tiene
 * y contradice al GEX, la operación se marca "contradice" — se salta ese día,
 * misma regla de "ante la duda, no operar" que ya usa la bandera de noticias.
 */
export function resolveDirection(
  gexDirection: Direction | "flat",
  sentiment: Direction | "flat",
  requireConfirm: boolean,
): Direction | "flat" | "contradice" {
  if (gexDirection === "flat") return "flat";
  if (!requireConfirm || sentiment === "flat") return gexDirection;
  return sentiment === gexDirection ? gexDirection : "contradice";
}

export type ExitReason = "take_profit" | "stop_loss" | "close";

/**
 * Sale de la posición contra el rango del día del CONTRATO (no del subyacente —
 * siempre se compra el contrato, call o put, así que el P&L depende de su propio
 * precio). Sin datos intradía de verdad, se asume el orden CONSERVADOR: si el low
 * del día tocó el stop, se sale ahí (aunque el high también haya tocado el take
 * profit más tarde) — evita optimismo artificial en el backtest.
 *
 * El take profit puede ser por % (`takeProfitPct`, sobre el precio de entrada) o
 * por un monto fijo en dólares (`takeProfitUsd`, convertido a precio por acción
 * con `contracts` — necesita contratos > 0). Si viene `takeProfitUsd`, gana sobre
 * `takeProfitPct`.
 */
export function simulateExit(input: {
  entry: number;
  high: number;
  low: number;
  close: number;
  contracts: number;
  takeProfitPct: number;
  takeProfitUsd?: number | null;
  stopLossPct: number;
}): { exitPrice: number; exitReason: ExitReason } {
  const { entry, high, low, close, contracts, takeProfitPct, takeProfitUsd, stopLossPct } = input;
  const stopPrice = entry * (1 - stopLossPct / 100);
  const targetPrice =
    takeProfitUsd != null && takeProfitUsd > 0 && contracts > 0
      ? entry + takeProfitUsd / (contracts * MULTIPLIER)
      : entry * (1 + takeProfitPct / 100);
  if (low <= stopPrice) return { exitPrice: Math.max(0, stopPrice), exitReason: "stop_loss" };
  if (high >= targetPrice) return { exitPrice: targetPrice, exitReason: "take_profit" };
  return { exitPrice: close, exitReason: "close" };
}

export type Direction = "call" | "put";

// ── Salida dinámica por lectura de flujo (en vez de un stop % fijo) ────────
//
// Idea: un stop fijo se activa aunque el precio se voltee después — en vez de
// eso, se vigila el volumen de los strikes VECINOS al nuestro durante el día.
// Cuando un contrato vecino acumula volumen ≥ `volumeMultiple` × su Open
// Interest (misma señal "posiciones nuevas abriéndose" que ya usa el resto del
// agente, ver FlowFlags.exceededOI en lib/flow.ts) Y esa compra es agresiva
// (al ask, no solo cruzando el spread), es dinero real entrando de golpe — no
// ruido. Si eso pasa en la ZONA DE REVERSIÓN (puts abajo si tenemos un call;
// calls arriba si tenemos un put), se interpreta como que el mercado está
// apostando en contra de la posición, y se sale ahí. Si nunca dispara, cae al
// mismo take-profit/backstop de siempre contra el rango del día.

/** Strikes disponibles más cercanos al de entrada, de un solo lado. */
export function nearestStrikes(
  strikes: number[],
  entryStrike: number,
  side: "above" | "below",
  count: number,
): number[] {
  const filtered = side === "above"
    ? strikes.filter((s) => s > entryStrike).sort((a, b) => a - b)
    : strikes.filter((s) => s < entryStrike).sort((a, b) => b - a);
  return filtered.slice(0, count);
}

/** El strike disponible más cercano al spot. */
export function closestStrike(strikes: number[], spot: number): number {
  return strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best));
}

/**
 * Strikes candidatos de UN lado: el más cercano al spot + `count - 1` vecinos
 * hacia ese lado, en orden de más cerca a más lejos. Ej. spot=310, side="above",
 * count=5 → [310, 315, 320, 325]. Vive acá (no en dayTrade.ts) porque tanto
 * `lib/dayTrade.ts` como `lib/neighborContracts.ts` la necesitan y ninguno de
 * los dos puede depender del otro sin generar un import circular.
 */
export function candidateStrikesForSide(
  strikes: number[],
  spot: number,
  side: "above" | "below",
  count: number,
): number[] {
  if (strikes.length === 0) return [];
  const uniq = [...new Set(strikes)];
  const closest = closestStrike(uniq, spot);
  const neighbors = nearestStrikes(uniq, closest, side, Math.max(0, count - 1));
  return [closest, ...neighbors];
}

export interface NeighborZoneTrade {
  timestamp: string;
  symbol: string;
  strike: number;
  type: "call" | "put";
  size: number;
  openInterest: number;
  /** `side` crudo de MarketSnack (p. ej. "ASKSIDE") — se clasifica con aggressionOf. */
  side: string;
}

export interface FlowExitInput {
  direction: Direction;
  entryTime: string;
  entryPrice: number;
  contracts: number;
  /** Trades del día del CONTRATO propio, para saber su precio en el momento del disparo. */
  heldTrades: { timestamp: string; price: number }[];
  /** Trades del día de los strikes vecinos (continuación + reversión), cualquier orden. */
  neighborTrades: NeighborZoneTrade[];
  volumeMultiple: number;
  takeProfitPct: number;
  takeProfitUsd?: number | null;
  dayHigh: number;
  dayLow: number;
  dayClose: number;
  /** Backstop si el flujo nunca dispara nada — más ancho que un stop normal a propósito. */
  emergencyStopPct: number;
}

export type FlowExitReason = ExitReason | "flow_reversal" | "trailing_stop";

export interface FlowExitResult {
  exitPrice: number;
  exitReason: FlowExitReason;
  triggeredAt: string | null;
  triggerSymbol: string | null;
}

/** Precio del contrato propio más cercano en el tiempo a `at`. Sin trades propios, cae al cierre del día. */
export function priceNearestInTime(
  heldTrades: { timestamp: string; price: number }[],
  at: string,
  fallbackClose: number,
): number {
  if (heldTrades.length === 0) return fallbackClose;
  const atMs = Date.parse(at);
  let best = heldTrades[0];
  let bestDist = Math.abs(Date.parse(best.timestamp) - atMs);
  for (const h of heldTrades) {
    const dist = Math.abs(Date.parse(h.timestamp) - atMs);
    if (dist < bestDist) { best = h; bestDist = dist; }
  }
  return best.price;
}

export interface FlowReversalTrigger {
  timestamp: string;
  symbol: string;
}

/**
 * Solo la DETECCIÓN del disparo por reversión (sin el fallback) — se separó de
 * findFlowExit para poder combinarla con el trailing stop en runBacktestDay: la
 * reversión de flujo siempre puede cortar la posición, tenga o no trailing activo.
 */
export function detectFlowReversal(input: {
  direction: Direction;
  entryTime: string;
  neighborTrades: NeighborZoneTrade[];
  volumeMultiple: number;
}): FlowReversalTrigger | null {
  const { direction, entryTime, neighborTrades, volumeMultiple } = input;
  const reversalType: "call" | "put" = direction === "call" ? "put" : "call";
  const entryMs = Date.parse(entryTime);
  const afterEntry = neighborTrades
    .filter((t) => Date.parse(t.timestamp) >= entryMs)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const running = new Map<string, number>();
  for (const t of afterEntry) {
    const key = `${t.strike}|${t.type}`;
    const vol = (running.get(key) ?? 0) + t.size;
    running.set(key, vol);
    if (t.type !== reversalType) continue;
    if (!(t.openInterest > 0) || vol < volumeMultiple * t.openInterest) continue;
    const aggression: Aggression = aggressionOf(t.side);
    if (aggression !== "ask") continue; // solo compra agresiva real confirma la reversión
    return { timestamp: t.timestamp, symbol: t.symbol };
  }
  return null;
}

export function findFlowExit(input: FlowExitInput): FlowExitResult {
  const {
    direction, entryTime, entryPrice, contracts, heldTrades, neighborTrades,
    volumeMultiple, takeProfitPct, takeProfitUsd, dayHigh, dayLow, dayClose, emergencyStopPct,
  } = input;

  const trigger = detectFlowReversal({ direction, entryTime, neighborTrades, volumeMultiple });
  if (trigger) {
    const exitPrice = priceNearestInTime(heldTrades, trigger.timestamp, dayClose);
    return { exitPrice, exitReason: "flow_reversal", triggeredAt: trigger.timestamp, triggerSymbol: trigger.symbol };
  }

  // Nada disparó: mismo take-profit de siempre, contra un backstop ancho (no un stop normal).
  const stopPrice = entryPrice * (1 - emergencyStopPct / 100);
  const targetPrice =
    takeProfitUsd != null && takeProfitUsd > 0 && contracts > 0
      ? entryPrice + takeProfitUsd / (contracts * MULTIPLIER)
      : entryPrice * (1 + takeProfitPct / 100);
  if (dayLow <= stopPrice) return { exitPrice: Math.max(0, stopPrice), exitReason: "stop_loss", triggeredAt: null, triggerSymbol: null };
  if (dayHigh >= targetPrice) return { exitPrice: targetPrice, exitReason: "take_profit", triggeredAt: null, triggerSymbol: null };
  return { exitPrice: dayClose, exitReason: "close", triggeredAt: null, triggerSymbol: null };
}

// ── Take profit dinámico (trailing stop) ────────────────────────────────────
//
// En vez de un solo objetivo fijo: mientras la ganancia no llegue a `armPct`, la
// posición está protegida por un stop duro normal (`hardStopPct`). En cuanto la
// toca, el stop deja de estar fijo y empieza a SEGUIR el máximo alcanzado, sin
// bajar nunca, dejando siempre `trailPct` de colchón por debajo del pico — así
// se "va asegurando dinero" en vez de salir todo de una vez en un solo número.
// Necesita el precio del contrato a lo largo del día (heldTrades); sin eso, no
// hay con qué armar el trailing y se sale al cierre.

export type TrailingExitReason = "stop_loss" | "trailing_stop" | "close";

export interface TrailingStopInput {
  entry: number;
  /** Trades propios del día — SOLO se usan para afinar el instante del disparo (armedAt). */
  heldTrades: { timestamp: string; price: number }[];
  /**
   * Rango real del día (de Massive, siempre disponible) — es la RED DE SEGURIDAD.
   * MarketSnack puede no tener trades del contrato exacto ese día (0 cobertura),
   * y sin esto la posición quedaría sin protección real: "nunca armó" según los
   * trades sueltos aunque el precio sí haya subido y bajado fuerte según el rango
   * oficial del día. Por eso el rango manda sobre lo que digan (o no digan) los
   * trades propios.
   */
  dayHigh: number;
  dayLow: number;
  close: number;
  armPct: number;
  trailPct: number;
  hardStopPct: number;
}

export interface TrailingStopResult {
  exitPrice: number;
  exitReason: TrailingExitReason;
  /** Cuándo se vio el primer trade propio que cruzó armPct — null si no hay ese dato (pero pudo haber armado igual, ver dayHigh). */
  armedAt: string | null;
}

export function simulateTrailingExit(input: TrailingStopInput): TrailingStopResult {
  const { entry, heldTrades, dayHigh, dayLow, close, armPct, trailPct, hardStopPct } = input;
  const hardStopPrice = entry * (1 - hardStopPct / 100);
  const armThreshold = entry * (1 + armPct / 100);

  // El rango oficial del día nunca llegó a armar el trailing: el stop duro sigue
  // vigente todo el día (orden conservador, igual que simulateExit: si el low tocó
  // el stop, se asume que pasó antes de cualquier repunte posterior).
  if (dayHigh < armThreshold) {
    if (dayLow <= hardStopPrice) return { exitPrice: Math.max(0, hardStopPrice), exitReason: "stop_loss", armedAt: null };
    return { exitPrice: close, exitReason: "close", armedAt: null };
  }

  // Se sabe que SÍ armó en algún momento (dayHigh lo confirma), tengamos o no
  // trades propios que lo capturen. El pico es el mayor precio conocido —
  // dayHigh o, si algún trade propio marcó más alto, ese.
  const sorted = [...heldTrades].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const armedAt = sorted.find((t) => t.price >= armThreshold)?.timestamp ?? null;
  const peak = Math.max(dayHigh, ...sorted.map((t) => t.price));
  const trailStop = peak * (1 - trailPct / 100);

  if (dayLow <= trailStop) return { exitPrice: Math.max(0, trailStop), exitReason: "trailing_stop", armedAt };
  return { exitPrice: close, exitReason: "close", armedAt };
}

// ── Un día del backtest ──────────────────────────────────────────────────────

export interface DayBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BacktestTrade {
  date: string;
  direction: Direction;
  strike: number;
  expiration: string;
  dte: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: FlowExitReason;
  /** Si salió por flow_reversal: cuándo y en qué strike vecino se detectó. */
  triggeredAt: string | null;
  triggerSymbol: string | null;
  contracts: number;
  cost: number;
  pnl: number;
  pnlPct: number;
  balanceAfter: number;
}

export type SkipReason =
  | "sin_senal" | "sin_contrato" | "sin_datos_del_contrato" | "balance_insuficiente" | "sentimiento_contradice";

export interface BacktestSkip {
  date: string;
  reason: SkipReason;
  /** CALL/PUT que la señal había decidido antes de fallar — null si la señal misma faltó. */
  direction: Direction | null;
}

/** Configuración de la salida dinámica por flujo — opcional, ver findFlowExit. */
export interface FlowExitConfig {
  entryTime: string;
  heldTrades: { timestamp: string; price: number }[];
  neighborTrades: NeighborZoneTrade[];
  volumeMultiple: number;
  emergencyStopPct: number;
}

/** Configuración del trailing stop — opcional, ver simulateTrailingExit. */
export interface TrailingStopConfig {
  heldTrades: { timestamp: string; price: number }[];
  armPct: number;
  trailPct: number;
  hardStopPct: number;
}

export interface RunDayInput {
  date: string;
  direction: Direction | "flat" | null;
  spot: number;
  candidates: ContractCandidate[];
  /** Barra del contrato elegido — la resuelve el llamador tras pickAtmContract. null si no se pudo obtener. */
  contractBar: DayBar | null;
  contract: ContractCandidate | null;
  balance: number;
  riskPct: number;
  /** Si no alcanza para el tamaño ideal pero SÍ para 1 contrato completo, lo compra igual. */
  allowMinimumOne?: boolean;
  takeProfitPct: number;
  /** Take profit fijo en dólares — si viene, gana sobre takeProfitPct. */
  takeProfitUsd?: number | null;
  stopLossPct: number;
  /** Si viene, la reversión de flujo en los strikes vecinos puede cortar la posición en cualquier momento. */
  flowExit?: FlowExitConfig | null;
  /**
   * Si viene, reemplaza el take-profit/stop fijo por un trailing stop (ver
   * simulateTrailingExit). Se puede combinar con `flowExit`: la reversión de
   * flujo gana si dispara primero; si no, manda el trailing.
   */
  trailingStop?: TrailingStopConfig | null;
}

export function runBacktestDay(input: RunDayInput): BacktestTrade | BacktestSkip {
  const {
    date, direction, contract, contractBar, balance, riskPct, allowMinimumOne,
    takeProfitPct, takeProfitUsd, stopLossPct, flowExit, trailingStop,
  } = input;

  if (direction == null || direction === "flat") return { date, reason: "sin_senal", direction: null };
  if (!contract) return { date, reason: "sin_contrato", direction };
  if (!contractBar || !(contractBar.open > 0)) return { date, reason: "sin_datos_del_contrato", direction };

  const contracts = sizeContracts(balance, contractBar.open, riskPct, allowMinimumOne);
  if (contracts <= 0) return { date, reason: "balance_insuficiente", direction };

  let exitPrice: number;
  let exitReason: FlowExitReason;
  let triggeredAt: string | null = null;
  let triggerSymbol: string | null = null;

  const reversal = flowExit
    ? detectFlowReversal({
        direction, entryTime: flowExit.entryTime,
        neighborTrades: flowExit.neighborTrades, volumeMultiple: flowExit.volumeMultiple,
      })
    : null;

  if (reversal) {
    exitPrice = priceNearestInTime(flowExit!.heldTrades, reversal.timestamp, contractBar.close);
    exitReason = "flow_reversal";
    triggeredAt = reversal.timestamp;
    triggerSymbol = reversal.symbol;
  } else if (trailingStop) {
    const r = simulateTrailingExit({
      entry: contractBar.open, heldTrades: trailingStop.heldTrades,
      dayHigh: contractBar.high, dayLow: contractBar.low, close: contractBar.close,
      armPct: trailingStop.armPct, trailPct: trailingStop.trailPct, hardStopPct: trailingStop.hardStopPct,
    });
    exitPrice = r.exitPrice;
    exitReason = r.exitReason;
    triggeredAt = r.armedAt;
  } else if (flowExit) {
    const r = findFlowExit({
      direction, entryTime: flowExit.entryTime, entryPrice: contractBar.open, contracts,
      heldTrades: flowExit.heldTrades, neighborTrades: flowExit.neighborTrades,
      volumeMultiple: flowExit.volumeMultiple, takeProfitPct, takeProfitUsd,
      dayHigh: contractBar.high, dayLow: contractBar.low, dayClose: contractBar.close,
      emergencyStopPct: flowExit.emergencyStopPct,
    });
    exitPrice = r.exitPrice;
    exitReason = r.exitReason;
    triggeredAt = r.triggeredAt;
    triggerSymbol = r.triggerSymbol;
  } else {
    const r = simulateExit({
      entry: contractBar.open, high: contractBar.high, low: contractBar.low, close: contractBar.close,
      contracts, takeProfitPct, takeProfitUsd, stopLossPct,
    });
    exitPrice = r.exitPrice;
    exitReason = r.exitReason;
  }

  const cost = contractBar.open * MULTIPLIER * contracts;
  const pnl = (exitPrice - contractBar.open) * MULTIPLIER * contracts;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;

  return {
    date, direction, strike: contract.strike, expiration: contract.expiration, dte: contract.dte,
    entryPrice: contractBar.open, exitPrice, exitReason, triggeredAt, triggerSymbol,
    contracts, cost, pnl, pnlPct, balanceAfter: balance + pnl,
  };
}

export function isTrade(x: BacktestTrade | BacktestSkip): x is BacktestTrade {
  return "contracts" in x;
}

// ── Resumen ──────────────────────────────────────────────────────────────────

export interface BacktestSummary {
  startingBalance: number;
  endingBalance: number;
  totalReturnPct: number;
  tradesCount: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  bestTrade: BacktestTrade | null;
  worstTrade: BacktestTrade | null;
  maxDrawdownPct: number;
}

export function summarizeBacktest(trades: BacktestTrade[], startingBalance: number): BacktestSummary {
  const endingBalance = trades.length > 0 ? trades[trades.length - 1].balanceAfter : startingBalance;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  let peak = startingBalance;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    if (t.balanceAfter > peak) peak = t.balanceAfter;
    const dd = peak > 0 ? ((peak - t.balanceAfter) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const best = trades.reduce<BacktestTrade | null>(
    (b, t) => (b == null || t.pnl > b.pnl ? t : b), null);
  const worst = trades.reduce<BacktestTrade | null>(
    (w, t) => (w == null || t.pnl < w.pnl ? t : w), null);

  return {
    startingBalance,
    endingBalance,
    totalReturnPct: startingBalance > 0 ? ((endingBalance - startingBalance) / startingBalance) * 100 : 0,
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    avgWinPct: wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0,
    avgLossPct: losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0,
    bestTrade: best,
    worstTrade: worst,
    maxDrawdownPct,
  };
}
