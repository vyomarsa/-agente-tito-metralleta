// GET /api/marketsnack/greeks?ticker=AAPL
//
// Devuelve un mapa { "strike|expiration|type": { gamma, iv } } con los greeks
// REALES de MarketSnack (Option Chain 2.0), listo para inyectar en
// gexAnalysis/gexHeatmap y sustituir la estimación Black-Scholes. La IV ya viene
// en DECIMAL desde MarketSnack (0.168 = 16.8%), no hace falta convertir.
//
// A diferencia de Schwab (una sola llamada por ticker), MarketSnack pagina la
// cadena por vencimiento, así que se piden los N vencimientos más cercanos y se
// funden en un solo mapa. Degrada con gracia: si la cookie caducó o algo falla,
// responde { connected:false, greeks:{} } con HTTP 200 para que el dashboard siga
// con la estimación de siempre (nunca rompe la vista principal).

import {
  fetchExpirations,
  fetchOptionChain2,
  MarketSnackError,
} from "@/lib/marketsnack";
import { marketsnackConfigured } from "@/lib/marketsnackCookie";
import {
  normalizeChain2,
  nearestExpirations,
  realGreeksMap,
  type RealGreek,
} from "@/lib/optionChain2";

export const runtime = "nodejs";

/** Cuántos vencimientos cercanos se funden (los mismos 8 del heatmap de GEX). */
const MAX_EXPIRATIONS = 8;
/** Peticiones de cadena en vuelo a la vez (una por vencimiento). */
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  if (!(await marketsnackConfigured())) {
    return Response.json({ connected: false, greeks: {} });
  }

  try {
    const now = new Date();
    const expirations = await fetchExpirations(ticker);
    const dates = nearestExpirations(expirations.map((e) => e.date), MAX_EXPIRATIONS, now);
    if (dates.length === 0) {
      return Response.json({ connected: true, ticker, count: 0, greeks: {} });
    }

    const chains = await mapLimit(dates, CONCURRENCY, async (date) => {
      try {
        return normalizeChain2(await fetchOptionChain2(ticker, date));
      } catch {
        return [];
      }
    });

    const greeks: Record<string, RealGreek> = {};
    for (const contracts of chains) {
      Object.assign(greeks, realGreeksMap(contracts));
    }

    return Response.json({
      connected: true,
      ticker,
      count: Object.keys(greeks).length,
      greeks,
    });
  } catch (e) {
    // No rompemos el dashboard: si MarketSnack falla, se sigue con la estimación.
    const message = e instanceof MarketSnackError ? e.message : "error";
    return Response.json({ connected: false, message, greeks: {} });
  }
}
