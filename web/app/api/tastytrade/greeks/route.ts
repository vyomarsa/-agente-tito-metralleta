// GET /api/tastytrade/greeks?ticker=AAPL
//
// Greeks REALES (gamma/IV + delta/bid/ask/OI) por el streamer DXLink de
// Tastytrade, en el mismo formato { "strike|expiration|type": {gamma, iv} } que
// /api/{marketsnack,schwab}/greeks, para inyectar en gexAnalysis/gexHeatmap.
//
// Es la PRIMERA opción de la cascada de greeks (Tastytrade → MarketSnack →
// Schwab). Degrada con gracia: si no está configurado o el streamer falla,
// responde { connected:false, greeks:{} } con HTTP 200 y el dashboard sigue con
// la siguiente fuente.

import { fetchTastytradeGreeks, tastytradeConfigured, TastytradeError } from "@/lib/tastytrade";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  if (!tastytradeConfigured()) {
    return Response.json({ connected: false, greeks: {} });
  }

  try {
    const greeks = await fetchTastytradeGreeks(ticker);
    return Response.json({
      connected: true,
      ticker,
      count: Object.keys(greeks).length,
      greeks,
    });
  } catch (e) {
    // No rompemos el dashboard: si Tastytrade falla, se sigue con MarketSnack/Schwab.
    const message = e instanceof TastytradeError ? e.message : "error";
    return Response.json({ connected: false, message, greeks: {} });
  }
}
