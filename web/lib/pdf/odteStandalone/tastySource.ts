// ============================================================================
// Fuente Tastytrade del Agente 0DTE — sustituye a Schwab (oct 2026, pedido del
// dueño: "usar solo Tasty"). Tres piezas, mismas formas que devolvía Schwab para
// no tocar el motor:
//   · cadena de UN vencimiento con bid/ask, griegos, OI y volumen REALES
//     (lib/tastytrade de Tito: REST nested + snapshot DXLink, cache incluido)
//   · precio del futuro activo (/ES, /NQ) para el basis
//   · velas intradía del subyacente (DXLink Candle, solo horario regular)
// Ventaja frente a Schwab: tiempo real (Schwab llegaba con 15 min de retraso) y
// el refresh token de Tastytrade no caduca cada 7 días. Solo servidor.
// ============================================================================

import { fetchQuoteToken, fetchTastytradeChain, TastytradeError } from "@/lib/tastytrade";
import { fetchActiveFuture, fetchFuturesQuote } from "@/lib/pdf/tastytrade";
import type { RawContract } from "./types";

export { TastytradeError };

/** "$SPX" (formato Schwab) → "SPX". Acepta ambos. */
function bare(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/^\$/, "");
}

const pos = (n: number | null | undefined) => (n != null && Number.isFinite(n) && n > 0 ? n : undefined);

export interface TastyChainResult {
  contracts: RawContract[];
  underlyingPrice: number | null;
}

/**
 * Cadena de UN vencimiento (`day`, YYYY-MM-DD) en el formato RawContract que
 * consume `toRow`. En SPX, lib/tastytrade ya se queda con la raíz SPXW (PM) el
 * día de OpEx mensual, igual que hacía `parseSchwabChain`.
 */
export async function fetchChainTasty(analysis: string, day: string): Promise<TastyChainResult> {
  const ticker = bare(analysis);
  const { spot, contracts } = await fetchTastytradeChain(ticker, { dates: [day] });
  const raw: RawContract[] = contracts.map((c) => ({
    details: {
      contract_type: c.type,
      expiration_date: c.expiration,
      strike_price: c.strike,
      shares_per_contract: 100,
      ticker: c.symbol ? `O:${c.symbol}` : undefined,
    },
    day: { volume: c.volume },
    last_trade: { price: pos(c.last) },
    open_interest: c.openInterest,
    underlying_asset: { price: spot ?? undefined, ticker },
    quote: { bid: pos(c.bid), ask: pos(c.ask) },
    greeks: {
      delta: c.delta,
      gamma: c.gamma,
      theta: c.theta ?? null,
      vega: c.vega ?? null,
      rho: null,
      iv: c.iv,
    },
  }));
  return { contracts: raw, underlyingPrice: spot };
}

/** Precio del contrato de futuro ACTIVO ("/ES" → "/ESZ6"). null si no hay quote. */
export async function fetchFuturePriceTasty(future: string): Promise<number | null> {
  const product = future.trim().toUpperCase().replace(/^\//, "");
  if (!product) return null;
  const active = await fetchActiveFuture(product);
  if (!active) return null;
  return fetchFuturesQuote(active.symbol);
}

/** Barra intradía OHLC. `time` en segundos unix (mismo shape que el de Schwab). */
export interface IntradayBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const etDay = (sec: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(sec * 1000);

/** Símbolo del streamer: índices/acciones tal cual; futuros ("/ES") → contrato activo ("/ESZ26:XCME"). */
async function streamerSymbol(symbol: string): Promise<string> {
  const s = bare(symbol);
  if (!s.startsWith("/")) return s;
  const active = (await fetchActiveFuture(s.slice(1))) as { "streamer-symbol"?: string } | null;
  const sym = active?.["streamer-symbol"];
  if (!sym) throw new TastytradeError(`Tastytrade no devolvió el contrato activo de ${s}.`);
  return sym;
}

async function candles(symbol: string, minutes: number, days: number): Promise<IntradayBar[]> {
  const [tok, sym] = await Promise.all([fetchQuoteToken(), streamerSymbol(symbol)]);
  const { dxlinkCandles } = await import("@/lib/tastytradeStream");
  // tho=true: solo horario regular, como `needExtendedHoursData=false` de Schwab
  // (en futuros, el horario regular del índice; el simulador solo mira la sesión).
  const velas = await dxlinkCandles({
    url: tok.url,
    token: tok.token,
    symbol: `${sym}{=${minutes}m,tho=true}`,
    fromTime: Date.now() - days * 24 * 60 * 60 * 1000,
  });
  return velas
    .filter((v) => Number.isFinite(v.open) && v.open > 0)
    .map((v) => ({ time: Math.floor(v.time / 1000), open: v.open, high: v.high, low: v.low, close: v.close }))
    .sort((a, b) => a.time - b.time);
}

/** Velas de la sesión (fecha ET) más reciente — para el chart y el simulador. */
export async function fetchIntradayBarsTasty(symbol: string, minutes = 5): Promise<IntradayBar[]> {
  const all = await candles(symbol, minutes, 4); // 4 días cubre fines de semana largos
  if (all.length === 0) return [];
  const lastDay = etDay(all[all.length - 1].time);
  return all.filter((b) => etDay(b.time) === lastDay);
}

/** Velas de VARIAS sesiones — para revisar los pronósticos de días pasados. */
export async function fetchIntradayBarsRangeTasty(symbol: string, days = 10, minutes = 5): Promise<IntradayBar[]> {
  return candles(symbol, minutes, days);
}
