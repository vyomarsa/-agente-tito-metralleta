// GET /api/bars?ticker=XXX&tf=1y|15m10d|5m5d — barras del subyacente para la gráfica de flujo.
//
// La cascada de fuentes vive en `lib/barSources.ts` desde que la bitácora de paper
// también necesita barras (para liquidar a valor intrínseco lo que vence). Aquí solo
// queda la cache y el manejo de errores de la ruta.

import { loadTfBars, TF } from "@/lib/barSources";
import { cachedTfBars } from "@/lib/barsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  // Un tf desconocido cae al intradía corto, como siempre: la gráfica prefiere
  // enseñar algo a romperse porque llegó un parámetro raro.
  const pedido = searchParams.get("tf") ?? "5m5d";
  const tf = TF[pedido] ? pedido : "5m5d";
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  const res = await cachedTfBars(ticker, tf, () => loadTfBars(ticker, tf));

  // Sin barras Y con motivo: se devuelve el motivo, no un 200 con lista vacía.
  // Ese 200 mudo era justo lo que dejaba la gráfica en blanco sin explicación.
  if (res.bars.length === 0 && res.error) {
    const rateLimited = res.retryAfterMs != null;
    return Response.json(
      { ticker, tf, bars: [], error: res.error, retryAfterMs: res.retryAfterMs ?? null },
      { status: rateLimited ? 429 : 502 },
    );
  }

  return Response.json({
    ticker,
    tf,
    bars: res.bars,
    stale: res.stale,
    ageMs: res.ageMs,
    // Barras viejas servidas por falta de cuota: la UI debe poder decirlo.
    ...(res.stale ? { warning: res.error, retryAfterMs: res.retryAfterMs ?? null } : {}),
  });
}
