// GET /api/schwab/chain?ticker=AAPL[&type=ALL|CALL|PUT][&strikes=20][&from=YYYY-MM-DD][&to=YYYY-MM-DD]
//
// Devuelve la cadena de opciones de Schwab con lo que Massive NO da:
// greeks (delta/gamma/theta/vega), IV, Open Interest y bid/ask en una sola llamada.

import { fetchOptionChain, SchwabError } from "@/lib/schwab";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  const typeParam = (searchParams.get("type") ?? "ALL").toUpperCase();
  const contractType =
    typeParam === "CALL" || typeParam === "PUT" ? typeParam : "ALL";
  const strikes = Number(searchParams.get("strikes"));
  const from = searchParams.get("from") ?? undefined;
  const to = searchParams.get("to") ?? undefined;

  try {
    const result = await fetchOptionChain(ticker, {
      contractType,
      strikeCount: Number.isFinite(strikes) && strikes > 0 ? strikes : undefined,
      fromDate: from,
      toDate: to,
    });
    // Ordena por Open Interest desc (igual que la tabla principal de Massive).
    result.contracts.sort((a, b) => b.openInterest - a.openInterest);
    return Response.json(result);
  } catch (e) {
    if (e instanceof SchwabError) {
      return Response.json(
        { error: e.message, needsAuth: Boolean(e.needsAuth) },
        { status: e.needsAuth ? 401 : e.status ?? 502 },
      );
    }
    return Response.json({ error: "Error consultando Schwab." }, { status: 502 });
  }
}
