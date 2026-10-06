// GET /api/daytrade-wall?ticker=SPX|TSLA — sugerencia de contrato "vecinos"
// (Prueba de Fuego), EN VIVO, por SSE. Mismo pipeline que /api/daytrade (cadena
// de Massive + flujo de MarketSnack de hoy), pero la dirección/target salen de
// la señal de PARED (suggestWallContract → wallEntrySignal, lib/neighborContracts.ts)
// en vez del walk de dominancia local: pesa la magnitud real en dólares del
// desbalance call/put en TODO el vecindario (6 strikes arriba/abajo —
// WALL_NEIGHBOR_COUNT), no solo quién gana en el strike más cercano al spot.
// Pedido explícito (2026-08-03) tras un backtest manual sobre datos
// reales de un día de SPX.
//
// `ticker` generalizado a TSLA (2026-08-04, pedido explícito: "todo
// el proceso que haces en SPX vecinos quiero que lo hagas con TSLA", en el
// mismo botón "TSLA" de siempre, sin pestaña nueva) — default SPX por
// compatibilidad con la pestaña "SPX vecinos". Sin GEX para ningún ticker (a
// diferencia de /api/daytrade): la señal de pared no lo usa, así se validó en
// el backtest. El net premium sigue viniendo solo de MarketSnack — Massive
// aporta la cadena de strikes/expiraciones, nunca la señal.

import { toRow } from "@/lib/pdf/compute";
import { cachedDailyBars } from "@/lib/pdf/barsStore";
import { MIN_DTE, maxDteFor, resolveLiveSpot, suggestWallContract, type ContractSuggestion } from "@/lib/pdf/dayTrade";
import { candidateStrikesForSide } from "@/lib/pdf/backtest";
import { isMarketOpen } from "@/lib/pdf/marketHours";
import { fetchCompany, fetchOptionChain, MassiveError } from "@/lib/pdf/massive";
import { fetchAssetPrice, fetchContractPremiumSummaries, fetchFlow, MarketSnackError } from "@/lib/pdf/marketsnack";
import { daysToExpiration } from "@/lib/pdf/occ";
import { WALL_NEIGHBOR_COUNT, resolveStrikeContracts, toStrikePremiums } from "@/lib/pdf/neighborContracts";
import type { DayTradeSseEvent } from "@/app/prueba-de-fuego/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_TICKERS = new Set(["SPX", "TSLA"]);

function sse(event: DayTradeSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("ticker") ?? "SPX").trim().toUpperCase();
  const TICKER = SUPPORTED_TICKERS.has(requested) ? requested : "SPX";
  const encoder = new TextEncoder();
  const now = new Date();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: DayTradeSseEvent) => controller.enqueue(encoder.encode(sse(e)));

      try {
        send({ type: "step", label: `Buscando precio en vivo de ${TICKER}…` });
        const company = await fetchCompany(TICKER);

        send({ type: "step", label: "Descargando la cadena de opciones en vivo…" });
        const { contracts, underlyingPrice } = await fetchOptionChain(TICKER, {
          onPage: (page, accumulated) => {
            send({ type: "step", label: `Cadena de ${TICKER} — página ${page} (${accumulated} contratos)` });
          },
        });
        const rows = contracts.map(toRow);

        send({ type: "step", label: "Leyendo el flujo de hoy en MarketSnack…" });
        const [{ trades }, assetPrice] = await Promise.all([
          fetchFlow(TICKER, { period: "1d", maxPages: 10 }),
          fetchAssetPrice(TICKER),
        ]);

        const bars = await cachedDailyBars(TICKER, 60, now);
        const closes = bars.map((b) => b.close);

        const spot = resolveLiveSpot({
          assetPrice, companyPrice: company.price, chainUnderlyingPrice: underlyingPrice, trades,
          lastDailyClose: closes.at(-1) ?? null,
        });
        if (!spot || spot <= 0) {
          send({ type: "error", message: `No hay precio en vivo para ${TICKER}.` });
          controller.close();
          return;
        }

        send({ type: "step", label: "Leyendo net premium de los strikes vecinos (6 por lado)…" });
        const maxDte = maxDteFor(TICKER);
        const nearTermRows = rows.filter((r) => {
          const dte = daysToExpiration(r.expiration, now);
          return dte >= MIN_DTE && dte <= maxDte;
        });
        const chainStrikes = [...new Set(nearTermRows.map((r) => r.strike))];
        const aboveStrikes = candidateStrikesForSide(chainStrikes, spot, "above", WALL_NEIGHBOR_COUNT);
        const belowStrikes = candidateStrikesForSide(chainStrikes, spot, "below", WALL_NEIGHBOR_COUNT);
        const neighborStrikes = [...new Set([...aboveStrikes, ...belowStrikes])];
        const strikeContracts = resolveStrikeContracts(neighborStrikes, nearTermRows, now, TICKER);
        const occSymbols = [...strikeContracts.values()].flatMap((c) => [c.call, c.put]).filter((s): s is string => s != null);
        const premiumsBySymbol = await fetchContractPremiumSummaries(occSymbols);
        const strikePremiums = toStrikePremiums(strikeContracts, premiumsBySymbol);

        send({ type: "step", label: "Buscando la pared más grande del vecindario…" });
        const suggestion = suggestWallContract({ ticker: TICKER, spot, chainRows: rows, strikePremiums, now });

        send({
          type: "done",
          spot,
          target: suggestion?.target ?? null,
          direction: suggestion ? (suggestion.type === "call" ? "up" : "down") : null,
          suggestion,
          marketOpen: isMarketOpen(now),
        });
      } catch (err) {
        const message =
          err instanceof MassiveError || err instanceof MarketSnackError
            ? err.message
            : "Error inesperado calculando la sugerencia de pared.";
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
