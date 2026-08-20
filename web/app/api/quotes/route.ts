// GET /api/quotes?tickers=AAPL,MSFT,... — cotización (last/change/%) de varios símbolos
// en una sola llamada, para el watchlist de acciones de la barra lateral.

import { fetchQuotes, MassiveError } from "@/lib/massive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = (searchParams.get("tickers") ?? "").trim();
  if (!raw) return Response.json({ error: "tickers requerido" }, { status: 400 });
  const tickers = raw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 50);
  try {
    const quotes = await fetchQuotes(tickers);
    return Response.json({ quotes });
  } catch (err) {
    const message = err instanceof MassiveError ? err.message : "Error al cargar cotizaciones.";
    return Response.json({ error: message }, { status: 502 });
  }
}
