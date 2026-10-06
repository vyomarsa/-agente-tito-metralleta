// GET /api/0dte/eval — revisa los pronósticos guardados de SPX contra las
// barras intradía reales. Mide acierto y sesgo, y lo guarda para la
// auto-corrección. Ver Proceso 0DTE §10.

import { SchwabError } from "@/lib/pdf/schwab";
import { fetchIntradayBarsRange } from "@/lib/pdf/zerodteSchwab";
import { toSchwabSymbol } from "@/lib/pdf/zerodte";
import { zeroDteTickerConfig } from "@/lib/pdf/zerodteTickers";
import {
  loadEvalJournal, reviewForecasts, saveCalibration, type EvalBar,
} from "@/lib/pdf/zerodteEval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const TICKER = zeroDteTickerConfig(searchParams.get("ticker")).underlying;
  const journal = await loadEvalJournal(TICKER);
  if (!journal || journal.snapshots.length === 0) {
    return Response.json({
      ticker: TICKER, empty: true, message: "Aún no hay pronósticos guardados para evaluar.",
    });
  }

  try {
    const tf = await fetchIntradayBarsRange(toSchwabSymbol(TICKER), 12);
    const bars: EvalBar[] = tf.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
    const review = reviewForecasts(journal.snapshots, bars);

    saveCalibration(TICKER, review.biasPct, review.maturedCount).catch(() => {});

    return Response.json({ ticker: TICKER, ...review });
  } catch (err) {
    const message = err instanceof SchwabError ? err.message : "Error al cargar barras para evaluar.";
    return Response.json({ ticker: TICKER, error: message, evals: [] }, { status: 200 });
  }
}
