// GET /api/0dte/flow?ticker=SPX — agresor (compra vs venta) del vencimiento de hoy.
// Solo LEE el acumulador que escriben los streamers de Tastytrade; ya no hace
// polling a la fuente de datos (retirado). Ver Agente Principal/Proceso 0DTE.md §6.3.
//
// Fuentes:
//  · Futuros nativos (/ES, /NQ): archivo del streamer de futuros (data/tastytrade-fut/…).
//    Si ese streamer está caído/viejo → ALTERNA: agresor del índice (/ES→SPX, /NQ→NDX).
//  · Índices/ETF (SPX, NDX, …): archivo del streamer de índice (data/0dte/…).

import { futureStoreKey, isNativeFuture, loadNativeFuture, nativeFresh } from "@/lib/pdf/odteStandalone/futuresNative";
import { marketDateStr } from "@/lib/pdf/odteStandalone/occ";
import { resolveTicker } from "@/lib/pdf/odteStandalone/zerodte";
import { loadFlow, readAggressor, type AggressorRead } from "@/lib/pdf/odteStandalone/zerodteFlow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const reqTicker = (searchParams.get("ticker") ?? "SPX").trim().toUpperCase();
  if (!reqTicker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  const nativeFut = isNativeFuture(reqTicker) ? reqTicker.toUpperCase() : null;
  const now = new Date();
  const date = marketDateStr(now);

  try {
    let acc; let ticker: string;
    if (nativeFut) {
      // PRIMARIA (Tastytrade): agresor nativo del futuro. Si el streamer está
      // caído/viejo → ALTERNA: agresor del índice equivalente (SPX/NDX).
      const nf = await loadNativeFuture(nativeFut, date);
      if (nativeFresh(nf)) {
        acc = nf!.acc;
        ticker = futureStoreKey(nativeFut);
      } else {
        ticker = resolveTicker(nativeFut).analysis;
        acc = await loadFlow(ticker, date);
      }
    } else {
      ticker = resolveTicker(reqTicker).analysis;
      acc = await loadFlow(ticker, date); // lo escribe streamer/tastytrade-stream.mjs
    }

    // Lectura por contrato, ya filtrada por muestra mínima. Y de paso, los
    // totales agregados del día para el panel "Volumen en vivo" (velocidad + CVD):
    // buyAggr/sellAggr son contratos ejecutados contra el ask/bid (comprador vs
    // vendedor agresivo), acumulados y monótonos. El CVD = buyAggr − sellAggr.
    const reads: Record<string, AggressorRead> = {};
    let buyAggr = 0, sellAggr = 0, midAggr = 0, totalVol = 0, newestTs = 0;
    // Strike que MÁS empuja el CVD a cada lado: net = ask − bid por contrato.
    let topSell: { strike: number; type: string; net: number } | null = null;
    let topBuy: { strike: number; type: string; net: number } | null = null;
    for (const b of Object.values(acc.buckets)) {
      const r = readAggressor(acc, b.type, b.strike);
      if (r) reads[`${b.type}:${b.strike}`] = r;
      buyAggr += b.ask || 0;
      sellAggr += b.bid || 0;
      midAggr += b.mid || 0;
      totalVol += b.volume || 0;
      if (b.ts > newestTs) newestTs = b.ts;
      const net = (b.ask || 0) - (b.bid || 0);
      if (net < 0 && (!topSell || net < topSell.net)) topSell = { strike: b.strike, type: b.type, net };
      if (net > 0 && (!topBuy || net > topBuy.net)) topBuy = { strike: b.strike, type: b.type, net };
    }

    // "Contratos entrantes": bloques grandes single-leg que califican, lista
    // rodante que escribe el streamer (más nuevo primero). Vacío si no aplica.
    const topTrades = (acc as unknown as { topTrades?: unknown[] }).topTrades;

    return Response.json({
      ticker,
      date,
      cycles: acc.cycles,
      updatedAt: acc.updatedAt,
      contracts: Object.keys(acc.buckets).length,
      tradesThisCycle: 0, // ya no hay polling: solo lectura del acumulador
      pages: 0,
      reads,
      buyAggr,
      sellAggr,
      midAggr,
      totalVol,
      newestTs,
      topSell,
      topBuy,
      topTrades: Array.isArray(topTrades) ? topTrades : [],
    });
  } catch {
    // 200 con `error`: la página funciona sin agresor, solo pierde esa columna.
    return Response.json({ error: "Error al leer el flujo 0DTE.", reads: {} }, { status: 200 });
  }
}
