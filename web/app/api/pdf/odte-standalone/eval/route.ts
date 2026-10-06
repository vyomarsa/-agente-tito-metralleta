// GET /api/0dte/eval?ticker=SPX — revisa los pronósticos guardados contra las
// barras intradía reales. Mide acierto y sesgo, y guarda ese sesgo para el lazo
// de auto-corrección. Ver Proceso 0DTE §10.

import { fetchIntradayBarsRangeTasty, TastytradeError } from "@/lib/pdf/odteStandalone/tastySource";
import { resolveTicker } from "@/lib/pdf/odteStandalone/zerodte";
import {
  loadEvalJournal, reviewForecasts, saveCalibration, type EvalBar,
} from "@/lib/pdf/odteStandalone/zerodteEval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const reqTicker = (searchParams.get("ticker") ?? "SPX").trim().toUpperCase();
  if (!reqTicker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  // El pronóstico se hace sobre el índice: /ES comparte su historial con SPX,
  // /NQ con NDX. La evaluación se corre sobre ese índice (barras y journal).
  const ticker = resolveTicker(reqTicker).analysis;

  const journal = await loadEvalJournal(ticker);
  if (!journal || journal.snapshots.length === 0) {
    return Response.json({
      ticker,
      empty: true,
      message: "Aún no hay pronósticos guardados para evaluar.",
    });
  }

  try {
    // Barras de ~12 días desde Tastytrade (Massive da 403 en índices como I:SPX).
    const tf = await fetchIntradayBarsRangeTasty(ticker, 12);
    const bars: EvalBar[] = tf.map((b) => ({
      time: b.time, high: b.high, low: b.low, close: b.close,
    }));
    const review = reviewForecasts(journal.snapshots, bars);

    // Guarda el sesgo para que el pronóstico se auto-corrija en la próxima carga.
    saveCalibration(ticker, review.biasPct, review.maturedCount).catch(() => {});

    return Response.json({ ticker, ...review });
  } catch (err) {
    const message =
      err instanceof TastytradeError ? err.message : "Error al cargar barras para evaluar.";
    // 200: la evaluación es secundaria, no debe romper la página.
    return Response.json({ ticker, error: message, evals: [] }, { status: 200 });
  }
}
