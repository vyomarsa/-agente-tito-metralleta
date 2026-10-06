// GET /api/btc?tf=4h — pestaña BTC de Prueba de Fuego. BTC no tiene flujo de
// opciones en este proyecto, así que a diferencia del resto del motor esto es
// puro precio/volumen: velas + zonas de liquidez (lib/levels.ts, sin cadena de
// opciones) + VWAP/MACD + Ondas de Elliott (lib/btcElliottWave.ts) +
// Momentum/Volumen/MACD/VWAP con el contexto de Elliott (lib/btcMomentum.ts).
// BTC opera 24/7 — sin gating de horario de mercado.

import { fetchBars } from "@/lib/pdf/massive";
import { fetchCryptoQuote } from "@/lib/pdf/tastytrade";
import { aggregateHourlyBars } from "@/lib/pdf/timeframeBars";
import { btcTimeframeConfig, DEFAULT_BTC_TIMEFRAME } from "@/lib/pdf/btcTimeframes";
import { findLevels } from "@/lib/pdf/levels";
import { computeMacd, computeVwap } from "@/lib/pdf/technicalIndicators";
import { elliottWaveSignal } from "@/lib/pdf/btcElliottWave";
import { btcMomentumSignal } from "@/lib/pdf/btcMomentum";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BTC_TICKER = "X:BTCUSD";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tf = btcTimeframeConfig(searchParams.get("tf") ?? DEFAULT_BTC_TIMEFRAME);
  const now = new Date();

  try {
    const [raw, liveSpot] = await Promise.all([
      fetchBars(BTC_TICKER, tf.multiplier, tf.timespan, tf.days),
      fetchCryptoQuote("BTC/USD").catch(() => null),
    ]);
    const bars = tf.aggregateHours ? aggregateHourlyBars(raw, tf.aggregateHours) : raw;
    if (bars.length === 0) {
      return Response.json({ error: "Sin datos de BTC en esta temporalidad ahora mismo." }, { status: 502 });
    }

    // Precio en vivo de tastytrade (sin el delay de horas de la cadena de
    // aggs de Massive para cripto); si falla, cae al cierre de la última vela.
    const spot = liveSpot ?? bars[bars.length - 1].close;
    const levels = findLevels({
      bars: bars.map((b) => ({ time: new Date(b.time * 1000).toISOString().slice(0, 10), high: b.high, low: b.low, close: b.close })),
      spot,
      now,
    });

    const vwap = computeVwap(bars);
    const macd = computeMacd(bars);

    const elliottWave = elliottWaveSignal(bars);
    const momentumSignal = btcMomentumSignal(bars, levels, elliottWave);

    return Response.json({
      timeframe: tf.id,
      asOf: now.toISOString(),
      bars,
      spot,
      levels,
      vwap,
      macd,
      elliottWave,
      momentumSignal,
    });
  } catch {
    return Response.json({ error: "Error inesperado calculando el análisis de BTC." }, { status: 502 });
  }
}
