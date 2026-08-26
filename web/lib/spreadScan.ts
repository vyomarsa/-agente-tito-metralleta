// Escaneo de UN símbolo para venta de prima. Solo servidor.
//
// Existe para que haya UNA sola forma de armar la entrada de `creditSpreadCandidates`.
// Antes este ensamblaje —cadena 4–7 DTE + spot + barras + niveles + earnings— vivía
// dentro de `app/api/spreads/route.ts`, así que el paper trading tendría que haberlo
// copiado. Dos copias del mismo montaje es exactamente el problema que este traslado
// viene a cerrar: acabarían divergiendo igual que divergieron Tito y el bot Python.
//
// La ruta SSE de /spreads sigue siendo la dueña de la PRESENTACIÓN (sus `send()` de
// progreso); esto solo produce el resultado.

import { cachedDailyBars } from "./barsStore";
import { fetchExpirations, fetchOptionChain2 } from "./marketsnack";
import { fetchTastytradeChain, type QuoteToken, type TtContract } from "./tastytrade";
import { dteOf, expirationsInDteWindow, normalizeChain2, type Chain2Contract } from "./optionChain2";
import { creditSpreadCandidates, DTE_MIN, DTE_MAX, type SpreadQuote, type SpreadScan, type Bias } from "./creditSpread";
import { earningsForTicker } from "./earnings";
import { findLevels } from "./levels";
import type { MacroEvent } from "./macroCalendar";
import { cachedMarketCap } from "./marketCapStore";
import { fetchCompany } from "./massive";
import type { SpreadSymbol } from "./spreadUniverse";
import { avg20dVolume } from "./volume";

/**
 * Cotizaciones de la banda + el spot, si la fuente lo trae en la misma llamada.
 *
 * Tastytrade devuelve el subyacente por el MISMO WebSocket que la cadena, así que
 * el spot sale gratis; MarketSnack no sirve precio de subyacente y manda `null`.
 */
export interface QuotesResult {
  quotes: SpreadQuote[];
  spot: number | null;
}

export interface ScanContext {
  now: Date;
  macroEvents: MacroEvent[];
  bias: Bias;
  expert: boolean;
  /** Cómo se traen las cotizaciones de la banda 4–7 DTE (Tastytrade o MarketSnack). */
  fetchQuotes: (ticker: string, now: Date) => Promise<QuotesResult>;
}

export type ScanOutcome =
  | { ok: true; scan: SpreadScan }
  | { ok: false; reason: string };

/** Escanea un símbolo. Nunca lanza: los fallos vuelven como `ok:false` con motivo. */
export async function scanSymbol(sym: SpreadSymbol, ctx: ScanContext): Promise<ScanOutcome> {
  const { now, macroEvents, bias, expert, fetchQuotes } = ctx;
  try {
    const { quotes, spot: quotedSpot } = await fetchQuotes(sym.ticker, now);
    if (quotes.length === 0) return { ok: false, reason: `sin cadena ${DTE_MIN}–${DTE_MAX} DTE` };

    // El spot viene de Tastytrade, en la MISMA llamada que la cadena. Massive solo
    // se consulta si la fuente no lo dio: son 2 peticiones por símbolo y con el
    // plan gratis (5/minuto) los 103 del universo no caben ni en media hora — eso
    // es lo que dejaba el escaneo entero en "sin precio".
    let spot = quotedSpot != null && quotedSpot > 0 ? quotedSpot : null;
    if (spot == null) {
      const company = await fetchCompany(sym.ticker).catch(() => null);
      spot = company?.price ?? null;
    }
    if (spot == null || !(spot > 0)) return { ok: false, reason: "sin precio" };

    // La cap solo sirve para el umbral grueso de $10B, así que se cachea en disco
    // con TTL largo en vez de pedirla a Massive en cada pase.
    const [marketCap, bars] = await Promise.all([
      cachedMarketCap(sym.ticker, now.getTime()),
      cachedDailyBars(sym.ticker, 365, now),
    ]);
    const closes = bars.map((b) => b.close);

    // El strike corto debe quedar del lado protegido de un nivel importante.
    const levels = findLevels({ bars, spot, now });

    // Earnings sobre el vencimiento más cercano de la ventana.
    const nearExp = quotes.reduce((a, b) => (b.dte < a.dte ? b : a)).expiration;
    const earnings = await earningsForTicker({
      ticker: sym.ticker, expiration: nearExp, frontSkew: null, now,
    });

    return {
      ok: true,
      scan: creditSpreadCandidates({
        ticker: sym.ticker,
        sector: sym.sector,
        bias,
        spot,
        isEtf: sym.isEtf ?? false,
        marketCap,
        avgVolume20d: avg20dVolume(bars),
        quotes,
        closes,
        supports: levels.supports.map((l) => ({ price: l.price, strength: l.strength })),
        resistances: levels.resistances.map((l) => ({ price: l.price, strength: l.strength })),
        earnings,
        macroEvents,
        expert,
      }),
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "fallo inesperado" };
  }
}


/**
 * Chain2Contract (MarketSnack) → SpreadQuote. MarketSnack ya entrega el delta
 * FIRMADO (call +, put −) y la IV en DECIMAL: solo se calcula el DTE.
 */
export function toSpreadQuote(c: Chain2Contract, now: Date): SpreadQuote {
  return {
    strike: c.strike,
    type: c.type,
    expiration: c.expiration,
    dte: dteOf(c.expiration, now),
    bid: c.bid,
    ask: c.ask,
    delta: c.delta,
    iv: c.iv,
    openInterest: c.openInterest,
    volume: c.volume,
  };
}

/**
 * Cadenas de la banda 4–7 DTE desde MarketSnack: una llamada de vencimientos + una
 * de cadena por fecha. El motor elige luego el weekly del frente.
 */
export async function fetchWindowQuotes(ticker: string, now: Date): Promise<QuotesResult> {
  const expirations = await fetchExpirations(ticker);
  const dates = expirationsInDteWindow(expirations.map((e) => e.date), DTE_MIN, DTE_MAX, now);
  const quotes: SpreadQuote[] = [];
  for (const date of dates) {
    const contracts = normalizeChain2(await fetchOptionChain2(ticker, date));
    for (const c of contracts) quotes.push(toSpreadQuote(c, now));
  }
  // MarketSnack no sirve precio de subyacente: el spot lo resuelve quien llame.
  return { quotes, spot: null };
}

/**
 * TtContract (streamer DXLink de Tastytrade) → SpreadQuote. Tastytrade entrega el
 * delta ya FIRMADO (puts negativo) y la IV en DECIMAL; el DTE se recalcula desde el
 * vencimiento para casar con la banda del motor.
 */
export function toSpreadQuoteFromTt(c: TtContract, now: Date): SpreadQuote {
  return {
    strike: c.strike,
    type: c.type,
    expiration: c.expiration,
    dte: dteOf(c.expiration, now),
    bid: c.bid,
    ask: c.ask,
    delta: c.delta,
    iv: c.iv,
    openInterest: c.openInterest,
    volume: c.volume,
  };
}

/**
 * Cadena de la banda 4–7 DTE desde Tastytrade (streamer). Una conexión por ticker
 * con greeks/IV/OI/bid-ask/volumen reales; se pide con ±1 día de holgura y el motor
 * recorta a la banda exacta. `quoteToken` se reutiliza en todo el escaneo.
 */
export async function fetchWindowQuotesTt(
  ticker: string, now: Date, quoteToken?: QuoteToken,
): Promise<QuotesResult> {
  // El spot del subyacente viaja en la MISMA respuesta: no cuesta una llamada más.
  const { contracts, spot } = await fetchTastytradeChain(ticker, {
    dteMin: Math.max(0, DTE_MIN - 1),
    dteMax: DTE_MAX + 1,
    quoteToken,
  });
  return { quotes: contracts.map((c) => toSpreadQuoteFromTt(c, now)), spot };
}
