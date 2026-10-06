// Sub-agente de pre-market.
//
//   GET  /api/premarket           → arma el informe y lo devuelve (NO manda nada)
//   POST /api/premarket           → arma el informe y lo manda por Telegram
//
// Lo llama la tarea programada `TitoMetralleta-PreMarket` a las 9:00 ET.

import { buildPremarketReport } from "@/lib/premarketScan";
import { premarketText } from "@/lib/premarket";
import { sendAlert } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await buildPremarketReport();
    return Response.json({ report, text: premarketText(report) });
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? "Error inesperado." }, { status: 502 });
  }
}

export async function POST() {
  try {
    const report = await buildPremarketReport();
    const text = premarketText(report);
    const sent = await sendAlert(text);
    return Response.json(
      { sent: sent.ok, reason: sent.reason, tickers: report.tickers.length, chars: text.length },
      { status: sent.ok ? 200 : 502 },
    );
  } catch (e) {
    return Response.json({ error: (e as Error)?.message ?? "Error inesperado." }, { status: 502 });
  }
}
