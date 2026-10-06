// ============================================================================
// Ensamblaje del análisis 0DTE — la copia ÚNICA.
//
// Vive fuera de la ruta a propósito. Lo consumen DOS clientes:
//   · `app/api/0dte` — lo que ve la pantalla (le añade flujo, cinta y marcador).
//   · `app/api/0dte-paper` (POST) — el disparador de la cuenta de paper, que
//     corre por tarea programada SIN que la página esté abierta.
//
// Si cada uno montara su propio análisis, el simulador acabaría midiendo un
// ticket distinto del que el usuario vio, y el win rate no diría nada sobre lo
// que el agente enseña. Es el mismo motivo por el que `lib/spreadScan.ts` se
// sacó de la ruta de /spreads cuando llegó el paper de venta de prima.
//
// Lo que NO hace: el Time & Sales. El flujo son 6 páginas por llamada y solo lo
// necesitan la cinta y el sesgo alterno, que son cosas de pantalla. El cron corre
// cada minuto durante toda la sesión, así que pedirlo ahí multiplicaría la carga
// contra MarketSnack sin cambiar una sola decisión de la cuenta.
//
// FUENTES (2026-09-17): vencimientos y cadena por la cascada Tastytrade →
// MarketSnack de `lib/frontChain`. Antes eran SOLO MarketSnack, y sin su cookie
// el 0DTE y su cuenta de paper se caían aunque Tastytrade estuviera sirviendo.
// ============================================================================

import { fetchCompany } from "./massive";
import { cachedDailyBars } from "./barsStore";
import { fetchTastytradeSpot } from "./tastytrade";
import { FrontChainError, fetchChainsByDate, listExpirations, type FrontSource } from "./frontChain";
import { dteOf, type Chain2Contract } from "./optionChain2";
import { buildZeroDte, estimateSpotFromChain, type ZeroDteAnalysis } from "./zerodte";
import { closeForecast, type ZeroDteClose } from "./zerodteClose";
import {
  gexTicket, magnetTrade, momentumTrade, pinning,
  type ZeroDtePinning, type ZeroDteTicket, type ZeroDteTrade, type ZeroDteTradeCard,
} from "./zerodteSignals";
import { zeroDteSpreads, type ZeroDteSpreads } from "./zerodteSpreads";

export const TRADING_MINUTES = 390; // 9:30–16:00 ET
export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;
/** Cuántos vencimientos futuros ofrecer en el selector. */
export const MAX_EXPIRATIONS = 8;
/** Índices/ETFs 0DTE soportados. SPX se marca experimental (validación). */
export const ALLOWED = new Set(["SPY", "QQQ", "SPX", "IWM"]);

/** Minutos desde medianoche en ET para `now` (null si no se puede). */
export function etMinutes(now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}

/**
 * Fracción de la sesión de HOY que resta (en "días" para el cono) y minutos
 * restantes. 1 = jornada completa por delante. Para vencimientos futuros se le
 * suma el nº de días hasta ese vencimiento (ver `horizonDays`).
 */
export function sessionFractionToday(now: Date): { fractionToday: number; minutesLeft: number } {
  const min = etMinutes(now);
  if (min == null) return { fractionToday: 1, minutesLeft: TRADING_MINUTES };
  if (min <= OPEN_MIN) return { fractionToday: 1, minutesLeft: TRADING_MINUTES };
  if (min >= CLOSE_MIN) return { fractionToday: 0, minutesLeft: 0 };
  const left = CLOSE_MIN - min;
  return { fractionToday: left / TRADING_MINUTES, minutesLeft: left };
}

export interface ZeroDteScan {
  ticker: string;
  expiration: string;
  isToday: boolean;
  selectedDte: number;
  available: { date: string; dte: number }[];
  contracts: Chain2Contract[];
  spot: number;
  spotSource: "tastytrade" | "quote" | "paridad";
  /** De dónde salió la cadena. */
  chainSource: FrontSource;
  change: number | null;
  changePercent: number | null;
  minutesLeft: number;
  sessionOpen: boolean;
  etMinute: number | null;
  analysis: ZeroDteAnalysis;
  trade: ZeroDteTradeCard;
  tradeAlt: ZeroDteTradeCard;
  /** El modelo que SÍ tiene idea viva; el régimen decide cuál. */
  activeTrade: ZeroDteTrade | null;
  ticket: ZeroDteTicket | null;
  ticketNote: string;
  /** La misma tesis con riesgo definido: vertical de débito, credit spreads e iron condor. */
  spreads: ZeroDteSpreads;
  pinning: ZeroDtePinning;
  /** Cierre de la última hora: Max Pain + charm. null si no es el vencimiento de hoy. */
  close: ZeroDteClose | null;
  /** Mid por símbolo de contrato, para re-cotizar posiciones abiertas. */
  priceOf: (optionSymbol: string) => number | null;
}

export class ZeroDteScanError extends Error {}

/**
 * Trae la cadena y monta el análisis + las señales. Lanza `ZeroDteScanError` con
 * un mensaje ya legible cuando no hay datos suficientes.
 */
export async function scanZeroDte(
  ticker: string,
  requestedExp: string,
  now: Date,
): Promise<ZeroDteScan> {
  let dates: string[];
  try {
    dates = (await listExpirations(ticker)).dates;
  } catch (e) {
    throw e instanceof FrontChainError ? new ZeroDteScanError(e.message) : e;
  }
  if (dates.length === 0) {
    throw new ZeroDteScanError(
      `No hay vencimientos para ${ticker}. ${ticker === "SPX" ? "SPX es experimental: prueba SPY o QQQ." : ""}`.trim(),
    );
  }

  const futureDates = dates.filter((d) => dteOf(d, now) >= 0);
  const available = futureDates.slice(0, MAX_EXPIRATIONS).map((d) => ({ date: d, dte: dteOf(d, now) }));

  const todayExp = dates.find((d) => dteOf(d, now) === 0);
  const nearest = futureDates[0] ?? dates[dates.length - 1];
  const validRequested = requestedExp && available.some((a) => a.date === requestedExp) ? requestedExp : null;
  const expiration = validRequested ?? todayExp ?? nearest;
  const isToday = expiration === todayExp;
  const selectedDte = dteOf(expiration, now);

  const [chain, company, bars] = await Promise.all([
    // Con Tastytrade la cadena trae el spot EN VIVO por la misma conexión (y sirve
    // también SPX, que Massive no cotiza). Si la cadena sale de MarketSnack, el spot
    // se pide aparte al streamer, que puede estar sano aunque su cadena no llegara.
    fetchChainsByDate(ticker, [expiration])
      .then(async (r) => ({ ...r, spot: r.spot ?? (await fetchTastytradeSpot(ticker).catch(() => null)) }))
      .catch((e) => {
        throw e instanceof FrontChainError ? new ZeroDteScanError(e.message) : e;
      }),
    fetchCompany(ticker).catch(() => null),
    // Por el CACHE de disco, NO por Massive directo. `fetchDailyBars` con
    // `.catch(() => [])` devolvía [] en silencio cuando se agotaba la cuota (5
    // peticiones/minuto del plan gratis), y entonces `coneIv` caía al
    // FALLBACK_IV de 0,4 — un 40% fijo que NO es la volatilidad de nadie.
    // Verificado el 2026-08-26: QQQ proyectaba exactamente 40,0% por esto.
    cachedDailyBars(ticker, 60, now).catch(() => [] as { close: number }[]),
  ]);

  const contracts = chain.byDate.get(expiration) ?? [];
  const ttSpot = chain.spot;
  // Cascada de spot: Tastytrade (vivo) → Massive → paridad put-call sobre la propia
  // cadena. La paridad es una DERIVACIÓN, no un precio: con el plan gratis de Massive
  // era lo único que quedaba y el 0DTE llevaba días operando así.
  const spot = ttSpot ?? company?.price ?? estimateSpotFromChain(contracts);
  if (!spot || spot <= 0) throw new ZeroDteScanError(`No se pudo obtener el precio (spot) de ${ticker}.`);
  if (contracts.length === 0) throw new ZeroDteScanError(`Cadena 0DTE vacía para ${ticker} (${expiration}).`);

  const { fractionToday, minutesLeft } = sessionFractionToday(now);
  const horizonDays = Math.max(fractionToday + selectedDte, 1 / TRADING_MINUTES);
  const analysis = buildZeroDte({ contracts, spot, closes: bars.map((b) => b.close), now, horizonDays });

  const etMinute = etMinutes(now);
  const sessionOpen = etMinute != null && etMinute >= OPEN_MIN && etMinute < CLOSE_MIN && isToday;

  const trade = magnetTrade(analysis);
  const tradeAlt = momentumTrade(analysis);
  const activeTrade = trade.trade ?? tradeAlt.trade;
  const ticket = gexTicket(analysis, activeTrade);

  const midBySymbol = new Map<string, number | null>();
  for (const c of contracts) {
    midBySymbol.set(c.symbol, c.mid ?? c.lastPrice ?? c.bid ?? c.ask ?? null);
  }

  return {
    ticker, expiration, isToday, selectedDte, available, contracts,
    spot,
    spotSource: ttSpot != null ? "tastytrade" : company?.price != null ? "quote" : "paridad",
    chainSource: chain.source,
    change: company?.change ?? null,
    changePercent: company?.changePercent ?? null,
    minutesLeft, sessionOpen, etMinute,
    analysis,
    trade, tradeAlt, activeTrade,
    ticket: ticket.ticket,
    ticketNote: ticket.note,
    spreads: zeroDteSpreads(analysis, activeTrade),
    pinning: pinning(analysis, etMinute, minutesLeft),
    close: closeForecast({ a: analysis, minutesLeft, isToday }),
    priceOf: (sym) => midBySymbol.get(sym) ?? null,
  };
}
