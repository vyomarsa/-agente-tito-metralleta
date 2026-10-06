// GET /api/contract-search — "Búsqueda de contratos": los 10 mejores
// contratos de acumulación institucional real, limitados al S&P 500, por SSE.
//
// Calco de app/api/ideas/route.ts hasta el escaneo de flujo; la capa 1 de
// calidad de ese screener (isTradeableIdea/passesQualityFilter, lib/risk.ts)
// NO se reusa acá a propósito — exige MIN_DTE=7 sin techo y penaliza el theta
// alto, pensada para ideas de swing largo/LEAPS. Acá el filtro de calidad es
// el propio (single leg + volumen>OI + compra al ask + ventana 10-40 DTE, ver
// lib/contractSearch.ts), el universo se recorta al S&P 500 (lib/sp500.ts), y
// el orden final es por acumulación (lib/unusualSwing.ts → rankUnusualSwing),
// no por premium puro.

import { classifyFlow, dedupeByContract } from "@/lib/pdf/flow";
import {
  estimateTarget,
  FAVORITES_COUNT,
  isAggressiveAsk,
  isBuildingIntoOI,
  isInDteWindow,
  isSingleLeg,
  MIN_CONVICTION_PCT,
} from "@/lib/pdf/contractSearch";
import { rankUnusualSwing } from "@/lib/pdf/unusualSwing";
import { SP500_TICKERS } from "@/lib/pdf/sp500";
import { buildNewsReport, contradictionFlag, type ContradictionFlag } from "@/lib/pdf/news";
import { fetchMarketFlow, MarketSnackError } from "@/lib/pdf/marketsnack";
import { fetchCompany, MassiveError } from "@/lib/pdf/massive";
import { marketDateStr } from "@/lib/pdf/occ";
import type { ContractSearchSseEvent, FavoriteContract } from "@/app/prueba-de-fuego/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PREMIUM = 1_000_001; // > $1,000,000 (el filtro de MarketSnack es "gte")
const MAX_PAGES = 8;
const PERIOD = "1d";

function sse(event: ContractSearchSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET() {
  const encoder = new TextEncoder();
  const now = new Date();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ContractSearchSseEvent) => controller.enqueue(encoder.encode(sse(e)));

      try {
        send({ type: "step", label: "Escaneando el flujo de todo el mercado…" });

        const { trades, pages, truncated } = await fetchMarketFlow({
          period: PERIOD,
          minPremium: MIN_PREMIUM,
          maxPages: MAX_PAGES,
          onPage: (page, accumulated) => {
            send({ type: "step", label: `Página ${page} — ${accumulated} operaciones grandes` });
          },
        });

        send({ type: "step", label: `Clasificando ${trades.length} operaciones…` });
        const { rows } = classifyFlow(trades, now);

        // Mismo filtro que lib/dayTrade.ts: MarketSnack con period="1d" es una
        // ventana rolling, no el día de mercado calendario — antes de la apertura
        // (o si hoy todavía no operó nadie) seguía devolviendo trades de ayer.
        const sinceIso = `${marketDateStr(now)}T00:00:00Z`;
        const sinceMs = Date.parse(sinceIso);
        const todaysRows = rows.filter((r) => Date.parse(r.timestamp) >= sinceMs);

        send({ type: "step", label: "Recortando al S&P 500 y aplicando el criterio de acumulación…" });
        const sp500Rows = dedupeByContract(todaysRows).filter((r) => SP500_TICKERS.has(r.underlying));
        const candidates = sp500Rows
          .filter((r) => isSingleLeg(r))
          .filter((r) => isBuildingIntoOI(r))
          .filter((r) => isAggressiveAsk(r))
          .filter((r) => isInDteWindow(r));

        send({ type: "step", label: "Calculando targets y convicción…" });
        const tradeable = candidates.filter((r) => {
          const { convictionPct1 } = estimateTarget(r, null);
          return convictionPct1 != null && convictionPct1 > MIN_CONVICTION_PCT;
        });

        send({ type: "step", label: "Ordenando por acumulación (volumen sobre Open Interest)…" });
        const top = rankUnusualSwing(tradeable).slice(0, FAVORITES_COUNT);

        send({ type: "step", label: `Buscando precio y nombre de ${top.length} empresas…` });
        const companies = new Map<string, { price: number | null; name: string | null }>();
        await Promise.all(
          [...new Set(top.map((r) => r.underlying))].map(async (ticker) => {
            try {
              const company = await fetchCompany(ticker);
              companies.set(ticker, { price: company.price, name: company.name });
            } catch {
              companies.set(ticker, { price: null, name: null });
            }
          }),
        );

        // Catalizador de noticias — solo informativo, best-effort: si falla para
        // algún finalista, ese candidato queda sin bandera, no rompe el escaneo.
        send({ type: "step", label: `Chequeando catalizador de noticias de ${top.length} finalistas…` });
        const newsFlags = new Map<string, ContradictionFlag | null>();
        await Promise.all(
          top.map(async (r) => {
            if (r.type !== "call" && r.type !== "put") return;
            try {
              const companyName = companies.get(r.underlying)?.name ?? null;
              const report = await buildNewsReport(r.underlying, companyName, now);
              newsFlags.set(r.symbol, contradictionFlag(r.type === "call" ? "bullish" : "bearish", report.bias));
            } catch {
              newsFlags.set(r.symbol, null);
            }
          }),
        );

        const favorites: FavoriteContract[] = top.map((r) => {
          const info = companies.get(r.underlying);
          const liveSpot = info?.price ?? r.assetPrice;
          const projection = estimateTarget(r, liveSpot);
          return {
            ticker: r.underlying,
            companyName: info?.name ?? null,
            symbol: r.symbol,
            type: r.type === "unknown" ? "call" : r.type,
            strike: r.strike,
            expiration: r.expiration,
            dte: r.dte,
            premium: r.premium,
            size: r.size,
            volume: r.volume,
            openInterest: r.openInterest,
            delta: r.delta,
            assetPrice: liveSpot ?? r.assetPrice,
            ...projection,
            timestamp: r.timestamp,
            newsFlag: newsFlags.get(r.symbol) ?? null,
          };
        });

        send({ type: "done", favorites, meta: { scanned: trades.length, pages, truncated } });
      } catch (err) {
        const message =
          err instanceof MarketSnackError || err instanceof MassiveError
            ? err.message
            : "Error inesperado al buscar contratos.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
