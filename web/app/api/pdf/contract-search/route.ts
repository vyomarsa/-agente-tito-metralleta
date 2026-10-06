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
import { SP500 } from "@/lib/pdf/sp500";
import { CONTRACT_SEARCH_UNIVERSE, fetchUniverseFlow } from "@/lib/pdf/contractSearchTasty";
import { TastytradeError } from "@/lib/tastytrade";
import { buildNewsReport, contradictionFlag, type ContradictionFlag } from "@/lib/pdf/news";
import type { ContractSearchSseEvent, FavoriteContract } from "@/app/prueba-de-fuego/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PREMIUM = 1_000_001; // > $1,000,000

/** Nombre para mostrar: S&P 500 (lib/sp500.json) o los ETF del universo. */
const NAMES = new Map<string, string>([
  ...SP500.map((c) => [c.ticker, c.name] as [string, string]),
  ["SPY", "SPDR S&P 500 ETF"],
  ["QQQ", "Invesco QQQ (Nasdaq-100)"],
]);

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
        // Flujo desde Tastytrade (oct 2026, antes MarketSnack con todo el mercado):
        // Tastytrade no tiene feed de todo el mercado, así que se escanea la lista
        // fija del dueño (14 de Grandes empresas + SPY y QQQ), solo el día de HOY.
        const { trades, spots, failed, truncated } = await fetchUniverseFlow({
          minPremium: MIN_PREMIUM,
          now,
          onTicker: (ticker, i, total, found) => {
            send({ type: "step", label: `Escaneando ${ticker} (${i}/${total}) — ${found} operaciones grandes` });
          },
        });
        if (trades.length === 0 && failed.length === CONTRACT_SEARCH_UNIVERSE.length) {
          throw new TastytradeError("Tastytrade no respondió para ningún ticker del universo.");
        }

        send({ type: "step", label: `Clasificando ${trades.length} operaciones…` });
        const { rows } = classifyFlow(trades, now);
        const todaysRows = rows;

        send({ type: "step", label: "Aplicando el criterio de acumulación…" });
        const universeRows = dedupeByContract(todaysRows);
        const candidates = universeRows
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

        // Precio en vivo (mid del streamer, ya pedido en el escaneo) y nombre.
        const companies = new Map<string, { price: number | null; name: string | null }>(
          [...new Set(top.map((r) => r.underlying))].map((t) => [t, { price: spots.get(t) ?? null, name: NAMES.get(t) ?? null }]),
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

        send({ type: "done", favorites, meta: { scanned: trades.length, pages: CONTRACT_SEARCH_UNIVERSE.length - failed.length, truncated: truncated > 0 } });
      } catch (err) {
        const message =
          err instanceof TastytradeError
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
