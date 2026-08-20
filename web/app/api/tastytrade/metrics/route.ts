// GET /api/tastytrade/metrics?symbols=AAPL,MSFT
//   → IV Rank / IV percentile REALES + liquidez, beta y earnings de Tastytrade.
//
// Nota: en sandbox (TASTYTRADE_ENV != production) estos datos suelen venir
// vacíos; el array `metrics` saldrá con pocos o ningún elemento. Para datos
// reales hace falta una OAuth Application de producción.

import { fetchMarketMetrics, TastytradeError, tastytradeConfigured } from "@/lib/tastytrade";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return Response.json({ error: "Falta el parámetro ?symbols=AAPL,MSFT" }, { status: 400 });
  }

  if (!tastytradeConfigured()) {
    return Response.json(
      { error: "Tastytrade no está configurado.", needsAuth: true },
      { status: 503 },
    );
  }

  try {
    const metrics = await fetchMarketMetrics(symbols);
    return Response.json({ metrics });
  } catch (e) {
    if (e instanceof TastytradeError) {
      return Response.json(
        { error: e.message, needsAuth: e.needsAuth ?? false },
        { status: e.status ?? 500 },
      );
    }
    const msg = e instanceof Error ? e.message : "Error desconocido";
    return Response.json({ error: msg }, { status: 500 });
  }
}
