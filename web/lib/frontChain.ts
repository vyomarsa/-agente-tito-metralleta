// ============================================================================
// Cadenas por VENCIMIENTO EXACTO para el 0DTE y el Scalping de Rango.
//
// Orden de fuentes: Tastytrade → MarketSnack. Solo servidor.
//
// Hasta el 2026-09-17 los dos escaneos pedían vencimientos y cadena SOLO a
// MarketSnack, así que sin su cookie se caían enteros aunque Tastytrade estuviera
// sirviendo. Aquí se les da la misma cascada que ya tenía Venta de Prima, en el
// formato `Chain2Contract` que ya consumen `buildZeroDte`, `niveles` y `regimen`:
// el motor no cambia, cambia de dónde sale el dato.
//
// Tastytrade además trae la gamma de TODA la cadena (MarketSnack, ~77% en el 0DTE,
// ver la auditoría de cobertura del 2026-08-24) y el spot por la misma conexión.
// ============================================================================

import {
  fetchTastytradeChain, fetchTastytradeExpirations, tastytradeConfigured,
  type QuoteToken, type TtContract,
} from "./tastytrade";
import { fetchExpirations, fetchOptionChain2 } from "./marketsnack";
import { normalizeChain2, type Chain2Contract } from "./optionChain2";
import { occSymbol } from "./chainSources";

export type FrontSource = "tastytrade" | "marketsnack";

/** Las dos fuentes fallaron. El mensaje lleva el motivo de cada una. */
export class FrontChainError extends Error {}

function msg(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

/**
 * TtContract → Chain2Contract.
 *
 * `premiumTraded` NO existe en Tastytrade: MarketSnack lo suma trade a trade. Se
 * aproxima con volumen × mid × 100, que es la prima negociada si todo se hubiera
 * cruzado al mid. Solo lo usa el `callPct` del 0DTE (qué parte del dinero de hoy
 * va a calls), donde importa la PROPORCIÓN entre calls y puts y no el importe;
 * queda declarado porque no es el mismo número que daba MarketSnack.
 */
export function ttToChain2(c: TtContract, ticker: string): Chain2Contract {
  const mid = c.bid != null && c.ask != null && c.bid >= 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : null;
  const last = c.last != null && c.last > 0 ? c.last : null;
  return {
    symbol: c.symbol || occSymbol(ticker, c.expiration, c.type, c.strike),
    type: c.type,
    strike: c.strike,
    expiration: c.expiration,
    bid: c.bid,
    ask: c.ask,
    mid,
    delta: c.delta,
    gamma: c.gamma,
    theta: c.theta ?? null,
    vega: c.vega ?? null,
    iv: c.iv,
    openInterest: c.openInterest,
    volume: c.volume,
    premiumTraded: c.volume * (mid ?? last ?? 0) * 100,
    lastPrice: last,
  };
}

/** Fechas de vencimiento listadas (YYYY-MM-DD, ordenadas). */
export async function listExpirations(ticker: string): Promise<{ dates: string[]; source: FrontSource }> {
  let ttFallo = "no configurado";
  if (tastytradeConfigured()) {
    try {
      const exps = await fetchTastytradeExpirations(ticker);
      if (exps.length > 0) {
        return { dates: exps.map((e) => e.date).sort((a, b) => a.localeCompare(b)), source: "tastytrade" };
      }
      ttFallo = "sin vencimientos";
    } catch (e) {
      ttFallo = msg(e);
    }
  }
  try {
    const ms = await fetchExpirations(ticker);
    return { dates: ms.map((e) => e.date).sort((a, b) => a.localeCompare(b)), source: "marketsnack" };
  } catch (e) {
    throw new FrontChainError(`Sin vencimientos de ${ticker}. Tastytrade: ${ttFallo}. MarketSnack: ${msg(e)}`);
  }
}

export interface ChainsByDate {
  /** Contratos por vencimiento. Puede faltar alguno salvo el primero pedido. */
  byDate: Map<string, Chain2Contract[]>;
  /** Spot del subyacente si la fuente lo dio (Tastytrade sí; MarketSnack no). */
  spot: number | null;
  source: FrontSource;
}

/**
 * Cadenas de varios vencimientos en UNA conexión de Tastytrade; si no, una llamada
 * por fecha a MarketSnack.
 *
 * El PRIMER vencimiento de `dates` es el que manda (el 0DTE elegido, el frente del
 * scalping): si Tastytrade no lo trae con contratos, se cae entero a MarketSnack en
 * vez de mezclar fuentes dentro de un mismo análisis. Los demás son best-effort.
 */
export async function fetchChainsByDate(
  ticker: string,
  dates: string[],
  opts: { quoteToken?: QuoteToken; timeoutMs?: number } = {},
): Promise<ChainsByDate> {
  const frente = dates[0];
  if (!frente) throw new FrontChainError(`No se pidió ningún vencimiento de ${ticker}.`);

  let ttFallo = "no configurado";
  if (tastytradeConfigured()) {
    try {
      const { contracts, spot } = await fetchTastytradeChain(ticker, {
        dates, quoteToken: opts.quoteToken, timeoutMs: opts.timeoutMs,
      });
      const byDate = new Map<string, Chain2Contract[]>();
      for (const c of contracts) {
        const lista = byDate.get(c.expiration) ?? [];
        lista.push(ttToChain2(c, ticker));
        byDate.set(c.expiration, lista);
      }
      if ((byDate.get(frente)?.length ?? 0) > 0) return { byDate, spot, source: "tastytrade" };
      ttFallo = `sin contratos para ${frente}`;
    } catch (e) {
      ttFallo = msg(e);
    }
  }

  const byDate = new Map<string, Chain2Contract[]>();
  for (const d of dates) {
    try {
      byDate.set(d, normalizeChain2(await fetchOptionChain2(ticker, d)));
    } catch (e) {
      if (d === frente) {
        throw new FrontChainError(
          `Sin cadena de ${ticker} (${frente}). Tastytrade: ${ttFallo}. MarketSnack: ${msg(e)}`,
        );
      }
      // vencimiento secundario no disponible — se sigue con los demás
    }
  }
  return { byDate, spot: null, source: "marketsnack" };
}
