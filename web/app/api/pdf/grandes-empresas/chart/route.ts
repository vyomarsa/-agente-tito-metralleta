// GET /api/grandes-empresas/chart?ticker=AAPL&tf=1h — selector de temporalidad
// de "Grandes empresas" (ago 2026, pedido explícito: semanal/diario/
// 4h/1h/15m/5m). Endpoint LIVIANO a propósito: separado de
// app/api/grandes-empresas/route.ts (que además calcula señal, imán GEX y
// sugerencias de spreads — recalcular todo eso solo para cambiar de
// temporalidad de la gráfica sería tirar trabajo). El tf por defecto ("15m")
// sigue resolviéndose con la ruta principal (bars/premarketWindows/rejections
// ya calculados ahí, con la vela sintética de HOY pegada al final) — este
// endpoint solo entra en juego cuando el usuario elige una temporalidad distinta.

import { fetchQuoteToken, TastytradeError } from "@/lib/tastytrade";
import { chartTimeframeConfig, type ChartTimeframeId } from "@/lib/pdf/timeframeBars";
import { GRANDES_EMPRESAS_TICKERS, DEFAULT_GRANDES_EMPRESA } from "@/lib/pdf/grandesEmpresas";
import { SP500_TICKERS } from "@/lib/pdf/sp500";

// Velas desde Tastytrade (DXLink Candle, oct 2026 — antes Massive, que en este
// plan llega con ~1 día de atraso). 4h igual que TradingView: solo horario
// regular y alineada a la sesión (mismo criterio que lib/tastytrade de Tito).
const DX_PERIOD: Record<ChartTimeframeId, string> = {
  "1w": "w",
  "1d": "d",
  "4h": "4h,tho=true,a=s",
  "1h": "1h",
  "15m": "15m",
  "5m": "5m",
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("ticker") ?? DEFAULT_GRANDES_EMPRESA).trim().toUpperCase();
  const TICKER =
    GRANDES_EMPRESAS_TICKERS.has(requested) || SP500_TICKERS.has(requested) ? requested : DEFAULT_GRANDES_EMPRESA;
  const tf = chartTimeframeConfig(searchParams.get("tf") ?? "");

  try {
    const tok = await fetchQuoteToken();
    const { dxlinkCandles } = await import("@/lib/tastytradeStream");
    const velas = await dxlinkCandles({
      url: tok.url,
      token: tok.token,
      symbol: `${TICKER.replace("BRKB", "BRK/B")}{=${DX_PERIOD[tf.id]}}`,
      fromTime: Date.now() - tf.days * 24 * 60 * 60 * 1000,
    });
    const bars = velas
      .filter((v) => Number.isFinite(v.open) && v.open > 0)
      .map((v) => ({ time: Math.floor(v.time / 1000), open: v.open, high: v.high, low: v.low, close: v.close }))
      .sort((a, b) => a.time - b.time);
    if (bars.length === 0) {
      return Response.json({ error: `Sin datos de ${TICKER} en esa temporalidad ahora mismo.` }, { status: 502 });
    }
    return Response.json({ ticker: TICKER, tf: tf.id, bars });
  } catch (err) {
    const message = err instanceof TastytradeError ? err.message : "Error inesperado cargando la gráfica.";
    return Response.json({ error: message }, { status: 502 });
  }
}
