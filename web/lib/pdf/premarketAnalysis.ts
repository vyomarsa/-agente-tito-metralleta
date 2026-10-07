// ============================================================================
// Análisis de pre-market de SPY, QQQ, SPX y las 7 magníficas (pedido del dueño,
// 2026-10-07): precio y % de pre-market, soportes/resistencias, put wall, call
// wall, imán, net GEX y flip. Lo sirve /api/pdf/premarket-analysis para la
// pestaña "Pre-market". Solo servidor.
//
// Fuentes (mismo criterio medido que el resto de Prueba de Fuego):
//   · GEX (net GEX, walls, imán): MarketSnack `gex_stats_chart` — una llamada por
//     ticker; su imán coincidió con el que calculamos (SPX 7820, 2026-10-07).
//   · FLIP: MarketSnack lo deja en null cuando no ve cambio de signo (4 de 5
//     tickers el 2026-10-07), así que si falta se CALCULA con la cadena de
//     Tastytrade del vencimiento más cercano (gamma y OI reales, zeroDteGex).
//   · Si MarketSnack falla, TODO el GEX sale de ese cálculo de Tastytrade.
//   · Precio de pre-market: MarketSnack `/api/assets` (extended_price). SPX es un
//     índice y no cotiza en pre-market: se enseña su último cierre.
//   · Soportes/resistencias: pivotes de las velas DIARIAS (lib/pdf/levels.ts,
//     findLevels) + máximo/mínimo del pre-market de hoy (velas de 5 min).
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import {
  fetchQuoteToken,
  fetchTastytradeCandles,
  fetchTastytradeChain,
  fetchTastytradeQuotes,
  type QuoteToken,
} from "@/lib/tastytrade";
import { fetchGexStats } from "./marketsnack";
import { findLevels } from "./levels";
import { filterPremarketBars } from "./marketHours";
import { marketDateStr } from "./occ";
import { toRow } from "./odteStandalone/compute";
import { zeroDteGex } from "./odteStandalone/zerodte";
import { ttToRaw } from "./odteStandalone/tastySource";

export const PREMARKET_TICKERS = ["SPY", "QQQ", "SPX", "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

export interface SimpleLevel {
  price: number;
  /** 0-100 (fuerza del nivel según findLevels). */
  strength: number;
  distancePct: number;
}

export interface TickerAnalysis {
  ticker: string;
  /** Precio actual: pre-market si lo hay, si no el último. */
  price: number | null;
  prevClose: number | null;
  /** % de la sesión extendida (o del día) contra el cierre anterior. */
  changePct: number | null;
  session: string | null;
  premarketHigh: number | null;
  premarketLow: number | null;
  gex: {
    netGex: number | null;
    callWall: number | null;
    putWall: number | null;
    magnet: number | null;
    flip: number | null;
    maxPain: number | null;
    /** De dónde salió cada cosa. */
    source: "MarketSnack" | "Tastytrade" | null;
    flipSource: "MarketSnack" | "Tastytrade" | null;
    /** Instante de la foto de MarketSnack (cierre de la sesión anterior en pre-market). */
    asOf: string | null;
  };
  supports: SimpleLevel[];
  resistances: SimpleLevel[];
  error?: string;
}

async function loadCookie(): Promise<string | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "marketsnack-cookie.json"), "utf8"));
    if (j && typeof j.cookie === "string" && j.cookie.trim()) return j.cookie.trim();
  } catch {
    // sin archivo
  }
  return process.env.MARKETSNACK_COOKIE?.trim() || null;
}

/** Precio de la sesión extendida desde MarketSnack. null si no hay (índices, fuera de horario, sin cookie). */
async function msExtended(ticker: string, cookie: string | null) {
  if (!cookie) return null;
  try {
    const res = await fetch(`https://app.marketsnack.com/api/assets/${encodeURIComponent(ticker)}`, {
      headers: { Accept: "application/json", Cookie: cookie },
      redirect: "manual",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      extended_price_type?: string | null;
      extended_price?: number | null;
      extended_price_change?: { percentage?: number } | null;
    };
    if (!j.extended_price_type || typeof j.extended_price !== "number") return null;
    return { session: j.extended_price_type, price: j.extended_price, pct: j.extended_price_change?.percentage ?? null };
  } catch {
    return null;
  }
}

/** GEX calculado con la cadena de Tastytrade del vencimiento más cercano. */
async function tastyGex(ticker: string, token: QuoteToken) {
  const chain = await fetchTastytradeChain(ticker, { expirations: 1, quoteToken: token });
  const spot = chain.spot;
  if (spot == null || chain.contracts.length === 0) return null;
  const rows = ttToRaw(chain.contracts, ticker, spot).map(toRow);
  const g = zeroDteGex(rows, spot);
  let callWall: { strike: number; v: number } | null = null;
  let putWall: { strike: number; v: number } | null = null;
  for (const n of g.nodes) {
    if (n.netGex > 0 && (!callWall || n.netGex > callWall.v)) callWall = { strike: n.strike, v: n.netGex };
    if (n.netGex < 0 && (!putWall || n.netGex < putWall.v)) putWall = { strike: n.strike, v: n.netGex };
  }
  return {
    netGex: g.totalNetGex,
    magnet: g.kingStrike,
    flip: g.flipStrike,
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
  };
}

async function analyzeOne(
  ticker: string,
  ctx: { token: QuoteToken; cookie: string | null; quote: { price: number | null; prevClose: number | null } | undefined; now: Date },
): Promise<TickerAnalysis> {
  const { token, cookie, now } = ctx;
  const [gexBuckets, ext, daily, intraday] = await Promise.all([
    cookie ? fetchGexStats(ticker).catch(() => null) : Promise.resolve(null),
    msExtended(ticker, cookie),
    fetchTastytradeCandles(ticker, "1y", 200, { quoteToken: token }).catch(() => []),
    fetchTastytradeCandles(ticker, "5m5d", 2, { quoteToken: token }).catch(() => []),
  ]);

  const prevClose = ctx.quote?.prevClose ?? null;
  const price = ext?.price ?? ctx.quote?.price ?? daily.at(-1)?.close ?? null;
  const changePct = ext?.pct ?? (price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null);

  // GEX: MarketSnack; flip (o todo, si MarketSnack falla) desde Tastytrade.
  const ms = gexBuckets?.at(-1) ?? null;
  let gex: TickerAnalysis["gex"] = {
    netGex: ms?.net_gex ?? null,
    callWall: ms?.call_wall ?? null,
    putWall: ms?.put_wall ?? null,
    magnet: ms?.magnet ?? null,
    flip: ms?.gamma_flip ?? null,
    maxPain: ms?.max_pain ?? null,
    source: ms ? "MarketSnack" : null,
    flipSource: ms?.gamma_flip != null ? "MarketSnack" : null,
    asOf: ms?.t ?? null,
  };
  if (!ms || gex.flip == null) {
    const tg = await tastyGex(ticker, token).catch(() => null);
    if (tg) {
      if (!ms) {
        gex = { ...gex, netGex: tg.netGex, callWall: tg.callWall, putWall: tg.putWall, magnet: tg.magnet, source: "Tastytrade" };
      }
      if (tg.flip != null) gex = { ...gex, flip: tg.flip, flipSource: "Tastytrade" };
    }
  }

  // Soportes y resistencias de las velas diarias (sin opciones: esas ya van en el GEX).
  const spot = price ?? 0;
  const lv = findLevels({
    bars: daily.map((b) => ({ time: marketDateStr(new Date(b.time * 1000)), high: b.high, low: b.low, close: b.close })),
    spot,
    now,
    rangePct: 8,
  });
  const simple = (l: { price: number; strength: number; distancePct: number }): SimpleLevel => ({
    price: l.price, strength: Math.round(l.strength), distancePct: l.distancePct,
  });

  // Rango del pre-market de HOY (las velas de 5 min traen la sesión extendida).
  const pm = filterPremarketBars(intraday, marketDateStr(now));
  const premarketHigh = pm.length ? Math.max(...pm.map((b) => b.high)) : null;
  const premarketLow = pm.length ? Math.min(...pm.map((b) => b.low)) : null;

  return {
    ticker,
    price,
    prevClose,
    changePct,
    session: ext?.session ?? null,
    premarketHigh,
    premarketLow,
    gex,
    supports: lv.supports.slice(0, 3).map(simple),
    resistances: lv.resistances.slice(0, 3).map(simple),
  };
}

/** Análisis de los 10 tickers. De a 3 en paralelo para no saturar el streamer. */
export async function analyzePremarket(now: Date = new Date()): Promise<{ asOf: string; tickers: TickerAnalysis[] }> {
  const [token, cookie] = await Promise.all([fetchQuoteToken(), loadCookie()]);
  const quotes = await fetchTastytradeQuotes(PREMARKET_TICKERS, { quoteToken: token }).catch(() => new Map());
  const out: TickerAnalysis[] = new Array(PREMARKET_TICKERS.length);
  let next = 0;
  async function worker() {
    while (next < PREMARKET_TICKERS.length) {
      const i = next++;
      const ticker = PREMARKET_TICKERS[i];
      const q = quotes.get(ticker);
      try {
        out[i] = await analyzeOne(ticker, { token, cookie, quote: q ? { price: q.price, prevClose: q.prevClose } : undefined, now });
      } catch (err) {
        out[i] = {
          ticker, price: null, prevClose: null, changePct: null, session: null, premarketHigh: null, premarketLow: null,
          gex: { netGex: null, callWall: null, putWall: null, magnet: null, flip: null, maxPain: null, source: null, flipSource: null, asOf: null },
          supports: [], resistances: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  return { asOf: now.toISOString(), tickers: out };
}
