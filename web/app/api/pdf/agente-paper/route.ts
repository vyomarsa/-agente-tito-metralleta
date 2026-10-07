// GET /api/pdf/agente-paper — estado de la cuenta paper del Agente Prueba de
// Fuego (resumen, abiertas, cerradas, límite diario). Solo lectura: quien abre y
// cierra es scripts/pdf-alerts/paper-tick.ts, cada minuto de sesión. Mismo shape
// que /api/0dte-paper para que Mis Trades lo pinte con el mismo panel.

import { MAX_PERDIDAS_DIA, perdidasDelDia, pnlDelDia, summarize } from "@/lib/zerodtePaper";
import { AGENT_PAPER_TICKER, loadClosed, loadOpen } from "@/lib/pdf/agentPaper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);
    const now = new Date();
    const perdidas = perdidasDelDia(closed, now);
    return Response.json({
      ticker: AGENT_PAPER_TICKER,
      summary: summarize(closed, open),
      limiteDiario: {
        perdidas,
        tope: MAX_PERDIDAS_DIA,
        alcanzado: perdidas >= MAX_PERDIDAS_DIA,
        pnlHoy: pnlDelDia(closed, now),
      },
      open,
      closed: [...closed].sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")).slice(0, 100),
    });
  } catch {
    return Response.json({ error: "No se pudo leer la cuenta paper del Agente Prueba de Fuego." }, { status: 500 });
  }
}
