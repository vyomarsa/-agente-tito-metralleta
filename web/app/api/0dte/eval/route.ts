// GET /api/0dte/eval?ticker=SPY — Auto-evaluación de la memoria 0DTE.
//
// Compara cada pronóstico de cierre guardado (data/0dte/{TICKER}.json) contra la
// barra diaria real de su mismo día. Devuelve error medio, sesgo y acierto de
// dirección. Al principio dirá "sin pronósticos vencidos" hasta que pase un cierre.

import { fetchDailyBars, MassiveError } from "@/lib/massive";
import { evalZeroDte, loadZeroDteJournal } from "@/lib/zerodteStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["SPY", "QQQ", "SPX", "IWM"]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  if (!ALLOWED.has(ticker)) {
    return Response.json({ error: `0DTE soportado solo para: ${[...ALLOWED].join(", ")}.` }, { status: 400 });
  }

  try {
    const journal = await loadZeroDteJournal(ticker);
    if (!journal || journal.snapshots.length === 0) {
      return Response.json({ ticker, review: null, snapshots: 0 });
    }
    const bars = await fetchDailyBars(ticker, 200).catch(() => []);
    const review = evalZeroDte(
      journal.snapshots,
      bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close })),
      new Date(),
    );
    return Response.json({ ticker, review, snapshots: journal.snapshots.length });
  } catch (err) {
    const message = err instanceof MassiveError ? err.message : "Error al evaluar la memoria 0DTE.";
    return Response.json({ error: message }, { status: 502 });
  }
}
