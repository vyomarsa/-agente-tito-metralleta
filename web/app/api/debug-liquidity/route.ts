// TEMPORAL — diagnóstico de liquidez del bid-ask por banda de delta. BORRAR luego.
// GET /api/_debug-liquidity?tickers=WMT,PLTR,ORCL,AAPL,LLY,NVDA
// Muestra, para el weekly del frente (3–10 DTE), los contratos en Δ0.10–0.19 con
// su mid, bid-ask absoluto y bid-ask relativo (% del mid). Sirve para comparar
// el criterio $0.05 absoluto contra un criterio relativo en nombres caros/baratos.

import { fetchExpirations, fetchOptionChain2 } from "@/lib/marketsnack";
import { normalizeChain2, expirationsInDteWindow, dteOf } from "@/lib/optionChain2";
import { fetchCompany } from "@/lib/massive";
import { DTE_MIN, DTE_MAX, ELIG_SPREAD_DELTA_MIN, ELIG_SPREAD_DELTA_MAX } from "@/lib/creditSpread";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tickers = (url.searchParams.get("tickers") ?? "WMT,PLTR,ORCL,UBER,AAPL,LLY,NVDA")
    .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  const now = new Date();

  const rows = [];
  for (const ticker of tickers) {
    try {
      const exps = await fetchExpirations(ticker);
      const dates = expirationsInDteWindow(exps.map((e) => e.date), DTE_MIN, DTE_MAX, now);
      if (dates.length === 0) { rows.push({ ticker, error: "sin weekly 3–10 DTE" }); continue; }
      const front = dates[0];
      const contracts = normalizeChain2(await fetchOptionChain2(ticker, front));
      const company = await fetchCompany(ticker).catch(() => null);
      const spot = company?.price ?? null;

      const band = contracts
        .filter((c) => {
          const d = Math.abs(c.delta ?? 0);
          return d >= ELIG_SPREAD_DELTA_MIN - 1e-6 && d <= ELIG_SPREAD_DELTA_MAX + 1e-6 && c.bid != null && c.ask != null;
        })
        .map((c) => {
          const bid = c.bid!, ask = c.ask!;
          const mid = (bid + ask) / 2;
          const absSpread = ask - bid;
          const relPct = mid > 0 ? (absSpread / mid) * 100 : null;
          return {
            type: c.type, strike: c.strike, delta: c.delta,
            bid, ask, mid: +mid.toFixed(2),
            absSpread: +absSpread.toFixed(2),
            relPct: relPct != null ? +relPct.toFixed(1) : null,
          };
        })
        .sort((a, b) => a.strike - b.strike);

      rows.push({
        ticker,
        spot,
        front,
        dte: dteOf(front, now),
        bandCount: band.length,
        medianAbsSpread: median(band.map((b) => b.absSpread)),
        medianRelPct: median(band.map((b) => b.relPct!).filter((x) => x != null)),
        contracts: band,
      });
    } catch (e) {
      rows.push({ ticker, error: e instanceof Error ? e.message.slice(0, 80) : "error" });
    }
  }

  return Response.json({ band: `Δ${ELIG_SPREAD_DELTA_MIN}–${ELIG_SPREAD_DELTA_MAX}`, rows });
}
