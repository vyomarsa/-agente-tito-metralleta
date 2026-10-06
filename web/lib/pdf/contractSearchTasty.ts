// ============================================================================
// Flujo de "Búsqueda de contratos" desde Tastytrade (oct 2026, pedido del dueño:
// "usar solo Tasty"). MarketSnack daba el flujo de TODO el mercado; Tastytrade
// no tiene ese feed, así que se escanea una lista FIJA elegida por el dueño:
// las 14 de "Grandes empresas" + SPY y QQQ.
//
// Por ticker, para no bajar el Time & Sales de miles de contratos:
//   1. snapshot de la cadena 10-40 DTE (OI y volumen del día por contrato)
//   2. solo los contratos con volumen > OI (el mismo filtro que aplica la ruta)
//   3. Time & Sales de HOY de esos contratos → RawTrade (formato MarketSnack),
//      solo las impresiones ≥ minPremium.
// Solo servidor.
// ============================================================================

import { fetchQuoteToken, fetchTastytradeSpot, streamChainForFlow, type QuoteToken } from "@/lib/tastytrade";
import { COND_MULTI_LEG, COND_SINGLE, printId, sentimentOf, sideOf } from "@/lib/flowSources";
import { GRANDES_EMPRESAS } from "./grandesEmpresas";
import { MAX_DTE, MIN_DTE } from "./contractSearch";
import { etTimeToUnix, marketDateStr } from "./occ";
import type { RawTrade } from "./flow";

/** Universo del escáner: las 14 de Grandes empresas + SPY y QQQ. */
export const CONTRACT_SEARCH_UNIVERSE: string[] = [...GRANDES_EMPRESAS.map((t) => t.id), "SPY", "QQQ"];

export interface UniverseFlowResult {
  trades: RawTrade[];
  /** Spot por ticker (mid del streamer), para el precio en vivo de los finalistas. */
  spots: Map<string, number>;
  /** Tickers que no se pudieron escanear (cadena o streamer caído). */
  failed: string[];
  /** Contratos que llegaron al tope de ~1.000 impresiones de dxFeed (histórico recortado). */
  truncated: number;
}

async function scanTicker(
  ticker: string,
  token: QuoteToken,
  fromTime: number,
  minPremium: number,
): Promise<{ trades: RawTrade[]; spot: number | null; truncated: number }> {
  const [{ contratos }, spot] = await Promise.all([
    streamChainForFlow(ticker, { dteMin: MIN_DTE, dteMax: MAX_DTE, quoteToken: token }),
    fetchTastytradeSpot(ticker, { quoteToken: token }).catch(() => null),
  ]);
  const candidates = [...contratos].filter(([, c]) => c.openInterest > 0 && c.volume > c.openInterest);
  if (candidates.length === 0) return { trades: [], spot, truncated: 0 };

  const { dxlinkTimeAndSale } = await import("@/lib/tastytradeStream");
  const prints = await dxlinkTimeAndSale({
    url: token.url,
    token: token.token,
    symbols: candidates.map(([sym]) => sym),
    fromTime,
  });

  const bySymbol = new Map(candidates);
  const counts = new Map<string, number>();
  const trades: RawTrade[] = [];
  for (const p of prints) {
    const c = bySymbol.get(p.symbol);
    if (!c || p.time < fromTime) continue;
    counts.set(p.symbol, (counts.get(p.symbol) ?? 0) + 1);
    const premium = p.price * p.size * 100;
    if (premium < minPremium) continue;
    const side = sideOf(p);
    trades.push({
      id: printId(c.occ, p.time, p.price, p.size),
      symbol: c.occ,
      price: p.price,
      size: p.size,
      side,
      bid_price: p.bid ?? 0,
      ask_price: p.ask ?? 0,
      premium,
      delta: c.delta ?? 0,
      gamma: c.gamma ?? undefined,
      theta: c.theta ?? undefined,
      vega: c.vega ?? undefined,
      implied_volatility: c.iv ?? 0,
      open_interest: c.openInterest,
      volume: c.volume,
      score: 0,
      sentiment: sentimentOf(c.type, side),
      timestamp: new Date(p.time).toISOString(),
      asset_price: spot ?? undefined,
      trade_condition_id: p.spreadLeg ? COND_MULTI_LEG : COND_SINGLE,
    });
  }
  const truncated = [...counts.values()].filter((n) => n >= 1000).length;
  return { trades, spot, truncated };
}

/** Tickers escaneados a la vez (cada uno abre su propio streamer). */
const CONCURRENCY = 4;

/** Escanea el universo fijo en tandas de CONCURRENCY. `onTicker` informa el avance. */
export async function fetchUniverseFlow(opts: {
  minPremium: number;
  now?: Date;
  onTicker?: (ticker: string, index: number, total: number, tradesSoFar: number) => void;
}): Promise<UniverseFlowResult> {
  const now = opts.now ?? new Date();
  const fromTime = etTimeToUnix(marketDateStr(now), 0, 0) * 1000; // solo el día de HOY (ET)
  const token = await fetchQuoteToken();
  const trades: RawTrade[] = [];
  const spots = new Map<string, number>();
  const failed: string[] = [];
  let truncated = 0;
  let done = 0;

  const total = CONTRACT_SEARCH_UNIVERSE.length;
  let next = 0;
  async function worker() {
    while (next < total) {
      const ticker = CONTRACT_SEARCH_UNIVERSE[next++];
      try {
        const r = await scanTicker(ticker, token, fromTime, opts.minPremium);
        trades.push(...r.trades);
        if (r.spot != null) spots.set(ticker, r.spot);
        truncated += r.truncated;
      } catch {
        failed.push(ticker);
      }
      opts.onTicker?.(ticker, ++done, total, trades.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { trades, spots, failed, truncated };
}
