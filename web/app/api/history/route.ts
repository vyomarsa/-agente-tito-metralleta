// GET /api/history?ticker=XXX — barras diarias del subyacente para la gráfica.

import { fetchDailyBars, MassiveError } from "@/lib/massive";
import { fetchPriceHistory, schwabConfigured } from "@/lib/schwab";
import type { DailyBar } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Índices que Massive NO cotiza (necesitan I:SPX, fuera del plan) → Schwab los da.
function schwabIndexSymbol(ticker: string): string | null {
  const map: Record<string, string> = {
    SPX: "$SPX",
    NDX: "$NDX",
    RUT: "$RUT",
    VIX: "$VIX",
    DJI: "$DJI",
  };
  const clean = ticker.startsWith("$") ? ticker.slice(1) : ticker;
  return map[clean] ?? null;
}

// Schwab entrega epoch ms; la gráfica espera DailyBar con fecha YYYY-MM-DD.
async function barsFromSchwab(indexSymbol: string): Promise<DailyBar[]> {
  const raw = await fetchPriceHistory(indexSymbol);
  return raw.map((b) => ({
    time: new Date(b.time).toISOString().slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) {
    return Response.json({ error: "ticker requerido" }, { status: 400 });
  }
  try {
    let bars = await fetchDailyBars(ticker);
    // Triangulación de fuentes: si Massive no da velas (típico en índices) y el
    // ticker es un índice que Schwab sí cotiza, caemos a Schwab.
    if (bars.length === 0 && schwabConfigured()) {
      const idx = schwabIndexSymbol(ticker);
      if (idx) {
        try {
          bars = await barsFromSchwab(idx);
        } catch {
          // Schwab sin conectar o falló → devolvemos lo que había (vacío)
        }
      }
    }
    return Response.json({ ticker, bars });
  } catch (err) {
    const message = err instanceof MassiveError ? err.message : "Error al cargar histórico.";
    return Response.json({ error: message }, { status: 502 });
  }
}
