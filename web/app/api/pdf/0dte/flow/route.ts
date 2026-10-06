// GET /api/0dte/flow — agresor (compra vs venta), CVD, velocidad y "0DTE Live"
// (contratos entrantes) del vencimiento de hoy. Porte fiel del proyecto
// standalone Agente 0DTE: SOLO LEE lo que ya escriben los streamers de
// Tastytrade — streamer/tastytrade-stream.mjs (SPX), tastytrade-index-
// stream.mjs (SPY/QQQ) y tastytrade-futures-stream.mjs (ES/NQ). Ya NO pollea
// MarketSnack para esta pestaña (pedido explícito, ago 2026) —
// MarketSnack sigue viva sin cambios en el resto de Visionary Trades.

import { marketDateStr } from "@/lib/pdf/occ";
import { isNativeFuture, loadNativeFuture, nativeFresh } from "@/lib/pdf/futuresNative";
import { zeroDteTickerConfig } from "@/lib/pdf/zerodteTickers";
import {
  classifiedFlow, loadFlow, netAggressorTotals, readAggressor, volumeVelocity,
  type AggressorRead, type FlowAccumulator,
} from "@/lib/pdf/zerodteFlow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const TICKER = zeroDteTickerConfig(searchParams.get("ticker")).underlying;
  const now = new Date();
  const date = marketDateStr(now);

  try {
    let acc: FlowAccumulator;

    if (isNativeFuture(TICKER)) {
      const nf = await loadNativeFuture(TICKER, date);
      if (!nf || !nativeFresh(nf, now.getTime())) {
        return Response.json({ ticker: TICKER, date, reads: {}, topTrades: [] });
      }
      acc = nf.acc;
    } else {
      acc = await loadFlow(TICKER, date);
    }

    const reads: Record<string, AggressorRead> = {};
    for (const b of Object.values(acc.buckets)) {
      const r = readAggressor(acc, b.type, b.strike);
      if (r) reads[`${b.type}:${b.strike}`] = r;
    }

    const topTrades = acc.topTrades ?? [];

    return Response.json({
      ticker: TICKER, date, cycles: acc.cycles, updatedAt: acc.updatedAt,
      contracts: Object.keys(acc.buckets).length, reads,
      netAggressor: netAggressorTotals(acc), velocity: volumeVelocity(acc), classified: classifiedFlow(acc),
      topTrades,
    });
  } catch {
    // 200 con `error`: la página funciona sin agresor, solo pierde esa columna.
    return Response.json({ error: "Error al leer el flujo 0DTE.", reads: {} }, { status: 200 });
  }
}
