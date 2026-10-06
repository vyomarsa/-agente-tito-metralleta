// GET /api/0dte/bars — barras intradía (5 min) de SPX para el chart. Fuente:
// Schwab pricehistory (Massive no autoriza índices).

import { SchwabError } from "@/lib/pdf/schwab";
import { fetchIntradayBars } from "@/lib/pdf/zerodteSchwab";
import { toSchwabSymbol } from "@/lib/pdf/zerodte";
import { zeroDteTickerConfig } from "@/lib/pdf/zerodteTickers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const TICKER = zeroDteTickerConfig(searchParams.get("ticker")).underlying;

  try {
    const bars = await fetchIntradayBars(toSchwabSymbol(TICKER));
    return Response.json({ ticker: TICKER, bars });
  } catch (err) {
    const message = err instanceof SchwabError ? err.message : "Error al cargar barras.";
    // 200: el chart es secundario; la tabla no depende de esto.
    return Response.json({ ticker: TICKER, error: message, bars: [] }, { status: 200 });
  }
}
