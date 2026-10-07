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
import { SP500, SP500_TICKERS } from "@/lib/pdf/sp500";
import { CONTRACT_SEARCH_UNIVERSE, fetchUniverseFlow } from "@/lib/pdf/contractSearchTasty";
import { fetchMarketFlow, MarketSnackError } from "@/lib/pdf/marketsnack";
import { marketDateStr } from "@/lib/pdf/occ";
import { fetchTastytradeQuotes, TastytradeError } from "@/lib/tastytrade";
import type { RawTrade } from "@/lib/pdf/flow";
import { buildNewsReport, contradictionFlag, type ContradictionFlag } from "@/lib/pdf/news";
import type { ContractSearchSseEvent, FavoriteContract } from "@/app/prueba-de-fuego/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PREMIUM = 1_000_001; // > $1,000,000 (el filtro de MarketSnack es "gte")
/** MarketSnack pagina de lo más reciente hacia atrás (50 por página): 30 páginas
 *  cubren ~media sesión (medido 2026-10-06: de 12:11 ET al cierre). */
const MS_MAX_PAGES = 30;

/** Tickers fijos que escanea Tastytrade (día COMPLETO) — de MarketSnack se toma el resto. */
const TT_UNIVERSE = new Set(CONTRACT_SEARCH_UNIVERSE);
/** Lo que aporta MarketSnack: el resto del S&P 500 (+ SPY/QQQ si Tastytrade falla). */
const MS_UNIVERSE = new Set([...SP500_TICKERS, "SPY", "QQQ"]);

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
        // DOS fuentes en paralelo y se combinan:
        //  · Tastytrade: los 16 tickers fijos del dueño (14 de Grandes empresas +
        //    SPY/QQQ), con el Time & Sales del día COMPLETO.
        //  · MarketSnack: flujo de TODO el mercado, para el resto del S&P 500. Solo
        //    alcanza ~media sesión (pagina hacia atrás) y se descartan sus trades de
        //    los 16 tickers para no contar dos veces la misma operación.
        // Si una de las dos falla, se sigue con la otra.
        send({ type: "step", label: "Escaneando Tastytrade (16 tickers) y MarketSnack (todo el mercado) en paralelo…" });
        const [tt, ms] = await Promise.all([
          fetchUniverseFlow({
            minPremium: MIN_PREMIUM,
            now,
            onTicker: (ticker, i, total, found) => {
              send({ type: "step", label: `Tastytrade: ${ticker} (${i}/${total}) — ${found} operaciones grandes` });
            },
          }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
          fetchMarketFlow({
            period: "1d",
            minPremium: MIN_PREMIUM,
            maxPages: MS_MAX_PAGES,
            onPage: (page, accumulated) => {
              send({ type: "step", label: `MarketSnack: página ${page} — ${accumulated} operaciones grandes` });
            },
          }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
        ]);
        const ttOk = !(tt instanceof Error) && tt.failed.length < CONTRACT_SEARCH_UNIVERSE.length;
        const msOk = !(ms instanceof Error);
        if (!ttOk && !msOk) {
          throw new TastytradeError(
            `Ni Tastytrade ni MarketSnack respondieron (${(ms as Error).message}).`,
          );
        }
        if (!msOk) send({ type: "step", label: `MarketSnack no disponible (${(ms as Error).message}) — sigo solo con Tastytrade.` });
        if (!ttOk) send({ type: "step", label: "Tastytrade no respondió — sigo solo con MarketSnack." });

        // period="1d" de MarketSnack es una ventana rolling: antes de la apertura trae trades de ayer.
        const sinceMs = Date.parse(`${marketDateStr(now)}T00:00:00Z`);
        const msTrades: RawTrade[] = msOk ? (ms as Exclude<typeof ms, Error>).trades.filter((t) => Date.parse(t.timestamp) >= sinceMs) : [];
        const ttTrades: RawTrade[] = ttOk ? (tt as Exclude<typeof tt, Error>).trades : [];
        const spots = ttOk ? (tt as Exclude<typeof tt, Error>).spots : new Map<string, number>();
        const trades = [...ttTrades, ...msTrades];
        const pages = (msOk ? (ms as Exclude<typeof ms, Error>).pages : 0) + (ttOk ? CONTRACT_SEARCH_UNIVERSE.length : 0);
        const truncated = (msOk && (ms as Exclude<typeof ms, Error>).truncated) || (ttOk && (tt as Exclude<typeof tt, Error>).truncated > 0);

        send({ type: "step", label: `Clasificando ${ttTrades.length} operaciones de Tastytrade + ${msTrades.length} de MarketSnack…` });
        // Se clasifica cada fuente por separado (repetición/simultaneidad son por fuente).
        const ttRows = classifyFlow(ttTrades, now).rows;
        const msRows = classifyFlow(msTrades, now).rows.filter(
          (r) => MS_UNIVERSE.has(r.underlying) && (!ttOk || !TT_UNIVERSE.has(r.underlying)),
        );
        const todaysRows = [...ttRows, ...msRows];

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

        // Precio en vivo: los 16 de Tastytrade ya lo traen del escaneo; para los
        // finalistas que vinieron de MarketSnack se pide aquí al streamer.
        const finalists = [...new Set(top.map((r) => r.underlying))];
        const missing = finalists.filter((t) => !spots.has(t));
        if (missing.length > 0) {
          const q = await fetchTastytradeQuotes(missing).catch(() => new Map());
          for (const [t, v] of q) if (v.price != null) spots.set(t, v.price);
        }
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

        send({ type: "done", favorites, meta: { scanned: trades.length, pages, truncated } });
      } catch (err) {
        const message =
          err instanceof TastytradeError || err instanceof MarketSnackError
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
