// GET /api/tarjeta?ticker=XXX&horizon=10 — Tarjeta de Decisión (The Scout / FLOW) por SSE.
//
// Reúne server-side lo que el dashboard calcula en cliente (cadena + barras +
// flujo + noticias), corre gexAnalysis → predictPro → findLevels, y sintetiza la
// Tarjeta de Decisión con `buildDecisionCard`. Emite un único evento `done`.
//
// Triangula fuentes como el resto del agente: Tastytrade (cadena + greeks reales,
// por el streamer y con cache de vida corta), MarketSnack (flujo real), Schwab
// (barras de índices). Massive ya no está en el camino caliente: la ficha de
// empresa y las barras salen de sus almacenes en disco.

import { toRow, sortByOpenInterestDesc } from "@/lib/compute";
import { fetchTickerFlow } from "@/lib/flowSources";
import { structureScore } from "@/lib/structure";
import { MassiveError } from "@/lib/massive";
import { cachedCompany } from "@/lib/companyStore";
import { cachedDailyBars, loadBars, saveBars } from "@/lib/barsStore";
import { marketDateStr } from "@/lib/occ";
import { fetchChainFromTastytrade } from "@/lib/chainSources";
import { fetchExpirations, fetchOptionChain2 } from "@/lib/marketsnack";
import { marketsnackConfigured } from "@/lib/marketsnackCookie";
import { normalizeChain2, nearestExpirations, realGreeksMap } from "@/lib/optionChain2";
import { estimateSpotFromChain } from "@/lib/zerodte";
import {
  fetchPriceHistory,
  schwabConfigured,
  schwabStatus,
  fetchOptionChain as fetchSchwabChain,
} from "@/lib/schwab";
import {
  aggressionScore,
  classifyFlow,
  convictionScore,
  unusualityScore,
  type FlowRow,
} from "@/lib/flow";
import { gexAnalysis, type TradeLite, type SchwabGreek } from "@/lib/gex";
import { predictPro } from "@/lib/prediction";
import { findLevels, type ChainLevel, type FlowLevel } from "@/lib/levels";
import { buildNewsReport } from "@/lib/news";
import { fetchIvRankMap, fetchQuoteToken, fetchTastytradeGreeks, tastytradeConfigured } from "@/lib/tastytrade";
import { buildDecisionCard, type FlowTapeRow, type GammaRung } from "@/lib/decisionCard";
import type { NewsBias } from "@/lib/news";
import type { Row, DailyBar } from "@/lib/types";
import type { TarjetaSseEvent } from "@/app/tarjeta/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FLOW_MIN_PREMIUM = 100_000;
const FLOW_MAX_PAGES = 6;
const GREEK_EXPIRATIONS = 8; // vencimientos cercanos que se funden (como el heatmap)
const NEUTRAL_NEWS: NewsBias = { bias: "neutral", score: 0, positive: 0, negative: 0, neutral: 0 };

/**
 * Greeks REALES por contrato (gamma/IV) para inyectar en el GEX y NO estimar por
 * Black-Scholes. MarketSnack es la fuente principal (su plan ya trae gamma/IV
 * reales); Schwab queda de respaldo. Si ambas fallan, devuelve `undefined` y el
 * GEX cae a la estimación de siempre (greeksSource:"estimated"). Mismo orden y
 * misma lógica que /api/{marketsnack,schwab}/greeks, pero server-side directo.
 */
async function loadRealGreeks(
  ticker: string,
  now: Date,
): Promise<{ map: Map<string, SchwabGreek> | undefined; hint: "tastytrade" | "marketsnack" | "schwab" }> {
  // 0. Tastytrade (streamer DXLink, PRIMERA prioridad).
  if (tastytradeConfigured()) {
    try {
      const greeks = await fetchTastytradeGreeks(ticker);
      if (Object.keys(greeks).length > 0) {
        return { map: new Map(Object.entries(greeks)), hint: "tastytrade" };
      }
    } catch {
      // cae a MarketSnack
    }
  }
  // 1. MarketSnack.
  if (await marketsnackConfigured().catch(() => false)) {
    try {
      const expirations = await fetchExpirations(ticker);
      const dates = nearestExpirations(expirations.map((e) => e.date), GREEK_EXPIRATIONS, now);
      if (dates.length > 0) {
        const chains = await Promise.all(
          dates.map((d) => fetchOptionChain2(ticker, d).then(normalizeChain2).catch(() => [])),
        );
        const greeks: Record<string, SchwabGreek> = {};
        for (const contracts of chains) Object.assign(greeks, realGreeksMap(contracts));
        if (Object.keys(greeks).length > 0) {
          return { map: new Map(Object.entries(greeks)), hint: "marketsnack" };
        }
      }
    } catch {
      // cae al respaldo de Schwab
    }
  }
  // 2. Schwab (respaldo).
  if (schwabConfigured()) {
    try {
      const status = await schwabStatus();
      if (status.connected) {
        const { contracts } = await fetchSchwabChain(ticker);
        const greeks: Record<string, SchwabGreek> = {};
        for (const c of contracts) {
          const gamma = c.gamma != null && c.gamma > 0 ? c.gamma : null;
          const iv = c.iv != null && c.iv > 0 ? c.iv / 100 : null; // % → decimal
          if ((gamma == null && iv == null) || !c.expiration) continue;
          greeks[`${c.strike}|${c.expiration}|${c.contractType}`] = { gamma: gamma ?? 0, iv: iv ?? 0 };
        }
        if (Object.keys(greeks).length > 0) {
          return { map: new Map(Object.entries(greeks)), hint: "schwab" };
        }
      }
    } catch {
      // sin greeks reales → el GEX estima
    }
  }
  return { map: undefined, hint: "marketsnack" };
}

function sse(event: TarjetaSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Índices que Massive NO cotiza → Schwab los da (misma tabla que /api/history).
function schwabIndexSymbol(ticker: string): string | null {
  const map: Record<string, string> = { SPX: "$SPX", NDX: "$NDX", RUT: "$RUT", VIX: "$VIX", DJI: "$DJI" };
  const clean = ticker.startsWith("$") ? ticker.slice(1) : ticker;
  return map[clean] ?? null;
}

/**
 * Barras diarias por el cache de disco, NO por Massive directo.
 *
 * `fetchDailyBars` es una petición del presupuesto de 5/minuto del plan gratis, y
 * junto con la ficha de empresa dejaba la tarjeta esperando turno hasta 20 s (el
 * tope de `massiveLimiter`) en cuanto abrías la segunda del minuto. `cachedDailyBars`
 * sirve la foto del día y solo paga Massive la primera vez.
 *
 * Los índices (SPX/NDX/…) no los cotiza Massive: los da Schwab, y se guardan en el
 * MISMO almacén para que la segunda apertura tampoco pague la llamada.
 */
async function loadDailyBars(ticker: string, now = new Date()): Promise<DailyBar[]> {
  const bars = await cachedDailyBars(ticker, 365, now);
  if (bars.length > 0) return bars;

  const idx = schwabIndexSymbol(ticker);
  if (!idx || !schwabConfigured()) return bars;

  const cached = await loadBars(ticker);
  if (cached && cached.date === marketDateStr(now) && cached.bars.length > 0) return cached.bars;
  try {
    const raw = await fetchPriceHistory(idx);
    const desdeSchwab: DailyBar[] = raw.map((b) => ({
      time: new Date(b.time).toISOString().slice(0, 10),
      open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }));
    if (desdeSchwab.length > 0) {
      await saveBars(ticker, desdeSchwab, now).catch(() => { /* disco lleno: no es fatal */ });
      return desdeSchwab;
    }
  } catch {
    // Schwab sin conectar → seguimos sin barras
  }
  return cached?.bars ?? [];
}

/** Sesgo del print según la tabla del mandato: buy call / sell put = alcista. */
function tapeSentiment(r: FlowRow): "bull" | "bear" | "neu" {
  const buy = r.aggression === "ask";
  const sell = r.aggression === "bid";
  if (r.type === "call" && buy) return "bull";
  if (r.type === "put" && sell) return "bull";
  if (r.type === "put" && buy) return "bear";
  if (r.type === "call" && sell) return "bear";
  return "neu";
}

function toTapeRow(r: FlowRow): FlowTapeRow {
  const strikeLabel = r.strike != null ? `${r.strike}${r.type === "call" ? "C" : r.type === "put" ? "P" : ""}` : "—";
  return {
    contract: `${r.underlying} ${strikeLabel}`.trim(),
    side: r.aggression === "ask" ? "BUY" : r.aggression === "bid" ? "SELL" : "—",
    size: r.size,
    premium: r.premium,
    spot: null,
    sentiment: tapeSentiment(r),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const horizonDays = Number(searchParams.get("horizon")) || 10;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: TarjetaSseEvent) => controller.enqueue(encoder.encode(sse(e)));
      try {
        if (!ticker) {
          send({ type: "error", message: "Escribe un ticker (p. ej. AAPL o SPX)." });
          controller.close();
          return;
        }

        // 1. Empresa + cadena + barras en paralelo.
        send({ type: "step", label: `Buscando ${ticker}…` });
        // La cadena sale de Tastytrade (streamer, en vivo y sin cuota). NO hay
        // respaldo a la snapshot paginada de Massive: con el plan gratis son ~20
        // páginas por ticker a 5 peticiones/minuto, así que no llegaba a terminar —
        // dejaba la tarjeta colgada minutos para acabar fallando igual. Mejor decirlo
        // en 2 s y que el dueño reintente.
        //
        // Un solo api-quote-token para la cadena y para la cotización de la ficha:
        // son dos consumidores del MISMO streamer y pedirlo dos veces es un viaje
        // REST de más.
        const quoteToken = tastytradeConfigured()
          ? await fetchQuoteToken().catch(() => undefined)
          : undefined;
        const chainDesdeTt = async () => {
          if (!tastytradeConfigured()) return null;
          return await fetchChainFromTastytrade(ticker, { quoteToken }).catch(() => null);
        };
        const [company, chainRes, bars] = await Promise.all([
          cachedCompany(ticker, { quoteToken }).catch(() => null),
          chainDesdeTt(),
          loadDailyBars(ticker),
        ]);

        if (!chainRes) {
          send({
            type: "error",
            message: tastytradeConfigured()
              ? `Tastytrade no devolvió la cadena de "${ticker}". Reintenta en unos segundos.`
              : "Tastytrade no está conectado: sin él no hay cadena de opciones.",
          });
          controller.close();
          return;
        }

        const contracts = chainRes.contracts;
        if (contracts.length === 0) {
          send({ type: "error", message: `Sin contratos de opciones para "${ticker}".` });
          controller.close();
          return;
        }

        // Spot: empresa → cadena → último cierre → paridad MarketSnack (índices).
        const lastClose = bars.length > 0 ? bars[bars.length - 1].close : 0;
        let spot = company?.price ?? chainRes.underlyingPrice ?? lastClose;
        if (!spot || spot <= 0) {
          send({ type: "step", label: `Derivando spot de ${ticker} por paridad…` });
          try {
            const exps = await fetchExpirations(ticker);
            const front = nearestExpirations(exps.map((e) => e.date), 1, new Date())[0];
            if (front) {
              const ms = normalizeChain2(await fetchOptionChain2(ticker, front));
              const derived = estimateSpotFromChain(ms);
              if (derived && derived > 0) spot = derived;
            }
          } catch {
            // sin cookie de MarketSnack → seguimos
          }
        }
        if (!spot || spot <= 0) {
          send({ type: "error", message: `No pude determinar el precio de ${ticker}.` });
          controller.close();
          return;
        }

        let rows: Row[] = sortByOpenInterestDesc(contracts.map(toRow));
        const structure = structureScore(rows);

        // Greeks REALES + IV Rank real (Tastytrade) en paralelo con el flujo.
        //
        // La cadena de Tastytrade YA trajo gamma/IV de cada contrato por el streamer:
        // si vinieron, se usan tal cual. Reabrir el WebSocket para los mismos
        // vencimientos costaba hasta 9 s (el snapshot agota su tope duro cuando los
        // contratos no tickean, que es lo normal en pre-market). `loadRealGreeks`
        // sigue ahí para cuando la cadena llegó sin greeks (mercado cerrado del todo).
        const greeksDeLaCadena = chainRes.greeks;
        send({
          type: "step",
          label:
            greeksDeLaCadena.size > 0
              ? `Greeks reales de la cadena (${greeksDeLaCadena.size} contratos) e IV Rank…`
              : "Cargando greeks reales (gamma/IV) e IV Rank…",
        });
        const greeksPromise: Promise<{ map: Map<string, SchwabGreek> | undefined; hint: "tastytrade" | "marketsnack" | "schwab" }> =
          greeksDeLaCadena.size > 0
            ? Promise.resolve({ map: greeksDeLaCadena, hint: "tastytrade" as const })
            : loadRealGreeks(ticker, new Date());
        const ivRankPromise = fetchIvRankMap([ticker]).then((m) => m.get(ticker) ?? null);

        // 2. Flujo real (Tastytrade → MarketSnack) → scores + trades para el GEX.
        send({ type: "step", label: `Leyendo flujo institucional de ${ticker}…` });
        let interesting: FlowRow[] = [];
        try {
          const { trades } = await fetchTickerFlow(ticker, {
            period: "5d",
            days: 5,
            minPremium: FLOW_MIN_PREMIUM,
            maxPages: FLOW_MAX_PAGES,
          });
          interesting = classifyFlow(trades, new Date()).interesting;
        } catch {
          // sin ninguna de las dos fuentes → seguimos con GEX estimado y sin tape
        }

        const aggression = interesting.length ? aggressionScore(interesting).score : null;
        const conviction = interesting.length ? convictionScore(interesting).score : null;
        const unusuality = interesting.length ? unusualityScore(interesting).score : null;

        // % del premium en calls (dirección del dinero).
        let callP = 0, putP = 0;
        for (const r of interesting) {
          if (r.type === "call") callP += r.premium;
          else if (r.type === "put") putP += r.premium;
        }
        const callPct = callP + putP > 0 ? Math.round((callP / (callP + putP)) * 100) : null;

        // 3. GEX con los trades reales.
        send({ type: "step", label: "Calculando GEX y nodos imán…" });
        const seen = new Set<number>();
        const trades: TradeLite[] = [];
        for (const r of interesting) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          trades.push({ strike: r.strike, type: r.type, premium: r.premium, gamma: r.gamma });
        }
        const { map: realGreeks, hint: greeksHint } = await greeksPromise;
        const gex = gexAnalysis({
          rows,
          closes: bars.map((b) => b.close),
          spot,
          trades,
          convictionScore: conviction,
          structureScore: structure.score,
          lowLiquidity: structure.notional.lowLiquidity ?? false,
          now: new Date(),
          schwabGreeks: realGreeks,
          greeksSource: greeksHint,
        });

        // 4. Predicción (3 escenarios) reutilizando los scores.
        send({ type: "step", label: "Prediciendo escenarios…" });
        const prediction = predictPro({
          spot: gex.spot,
          iv: gex.iv,
          horizonDays,
          nodes: gex.nodes.map((n) => ({ strike: n.strike, concentration: n.concentration, side: n.side, netGex: n.netGex })),
          scores: { aggression, conviction, unusuality, structure: structure.score, ivContext: null, validation: null },
          regime: gex.regime,
          callPct,
          hitRate: null,
          lowLiquidity: gex.lowLiquidity,
        });

        // 5. Niveles (soportes/resistencias) precio × opciones.
        send({ type: "step", label: "Trazando soportes, resistencias e imanes…" });
        const chainLevels: ChainLevel[] = rows.map((r) => ({
          strike: r.strike, contractType: r.contractType, openInterest: r.openInterest, notionalValue: r.notionalValue,
        }));
        const flowLevels: FlowLevel[] = interesting.map((r) => ({
          strike: r.strike, type: r.type, aggression: r.aggression, premium: r.premium,
        }));
        const levels = findLevels({
          bars: bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close })),
          spot,
          chain: chainLevels,
          flows: flowLevels,
          gex: gex.nodes.map((n) => ({ strike: n.strike, netGex: n.netGex })),
          now: new Date(),
        });

        // 6. Noticias (catalizador) — no debe romper el reporte.
        send({ type: "step", label: "Revisando catalizadores y noticias…" });
        let news: NewsBias = NEUTRAL_NEWS;
        try {
          const report = await buildNewsReport(ticker, company?.name ?? ticker, new Date());
          news = report.bias;
        } catch {
          news = NEUTRAL_NEWS;
        }

        // Gamma ladder desde los nodos del GEX (top por concentración, mostrados por strike).
        const ladder: GammaRung[] = [...gex.nodes]
          .slice(0, 6)
          .map((n) => ({ strike: n.strike, gamma: Math.abs(n.netGex), isWall: n.strike === gex.kingStrike }))
          .sort((a, b) => b.strike - a.strike);

        const flowTape: FlowTapeRow[] = [...interesting]
          .sort((a, b) => b.premium - a.premium)
          .slice(0, 8)
          .map(toTapeRow);

        // PDH/PDL = máximo/mínimo de la sesión previa.
        const prev = bars.length >= 2 ? bars[bars.length - 2] : null;

        // 7. Síntesis → Tarjeta de Decisión.
        send({ type: "step", label: "Sintetizando la Tarjeta de Decisión…" });
        const ivRank = await ivRankPromise;
        const card = buildDecisionCard({
          ticker,
          company: company?.name ?? ticker,
          spot,
          now: new Date(),
          horizonDays,
          closes: bars.map((b) => b.close),
          prevHigh: prev?.high ?? null,
          prevLow: prev?.low ?? null,
          gex,
          prediction,
          levels,
          news,
          callPct,
          flowTape,
          gammaLadder: ladder,
          ivRank,
          premarketAvailable: false,
        });

        send({
          type: "done",
          card,
          meta: {
            ticker,
            horizonDays,
            greeksSource: gex.greeksSource,
            spot,
            predictionSummary: prediction.summary,
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        const message = err instanceof MassiveError ? err.message : "Error inesperado al generar la tarjeta.";
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
