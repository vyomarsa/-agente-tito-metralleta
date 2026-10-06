// GET /api/daytrade?ticker=TSLA|SPX — sugerencia de contrato para day-trading EN
// VIVO, por SSE. Reusa el mismo chequeo de flujo agresivo del backtest
// (detectFlowReversal vía lib/dayTrade.ts), alimentado con datos de HOY en vez de
// un día pasado. El GEX (gexAnalysis) es solo para SPX — pedido explícito de
// el usuario (2026-07-28): TSLA usa SOLO MarketSnack, sin GEX en absoluto.

import { toRow } from "@/lib/pdf/compute";
import { cachedDailyBars } from "@/lib/pdf/barsStore";
import { MIN_DTE, maxDteFor, resolveLiveSpot, suggestDayTradeContract, type ContractSuggestion } from "@/lib/pdf/dayTrade";
import { candidateStrikesForSide } from "@/lib/pdf/backtest";
import { gexAnalysis, type GexAnalysis, type TradeLite } from "@/lib/pdf/gex";
import { isMarketOpen } from "@/lib/pdf/marketHours";
import { fetchCompany, fetchOptionChain, MassiveError } from "@/lib/pdf/massive";
import { fetchAssetPrice, fetchContractPremiumSummaries, fetchFlow, MarketSnackError } from "@/lib/pdf/marketsnack";
import { daysToExpiration, parseOcc } from "@/lib/pdf/occ";
import { NEIGHBOR_WALK_COUNT, resolveStrikeContracts, toStrikePremiums } from "@/lib/pdf/neighborContracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TICKERS = new Set(["TSLA", "SPX"]);
/** Tickers que sí usan GEX (índices, con opciones semanales líquidas de sobra). */
const GEX_TICKERS = new Set(["SPX"]);

interface DayTradeSseEvent {
  type: "step" | "done" | "error";
  label?: string;
  message?: string;
  spot?: number;
  target?: number | null;
  direction?: "up" | "down" | "flat" | null;
  confidence?: number;
  suggestion?: ContractSuggestion | null;
  marketOpen?: boolean;
}

function sse(event: DayTradeSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const encoder = new TextEncoder();
  const now = new Date();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: DayTradeSseEvent) => controller.enqueue(encoder.encode(sse(e)));

      try {
        if (!ALLOWED_TICKERS.has(ticker)) {
          send({ type: "error", message: `Ticker no soportado en day-trading: "${ticker}".` });
          controller.close();
          return;
        }

        send({ type: "step", label: `Buscando precio en vivo de ${ticker}…` });
        const company = await fetchCompany(ticker);

        send({ type: "step", label: "Descargando la cadena de opciones en vivo…" });
        const { contracts, underlyingPrice } = await fetchOptionChain(ticker, {
          onPage: (page, accumulated) => {
            send({ type: "step", label: `Cadena de ${ticker} — página ${page} (${accumulated} contratos)` });
          },
        });
        const rows = contracts.map(toRow);

        send({ type: "step", label: "Leyendo barras diarias para estimar volatilidad…" });
        const bars = await cachedDailyBars(ticker, 60, now);
        const closes = bars.map((b) => b.close);

        send({ type: "step", label: "Leyendo el flujo de hoy en MarketSnack…" });
        const [{ trades }, assetPrice] = await Promise.all([
          fetchFlow(ticker, { period: "1d", maxPages: 10 }),
          fetchAssetPrice(ticker),
        ]);

        // Orden de frescura real, no de comodidad: el precio del activo de
        // MarketSnack (`latest_price` de `/api/assets/{ticker}` — MISMO dato que
        // su propia UI, ya resuelve solo regular/pre-market/after-hours) → el
        // trade más reciente de MarketSnack → el snapshot de acciones de Massive
        // → el precio embebido en la cadena → el cierre diario cacheado, que solo
        // se refresca una vez por día de mercado y por eso es el último recurso.
        // El snapshot de Massive no sirve como primera fuente (2026-07-30, bug
        // real de TSLA en pre-market: ni `fetchCompany` ni el precio embebido en
        // la cadena reflejan pre-market/after-hours en el plan actual — devuelven
        // ~$298 mientras MarketSnack mostraba $304+ en su encabezado).
        const spot = resolveLiveSpot({
          assetPrice, companyPrice: company.price, chainUnderlyingPrice: underlyingPrice, trades,
          lastDailyClose: closes.at(-1) ?? null,
        });
        if (!spot || spot <= 0) {
          send({ type: "error", message: `No hay precio en vivo para ${ticker}.` });
          controller.close();
          return;
        }

        let gex: GexAnalysis | null = null;
        if (GEX_TICKERS.has(ticker)) {
          const tradeLites: TradeLite[] = [];
          for (const t of trades) {
            const info = parseOcc(t.symbol);
            if (!info) continue;
            tradeLites.push({ strike: info.strike, type: info.type, premium: t.premium ?? 0, gamma: t.gamma ?? 0 });
          }
          send({ type: "step", label: "Calculando el mapa de GEX…" });
          gex = gexAnalysis({ rows, closes, spot, trades: tradeLites, now });
        }

        send({ type: "step", label: "Leyendo net premium de los strikes vecinos…" });
        const maxDte = maxDteFor(ticker);
        const nearTermRows = rows.filter((r) => {
          const dte = daysToExpiration(r.expiration, now);
          return dte >= MIN_DTE && dte <= maxDte;
        });
        const chainStrikes = [...new Set(nearTermRows.map((r) => r.strike))];
        const aboveStrikes = candidateStrikesForSide(chainStrikes, spot, "above", NEIGHBOR_WALK_COUNT);
        const belowStrikes = candidateStrikesForSide(chainStrikes, spot, "below", NEIGHBOR_WALK_COUNT);
        const neighborStrikes = [...new Set([...aboveStrikes, ...belowStrikes])];
        const strikeContracts = resolveStrikeContracts(neighborStrikes, nearTermRows, now, ticker);
        const occSymbols = [...strikeContracts.values()].flatMap((c) => [c.call, c.put]).filter((s): s is string => s != null);
        const premiumsBySymbol = await fetchContractPremiumSummaries(occSymbols);
        const strikePremiums = toStrikePremiums(strikeContracts, premiumsBySymbol);

        send({ type: "step", label: "Buscando confirmación de flujo agresivo…" });
        const suggestion = suggestDayTradeContract({ ticker, spot, chainRows: rows, strikePremiums, gex, now });

        // El target/dirección del encabezado salen de la sugerencia (escalera de
        // strikes vecinos con flujo real) cuando hay una — el GEX solo, sin flujo,
        // es lo que se quedaba pegado en un nivel viejo mientras el precio seguía
        // moviéndose (el bug de TSLA apuntando a $300 todo el día). Sin sugerencia
        // (ninguna dirección con evidencia, ni siquiera del GEX) se muestra el GEX
        // crudo como último recurso informativo — cuando lo hay (SPX); TSLA sin
        // sugerencia se queda sin target/dirección, no inventa uno.
        send({
          type: "done",
          spot,
          target: suggestion?.target ?? gex?.kingStrike ?? null,
          direction: suggestion ? (suggestion.type === "call" ? "up" : "down") : gex?.direction ?? null,
          confidence: gex?.confidence ?? 0,
          suggestion,
          marketOpen: isMarketOpen(now),
        });
      } catch (err) {
        const message =
          err instanceof MassiveError || err instanceof MarketSnackError
            ? err.message
            : "Error inesperado calculando la sugerencia de day-trading.";
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
