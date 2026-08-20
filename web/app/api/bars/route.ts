// GET /api/bars?ticker=XXX&tf=1y|15m10d|5m5d — barras del subyacente para la gráfica de flujo.

import { fetchBars, MassiveError } from "@/lib/massive";
import { fetchPriceHistory, schwabConfigured } from "@/lib/schwab";
import type { TfBar } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TF: Record<string, { m: number; span: "day" | "minute"; days: number }> = {
  "1y": { m: 1, span: "day", days: 365 },
  "15m10d": { m: 15, span: "minute", days: 10 },
  "5m5d": { m: 5, span: "minute", days: 5 },
};

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

// Schwab entrega epoch ms; TfBar espera segundos UNIX.
async function dailyBarsFromSchwab(indexSymbol: string): Promise<TfBar[]> {
  const raw = await fetchPriceHistory(indexSymbol);
  return raw.map((b) => ({
    time: Math.floor(b.time / 1000),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const tf = searchParams.get("tf") ?? "5m5d";
  const cfg = TF[tf] ?? TF["5m5d"];
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });
  try {
    let bars = await fetchBars(ticker, cfg.m, cfg.span, cfg.days);
    // Triangulación de fuentes: si Massive no da barras diarias (típico en índices)
    // y el ticker es un índice que Schwab sí cotiza, caemos a Schwab. Schwab da velas
    // diarias, así que el fallback solo aplica al timeframe diario (1y).
    if (bars.length === 0 && cfg.span === "day" && schwabConfigured()) {
      const idx = schwabIndexSymbol(ticker);
      if (idx) {
        try {
          bars = await dailyBarsFromSchwab(idx);
        } catch {
          // Schwab sin conectar o falló → devolvemos lo que había (vacío)
        }
      }
    }
    return Response.json({ ticker, tf, bars });
  } catch (err) {
    const message = err instanceof MassiveError ? err.message : "Error al cargar barras.";
    return Response.json({ error: message }, { status: 502 });
  }
}
