// ============================================================================
// Fuente Tastytrade de "Grandes empresas" y "Grandes empresas 2.0" (oct 2026,
// pedido del dueño: "usar solo Tasty"). Sustituye a MarketSnack (precio, gráfica
// del día, GEX y net premium por contrato), a Massive (velas) y a Schwab (cadena
// del GEX de la 2.0). Todo sale de lib/tastytrade de Tito:
//   · cadena con griegos/OI/bid-ask reales y spot (REST nested + DXLink)
//   · velas 15m / diarias / 5m con pre-market (DXLink Candle)
//   · actividad por contrato desde el Time & Sales (DXLink TimeAndSale),
//     agrupada en buckets de 5 min con el MISMO shape que trade_summaries de
//     MarketSnack (ask/bid/mid premium), así `summarizeActivity` no cambia.
// Solo servidor.
// ============================================================================

import {
  fetchQuoteToken,
  fetchTastytradeCandles,
  fetchTastytradeChain,
  type QuoteToken,
  type TtContract,
} from "@/lib/tastytrade";
import { sideOf } from "@/lib/flowSources";
import { summarizeActivity, type ActivitySummary, type TradeSummaryBucketLike } from "./contratosVecinos3";
import { etTimeToUnix, marketDateStr } from "./occ";
import { toRow } from "./odteStandalone/compute";
import { zeroDteGex } from "./odteStandalone/zerodte";
import { ttToRaw } from "./odteStandalone/tastySource";
import type { TfBar } from "./types";

/** Días hacia adelante que se piden de cadena: basta para `selectWeeklyExpirations` (como mucho +2 días, o el próximo real). */
const CHAIN_DTE_MAX = 10;

/** Contrato cercano con lo que necesitan las dos rutas. */
export interface NearContract {
  strike: number;
  expiration: string;
  contractType: "call" | "put";
  /** OCC compacto ("AAPL261009C00252500"). */
  optionTicker: string;
  /** Símbolo del streamer DXLink (".AAPL261009C252.5"). */
  streamer: string;
}

export interface CompanyBase {
  token: QuoteToken;
  spot: number | null;
  contracts: NearContract[];
  /** Cadena cruda de Tastytrade (griegos/OI) para el GEX. */
  tt: TtContract[];
  bars15m: TfBar[];
  dailyBars: TfBar[];
  /** Velas de 5 min de las últimas sesiones CON pre-market (para % y rechazos de pre-market). */
  todayBars: TfBar[];
}

/** "AAPL261009C00252500" → ".AAPL261009C252.5" (formato de símbolo del streamer de dxFeed). */
export function streamerFromOcc(occ: string): string | null {
  const m = /^([A-Z0-9./]+?)(\d{6})([CP])(\d{8})$/.exec(occ.replace(/\s+/g, ""));
  if (!m) return null;
  const strike = Number(m[4]) / 1000;
  return `.${m[1]}${m[2]}${m[3]}${strike}`;
}

/** Cadena cercana + velas, todo en paralelo con UN token de streamer. */
export async function fetchCompanyBase(ticker: string): Promise<CompanyBase> {
  const T = ticker.trim().toUpperCase();
  const token = await fetchQuoteToken();
  const [chain, bars15m, dailyBars, todayBars] = await Promise.all([
    fetchTastytradeChain(T, { dteMin: 0, dteMax: CHAIN_DTE_MAX, quoteToken: token }),
    fetchTastytradeCandles(T, "15m10d", 20, { quoteToken: token }).catch(() => []),
    fetchTastytradeCandles(T, "1y", 7, { quoteToken: token }).catch(() => []),
    fetchTastytradeCandles(T, "5m5d", 2, { quoteToken: token }).catch(() => []),
  ]);

  const contracts: NearContract[] = [];
  for (const c of chain.contracts) {
    if (!c.symbol) continue;
    const streamer = streamerFromOcc(c.symbol);
    if (!streamer) continue;
    contracts.push({ strike: c.strike, expiration: c.expiration, contractType: c.type, optionTicker: c.symbol, streamer });
  }
  const spot = chain.spot ?? todayBars.at(-1)?.close ?? null;
  return { token, spot, contracts, tt: chain.contracts, bars15m, dailyBars, todayBars };
}

const BUCKET_MS = 5 * 60_000;
const ASK_SIDES = new Set(["ABOVE_ASK", "AT_ASK", "ASKSIDE"]);
const BID_SIDES = new Set(["BELOW_BID", "AT_BID", "BIDSIDE"]);

/**
 * Actividad del día por grupo de contratos (clave → símbolos del streamer).
 * Cada impresión del Time & Sales se clasifica ask/bid/mid como MarketSnack y
 * se suma en buckets de 5 min; los símbolos de un mismo grupo (mismo strike en
 * varios vencimientos) se FUSIONAN por bucket antes de `summarizeActivity`.
 * Ojo: dxFeed da como mucho ~1.000 impresiones por símbolo (las más recientes).
 */
export async function fetchActivityGroupedTasty(
  groups: Map<string, string[]>,
  token: QuoteToken,
  now: Date = new Date(),
): Promise<Map<string, ActivitySummary>> {
  const out = new Map<string, ActivitySummary>();
  const symbols = [...new Set([...groups.values()].flat())];
  if (symbols.length === 0) return out;

  const { dxlinkTimeAndSale } = await import("@/lib/tastytradeStream");
  const fromTime = etTimeToUnix(marketDateStr(now), 0, 0) * 1000; // la sesión de hoy (ET)
  const prints = await dxlinkTimeAndSale({ url: token.url, token: token.token, symbols, fromTime });

  // símbolo → bucket(ms) → acumulado
  const bySymbol = new Map<string, Map<number, TradeSummaryBucketLike>>();
  for (const p of prints) {
    if (!(p.price > 0) || !(p.size > 0) || p.time < fromTime) continue;
    const premium = p.price * p.size * 100;
    const t = Math.floor(p.time / BUCKET_MS) * BUCKET_MS;
    let buckets = bySymbol.get(p.symbol);
    if (!buckets) bySymbol.set(p.symbol, (buckets = new Map()));
    let b = buckets.get(t);
    if (!b) buckets.set(t, (b = { t: new Date(t).toISOString(), ask_premium: 0, bid_premium: 0, mid_premium: 0 }));
    const side = sideOf(p);
    if (ASK_SIDES.has(side)) b.ask_premium += premium;
    else if (BID_SIDES.has(side)) b.bid_premium += premium;
    else b.mid_premium += premium;
  }

  for (const [key, syms] of groups) {
    const merged = new Map<string, TradeSummaryBucketLike>();
    for (const s of syms) {
      for (const b of bySymbol.get(s)?.values() ?? []) {
        const m = merged.get(b.t);
        if (m) {
          m.ask_premium += b.ask_premium;
          m.bid_premium += b.bid_premium;
          m.mid_premium += b.mid_premium;
        } else merged.set(b.t, { ...b });
      }
    }
    out.set(key, summarizeActivity([...merged.values()]));
  }
  return out;
}

/** Niveles GEX del estilo de MarketSnack (imán, muros, flip) sobre los vencimientos dados. */
export interface GexLevels {
  magnet: number | null;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
}

export function gexLevels(tt: TtContract[], ticker: string, spot: number, expirations: string[]): GexLevels | null {
  const set = new Set(expirations);
  const rows = ttToRaw(tt.filter((c) => set.has(c.expiration)), ticker, spot).map(toRow);
  if (rows.length === 0 || !(spot > 0)) return null;
  const gex = zeroDteGex(rows, spot);
  if (gex.nodes.length === 0) return null;
  // Muro de calls = strike con el mayor GEX neto positivo; muro de puts = el más negativo.
  let callWall: { strike: number; v: number } | null = null;
  let putWall: { strike: number; v: number } | null = null;
  for (const n of gex.nodes) {
    if (n.netGex > 0 && (!callWall || n.netGex > callWall.v)) callWall = { strike: n.strike, v: n.netGex };
    if (n.netGex < 0 && (!putWall || n.netGex < putWall.v)) putWall = { strike: n.strike, v: n.netGex };
  }
  return {
    magnet: gex.kingStrike,
    callWall: callWall?.strike ?? null,
    putWall: putWall?.strike ?? null,
    gammaFlip: gex.flipStrike,
  };
}
