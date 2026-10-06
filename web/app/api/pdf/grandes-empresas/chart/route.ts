// GET /api/grandes-empresas/chart?ticker=AAPL&tf=1h — selector de temporalidad
// de "Grandes empresas" (ago 2026, pedido explícito: semanal/diario/
// 4h/1h/15m/5m). Endpoint LIVIANO a propósito: separado de
// app/api/grandes-empresas/route.ts (que además calcula señal, imán GEX y
// sugerencias de spreads — recalcular todo eso solo para cambiar de
// temporalidad de la gráfica sería tirar trabajo). El tf por defecto ("15m")
// sigue resolviéndose con la ruta principal (bars/premarketWindows/rejections
// ya calculados ahí, con la vela sintética de HOY pegada al final) — este
// endpoint solo entra en juego cuando el usuario elige una temporalidad distinta.

import { fetchBars, MassiveError } from "@/lib/pdf/massive";
import { aggregateHourlyBars, chartTimeframeConfig } from "@/lib/pdf/timeframeBars";
import { GRANDES_EMPRESAS_TICKERS, DEFAULT_GRANDES_EMPRESA } from "@/lib/pdf/grandesEmpresas";
import { SP500_TICKERS } from "@/lib/pdf/sp500";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("ticker") ?? DEFAULT_GRANDES_EMPRESA).trim().toUpperCase();
  const TICKER =
    GRANDES_EMPRESAS_TICKERS.has(requested) || SP500_TICKERS.has(requested) ? requested : DEFAULT_GRANDES_EMPRESA;
  const tf = chartTimeframeConfig(searchParams.get("tf") ?? "");

  try {
    const raw = await fetchBars(TICKER, tf.multiplier, tf.timespan, tf.days);
    const bars = tf.aggregateHours ? aggregateHourlyBars(raw, tf.aggregateHours) : raw;
    if (bars.length === 0) {
      return Response.json({ error: `Sin datos de ${TICKER} en esa temporalidad ahora mismo.` }, { status: 502 });
    }
    return Response.json({ ticker: TICKER, tf: tf.id, bars });
  } catch (err) {
    const message = err instanceof MassiveError ? err.message : "Error inesperado cargando la gráfica.";
    return Response.json({ error: message }, { status: 502 });
  }
}
