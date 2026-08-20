// GET /api/schwab/greeks?ticker=AAPL
//
// Devuelve un mapa { "strike|expiration|type": { gamma, iv } } con los greeks
// REALES de Schwab, listo para inyectar en gexAnalysis/gexHeatmap y sustituir la
// estimación Black-Scholes. La IV se normaliza a DECIMAL (Schwab la da en %).
//
// Degrada con gracia: si Schwab no está conectado o falla, responde
// { connected:false, greeks:{} } con HTTP 200 para que el dashboard siga
// funcionando con la estimación de siempre (nunca rompe la vista principal).

import { fetchOptionChain, schwabConfigured, SchwabError } from "@/lib/schwab";
import { schwabStatus } from "@/lib/schwab";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  if (!schwabConfigured()) {
    return Response.json({ connected: false, greeks: {} });
  }

  const status = await schwabStatus();
  if (!status.connected) {
    return Response.json({ connected: false, greeks: {} });
  }

  try {
    const { underlyingPrice, contracts } = await fetchOptionChain(ticker);
    const greeks: Record<string, { gamma: number; iv: number }> = {};
    let count = 0;
    for (const c of contracts) {
      // Solo sirve el contrato si trae al menos gamma o IV utilizables.
      const gamma = c.gamma != null && c.gamma > 0 ? c.gamma : null;
      const iv = c.iv != null && c.iv > 0 ? c.iv / 100 : null; // % → decimal
      if (gamma == null && iv == null) continue;
      if (!c.expiration) continue;
      greeks[`${c.strike}|${c.expiration}|${c.contractType}`] = {
        gamma: gamma ?? 0,
        iv: iv ?? 0,
      };
      count += 1;
    }
    return Response.json({
      connected: true,
      ticker,
      underlyingPrice: underlyingPrice ?? null,
      count,
      greeks,
    });
  } catch (e) {
    // No rompemos el dashboard: si Schwab falla, se sigue con la estimación.
    const needsAuth = e instanceof SchwabError ? Boolean(e.needsAuth) : false;
    return Response.json({ connected: false, needsAuth, greeks: {} });
  }
}
