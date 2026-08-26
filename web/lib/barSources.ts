// Cascada de fuentes para las BARRAS del subyacente. Solo servidor.
//
// Vivía dentro de `app/api/bars/route.ts`, que era su único consumidor. Se sacó
// cuando la bitácora de paper necesitó el CIERRE DEL DÍA DE VENCIMIENTO para
// liquidar las opciones vencidas a valor intrínseco: montar allí una segunda
// cascada habría dejado dos criterios distintos de "cuál es el cierre de este
// día" — el mismo error que ya se evitó extrayendo `spreadScan` y `zerodteScan`.
//
// El orden importa y está medido: Tastytrade da velas EN VIVO por el streamer y
// sin cuota; Massive gratis sirve con 15 min de retraso, a 5 peticiones/minuto y
// sin índices; Schwab es el único que cotiza los índices, y solo en diario.

import { fetchBars } from "./massive";
import { fetchTastytradeCandles, tastytradeConfigured } from "./tastytrade";
import { fetchPriceHistory, schwabConfigured } from "./schwab";
import type { TfBar } from "./types";

export const TF: Record<string, { m: number; span: "day" | "minute"; days: number }> = {
  "1y": { m: 1, span: "day", days: 365 },
  "15m10d": { m: 15, span: "minute", days: 10 },
  "5m5d": { m: 5, span: "minute", days: 5 },
};

/** Índices que Massive NO cotiza (necesitan I:SPX, fuera del plan) → Schwab los da. */
export function schwabIndexSymbol(ticker: string): string | null {
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

/** Schwab entrega epoch ms; TfBar espera segundos UNIX. */
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

/**
 * Barras de un timeframe, probando las tres fuentes.
 *
 * Schwab da velas DIARIAS, así que solo entra en el timeframe diario. Se intenta
 * siempre que Massive no traiga nada —tanto si devolvió vacío (típico en índices)
 * como si falló por cuota—; solo si Schwab tampoco puede se propaga el error de
 * Massive, que es el que trae el motivo.
 */
export async function loadTfBars(ticker: string, tf: string): Promise<TfBar[]> {
  const cfg = TF[tf] ?? TF["5m5d"];
  const index = cfg.span === "day" && schwabConfigured() ? schwabIndexSymbol(ticker) : null;
  let massiveError: unknown = null;
  let bars: TfBar[] = [];

  if (tastytradeConfigured()) {
    try {
      bars = await fetchTastytradeCandles(ticker, tf, cfg.days);
    } catch {
      // sigue la cascada
    }
  }

  if (bars.length === 0) {
    try {
      bars = await fetchBars(ticker, cfg.m, cfg.span, cfg.days);
    } catch (err) {
      massiveError = err;
    }
  }

  if (bars.length === 0 && index) {
    try {
      return await dailyBarsFromSchwab(index);
    } catch {
      // Schwab sin conectar o falló → se cae al error de Massive, si lo hubo.
    }
  }

  if (bars.length === 0 && massiveError) throw massiveError;
  return bars;
}

/**
 * Día de mercado (YYYY-MM-DD) de una barra DIARIA.
 *
 * Se formatea en UTC a propósito: las tres fuentes marcan la vela diaria a
 * medianoche (ET o UTC según cuál), y en los dos casos la fecha en UTC es la del
 * día de sesión. Convertir a hora local rompería esto en cuanto la máquina
 * viajara de huso. Verificado contra las tres el 2026-08-24.
 */
export function dailyBarDate(timeSec: number): string {
  return new Date(timeSec * 1000).toISOString().slice(0, 10);
}

/** Cierre de una fecha concreta dentro de una serie diaria. null si ese día no está. */
export function closeOnDate(bars: TfBar[], date: string): number | null {
  const bar = bars.find((b) => dailyBarDate(b.time) === date);
  return bar?.close ?? null;
}
