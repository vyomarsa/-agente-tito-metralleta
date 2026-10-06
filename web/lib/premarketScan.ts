// Ensamblaje del sub-agente de pre-market: junta los datos y arma el informe.
// Solo servidor. La lógica de lectura vive en `lib/premarket.ts` (pura).
//
// Fuentes:
//   · Tastytrade (DXLink): cotización de pre-market, velas 4H y cadena de
//     opciones con open interest/delta → medias y nocional.
//   · Massive: titulares por ticker con sentimiento (plan gratis, 5/min → van
//     en cola con `acquireSlot`; tarda ~2 min, sobra para una vez al día).
//   · RSS de CNBC/Investing y el calendario macro de FRED (CPI/NFP/PCE/FOMC).
//
// Cada ticker degrada por separado: si falla la cadena de NVDA, NVDA sale sin
// nocional y con el aviso, pero el informe se manda igual.

import {
  fetchMarketMetrics, fetchQuoteToken, fetchTastytradeCandles, fetchTastytradeChain,
  fetchTastytradeQuotes, fetchTastytradeSpot, tastytradeConfigured, type QuoteToken,
} from "./tastytrade";
import { fetchMacroFeeds, fetchTickerNews, mentionsCompany } from "./news";
import { acquireSlot } from "./massiveLimiter";
import { addDaysStr, cachedMacroCalendar } from "./macroCalendar";
import { marketDateStr } from "./occ";
import {
  MAGNIFICENT_7, PREMARKET_TICKERS, headlineBias, maAnalysis, notionalSummary,
  type MacroLine, type PremarketReport, type TickerInput,
} from "./premarket";

/** Días de velas 4H a pedir: 200 velas a 2 por sesión ≈ 100 sesiones ≈ 145 días. */
const CANDLE_DAYS = 200;
/** Vencimientos de la cadena para el nocional: las semanales cercanas. */
const EXPIRATIONS: Record<string, number> = { SPY: 3, QQQ: 3, SPX: 3 };
const DEFAULT_EXPIRATIONS = 2;
/** Earnings en los próximos N días se avisan. */
const EARNINGS_DAYS = 7;
/** Macro que se anuncia como "próximo". */
const MACRO_SOON_DAYS = 3;
/** Cómo reconocer que un titular habla DE la empresa (Massive asocia artículos que solo la citan). */
const ALIASES: Record<string, string[]> = {
  SPY: ["SPY", "S&P 500", "S&P", "Wall Street", "stocks", "Dow"],
  QQQ: ["QQQ", "Nasdaq", "tech stocks"],
  AAPL: ["AAPL", "Apple", "iPhone"],
  MSFT: ["MSFT", "Microsoft", "Azure"],
  NVDA: ["NVDA", "Nvidia"],
  AMZN: ["AMZN", "Amazon", "AWS"],
  GOOGL: ["GOOGL", "Alphabet", "Google"],
  META: ["META", "Meta Platforms", "Facebook", "Instagram", "Zuckerberg"],
  TSLA: ["TSLA", "Tesla", "Musk"],
};
/** Titulares macro: solo los de las últimas N horas. */
const HEADLINE_HOURS = 14;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function tickerData(
  ticker: string,
  tok: QuoteToken,
  quote: { price: number | null; prevClose: number | null } | undefined,
): Promise<TickerInput> {
  const errors: string[] = [];
  let price: number | null = null;

  // Pre-market: el mid de la horquilla actual. La cinta (`last`) es el último
  // trade de la sesión regular y no se mueve hasta la apertura.
  try {
    price = await fetchTastytradeSpot(ticker, { quoteToken: tok, timeoutMs: 5000 });
  } catch (e) {
    errors.push(`precio: ${msg(e)}`);
  }
  if (price == null) price = quote?.price ?? null;

  let ma: TickerInput["ma"] = null;
  try {
    const bars = await fetchTastytradeCandles(ticker, "4h", CANDLE_DAYS, { quoteToken: tok, timeoutMs: 20000 });
    const closes = bars.map((b) => b.close);
    if (closes.length > 0) ma = maAnalysis(closes, price ?? closes[closes.length - 1]);
    else errors.push("sin velas 4H");
  } catch (e) {
    errors.push(`velas: ${msg(e)}`);
  }

  let notional: TickerInput["notional"] = null;
  try {
    const { contracts, spot } = await fetchTastytradeChain(ticker, {
      expirations: EXPIRATIONS[ticker] ?? DEFAULT_EXPIRATIONS,
      quoteToken: tok,
      timeoutMs: 25000,
    });
    const ref = price ?? spot;
    if (ref && contracts.length) notional = notionalSummary(contracts, ref);
    else errors.push("cadena vacía");
  } catch (e) {
    errors.push(`opciones: ${msg(e)}`);
  }

  return {
    ticker, price, prevClose: quote?.prevClose ?? null, ma, notional,
    newsBias: null, earningsDate: null, headlines: [], errors,
  };
}

export async function buildPremarketReport(now: Date = new Date()): Promise<PremarketReport> {
  if (!tastytradeConfigured()) throw new Error("Tastytrade no está configurado (faltan credenciales).");
  const date = marketDateStr(now);
  const tok = await fetchQuoteToken();

  const quotes = await fetchTastytradeQuotes([...PREMARKET_TICKERS, "VIX"], { quoteToken: tok }).catch(
    () => new Map(),
  );

  // Secuencial a propósito: cada ticker abre varias conexiones al streamer y la
  // cadena de SPX es grande; en paralelo se pisan los timeouts.
  const tickers: TickerInput[] = [];
  for (const t of PREMARKET_TICKERS) tickers.push(await tickerData(t, tok, quotes.get(t)));

  // SPX no cotiza antes de las 9:30: se estima con el gap de SPY sobre su cierre.
  const spx = tickers.find((t) => t.ticker === "SPX");
  const spy = tickers.find((t) => t.ticker === "SPY");
  if (spx?.prevClose && spy?.price && spy.prevClose) {
    spx.price = spx.prevClose * (spy.price / spy.prevClose);
    spx.priceImplied = true;
  }

  // Earnings de las 7 en UNA llamada.
  try {
    const metrics = await fetchMarketMetrics([...MAGNIFICENT_7]);
    const limite = addDaysStr(date, EARNINGS_DAYS);
    for (const m of metrics) {
      const t = tickers.find((x) => x.ticker === m.symbol.toUpperCase());
      if (t && m.earningsDate && m.earningsDate >= date && m.earningsDate <= limite) t.earningsDate = m.earningsDate;
    }
  } catch {
    /* sin earnings: el informe sale igual */
  }

  // Noticias por ticker (Massive, en cola). SPX comparte las de SPY.
  const desde = now.getTime() - 36 * 3600_000;
  for (const t of tickers) {
    if (t.ticker === "SPX") continue;
    try {
      await acquireSlot(90_000);
      const items = (await fetchTickerNews(t.ticker, 10)).filter((i) => Date.parse(i.publishedUtc) >= desde);
      // El sentimiento de Massive es POR TICKER y vale para el sesgo aunque el
      // artículo trate de otra cosa; para enseñar, solo los que la nombran.
      t.newsBias = headlineBias(items);
      const aliases = ALIASES[t.ticker] ?? [t.ticker];
      t.headlines = items
        .filter((i) => mentionsCompany(i.title, aliases))
        .map((i) => ({ title: i.title, sentiment: i.sentiment }));
    } catch {
      /* sin noticias de este ticker */
    }
  }
  if (spx && spy) {
    spx.headlines = [];
    spx.newsBias = spy.newsBias;
  }

  // Calendario macro.
  const macroToday: MacroLine[] = [];
  const macroSoon: MacroLine[] = [];
  try {
    const cal = await cachedMacroCalendar(now);
    const hasta = addDaysStr(date, MACRO_SOON_DAYS);
    for (const e of cal?.events ?? []) {
      if (e.date === date) macroToday.push({ date: e.date, label: e.label });
      else if (e.date > date && e.date <= hasta) macroSoon.push({ date: e.date, label: e.label });
    }
  } catch {
    /* sin calendario */
  }

  // Titulares macro recientes (RSS).
  let headlines: PremarketReport["headlines"] = [];
  try {
    const corte = now.getTime() - HEADLINE_HOURS * 3600_000;
    headlines = (await fetchMacroFeeds())
      .filter((h) => Date.parse(h.publishedUtc) >= corte)
      .slice(0, 5)
      .map((h) => ({ title: h.title, publisher: h.publisher }));
  } catch {
    /* sin RSS */
  }

  const vixQ = quotes.get("VIX");
  return { date, tickers, vix: vixQ?.price ?? null, macroToday, macroSoon, headlines };
}
