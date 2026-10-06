// GET /api/0dte/flow?ticker=SPY&expiration=YYYY-MM-DD — Lecturas de agresor 0DTE.
//
// Toma el Time & Sales de HOY (MarketSnack), lo clasifica (bid/ask), y agrega por
// contrato del vencimiento 0DTE en lecturas de dominio: comprar call = alcista,
// vender put = soporte, comprar put = cobertura/bajista, vender call = resistencia.

import { classifyFlow } from "@/lib/flow";
import { MarketSnackError } from "@/lib/marketsnack";
import { fetchTickerFlow } from "@/lib/flowSources";
import { aggressorReads } from "@/lib/zerodte";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["SPY", "QQQ", "SPX", "IWM"]);
const MIN_PREMIUM = 25_000; // 0DTE mueve tickets más chicos; piso bajo a propósito
const MAX_PAGES = 8;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  const expiration = (searchParams.get("expiration") ?? "").trim();

  if (!ALLOWED.has(ticker)) {
    return Response.json({ error: `0DTE soportado solo para: ${[...ALLOWED].join(", ")}.` }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    return Response.json({ error: "expiration (YYYY-MM-DD) requerido." }, { status: 400 });
  }

  try {
    const now = new Date();
    const { trades } = await fetchTickerFlow(ticker, {
      period: "1d",
      days: 1,
      minPremium: MIN_PREMIUM,
      maxPages: MAX_PAGES,
      expirations: 2,
    });
    const { rows } = classifyFlow(trades, now);
    const reads = aggressorReads(rows, expiration);

    // Resumen de dominio: cuánta prima empuja alcista vs bajista.
    let bullish = 0, bearish = 0;
    for (const r of reads) {
      if (r.side === "mixto") continue;
      const isBull = (r.type === "call" && r.side === "compra") || (r.type === "put" && r.side === "venta");
      if (isBull) bullish += r.premium;
      else bearish += r.premium;
    }

    return Response.json({
      ticker,
      expiration,
      updatedAt: now.toISOString(),
      trades: rows.filter((r) => r.expiration === expiration).length,
      reads: reads.slice(0, 40),
      summary: { bullish, bearish },
    });
  } catch (err) {
    const message = err instanceof MarketSnackError ? err.message : "Error al consultar el flujo 0DTE.";
    return Response.json({ error: message }, { status: 502 });
  }
}
