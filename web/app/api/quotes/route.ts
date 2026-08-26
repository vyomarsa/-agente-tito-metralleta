// GET /api/quotes?tickers=AAPL,MSFT,... — cotización (last/change/%) de varios símbolos
// en una sola llamada, para el watchlist de acciones de la barra lateral.

import { fetchQuotes, MassiveError } from "@/lib/massive";
import { fetchTastytradeQuotes, tastytradeConfigured } from "@/lib/tastytrade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = (searchParams.get("tickers") ?? "").trim();
  if (!raw) return Response.json({ error: "tickers requerido" }, { status: 400 });
  const tickers = raw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 50);
  try {
    // Tastytrade primero: el snapshot masivo de Massive responde 403 en el plan
    // gratis (no incluye endpoints de snapshot), así que la cinta salía en "—" y
    // encima gastaba un turno de la cuota en cada sondeo.
    if (tastytradeConfigured()) {
      try {
        const tt = await fetchTastytradeQuotes(tickers);
        if (tt.size > 0) {
          const quotes = tickers.map((t) => {
            const q = tt.get(t.toUpperCase());
            return {
              ticker: t.toUpperCase(),
              price: q?.price ?? null,
              change: q?.change ?? null,
              changePercent: q?.changePercent ?? null,
            };
          });
          return Response.json({ quotes, source: "tastytrade" });
        }
      } catch {
        // sigue la cascada
      }
    }
    const quotes = await fetchQuotes(tickers);
    return Response.json({ quotes, source: "massive" });
  } catch (err) {
    const message = err instanceof MassiveError ? err.message : "Error al cargar cotizaciones.";
    return Response.json({ error: message }, { status: 502 });
  }
}
