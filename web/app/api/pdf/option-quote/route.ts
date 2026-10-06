// GET /api/option-quote?underlying=TSLA&symbol=<OCC> — quote en vivo de UN
// contrato, para el polling de P/L del day-trading (no SSE: es JSON simple,
// se llama cada ~20s desde el cliente).

import { fetchOptionQuote, MassiveError } from "@/lib/pdf/massive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const underlying = (searchParams.get("underlying") ?? "").trim().toUpperCase();
  const symbol = (searchParams.get("symbol") ?? "").trim();
  if (!underlying || !symbol) {
    return Response.json({ error: "underlying y symbol son requeridos" }, { status: 400 });
  }
  try {
    const quote = await fetchOptionQuote(underlying, symbol);
    if (!quote) {
      return Response.json({ error: `Sin quote en vivo para ${symbol}.` }, { status: 404 });
    }
    return Response.json({ quote });
  } catch (err) {
    const message = err instanceof MassiveError ? err.message : "Error al leer el quote del contrato.";
    return Response.json({ error: message }, { status: 502 });
  }
}
