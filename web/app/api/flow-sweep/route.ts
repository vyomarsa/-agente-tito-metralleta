// POST /api/flow-sweep — barrido del flujo del universo con Tastytrade.
//
// Es lo que sustituye al "flujo de todo el mercado" de MarketSnack: su streamer no
// tiene un feed de mercado, así que hay que recorrer los símbolos uno a uno (ver
// `lib/marketFlow`). Son minutos, no una petición de pantalla — por eso lo dispara
// la tarea `TitoMetralleta-Barrido-Flujo` tras el cierre y las rutas (/ideas, el
// piloto swing, el put/call del Pulso) leen la foto guardada.
//
// GET devuelve el estado de la última foto, para la pantalla de Ajustes.

import { loadMarketFlow, snapshotAgeHours, sweepMarketFlow, MARKET_FLOW_UNIVERSE } from "@/lib/marketFlow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Un barrido completo son minutos: Next debe dejarlo terminar. */
export const maxDuration = 900;

export async function GET() {
  const snap = await loadMarketFlow();
  return Response.json({
    ok: true,
    universo: MARKET_FLOW_UNIVERSE.length,
    foto: snap
      ? {
          updatedAt: snap.updatedAt,
          horas: Math.round((snapshotAgeHours(snap) ?? 0) * 10) / 10,
          operaciones: snap.trades.length,
          escaneados: snap.scanned,
          fallidos: snap.failed.length,
          minPremium: snap.minPremium,
          dias: snap.days,
        }
      : null,
  });
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Number(searchParams.get("days") ?? 1);
  const minPremium = Number(searchParams.get("minPremium") ?? 100_000);
  const concurrency = Number(searchParams.get("concurrency") ?? 3);
  // Para probar sin esperar los 102: ?tickers=SPY,NVDA
  const lista = (searchParams.get("tickers") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const t0 = Date.now();
  try {
    const snap = await sweepMarketFlow({
      tickers: lista.length > 0 ? lista : undefined,
      days: Number.isFinite(days) && days > 0 ? days : 1,
      minPremium: Number.isFinite(minPremium) ? minPremium : 100_000,
      concurrency: Number.isFinite(concurrency) ? concurrency : 3,
    });
    return Response.json({
      ok: true,
      ms: Date.now() - t0,
      escaneados: snap.scanned,
      universo: snap.universe,
      fallidos: snap.failed,
      operaciones: snap.trades.length,
      updatedAt: snap.updatedAt,
    });
  } catch (e) {
    return Response.json(
      { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : "Fallo el barrido." },
      { status: 502 },
    );
  }
}
