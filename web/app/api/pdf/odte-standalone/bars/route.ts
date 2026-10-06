// GET /api/0dte/bars?ticker=SPX — barras intradía (5 min) del subyacente para
// el chart. Fuente: velas DXLink de Tastytrade (Massive no autoriza indices).

import { fetchIntradayBarsTasty, TastytradeError } from "@/lib/pdf/odteStandalone/tastySource";
import { resolveTicker } from "@/lib/pdf/odteStandalone/zerodte";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPX").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  // Para futuros el chart toma velas del índice (SPX/NDX); el cliente las
  // desplaza por el basis en vivo junto con los niveles, así todo cuadra.
  const analysis = resolveTicker(ticker).analysis;

  try {
    const bars = await fetchIntradayBarsTasty(analysis);
    return Response.json({ ticker, bars });
  } catch (err) {
    const message =
      err instanceof TastytradeError ? err.message : "Error al cargar barras.";
    // 200: el chart es secundario; la tabla no depende de esto.
    return Response.json({ ticker, error: message, bars: [] }, { status: 200 });
  }
}
