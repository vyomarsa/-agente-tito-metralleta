// GET /api/flow?ticker=XXX — Reporte de Agresividad (scorecard) por SSE.
//
// FUENTE DEL FLUJO (2026-09-17): cascada Tastytrade → MarketSnack (`lib/flowSources`).
// Antes era MarketSnack a secas, y por eso esta pantalla —Agresividad, Convicción,
// Inusualidad y Contexto IV— se caía entera sin su cookie.
// Lean: filtra duro a transacciones notables, tabla chica + score 0-10. No trae el tape completo.

import { aggressionScore, classifyFlow, convictionScore, unusualityScore, type FlowRow } from "@/lib/flow";
import { MarketSnackError } from "@/lib/marketsnack";
import { fetchTickerFlow } from "@/lib/flowSources";
import { fetchChainsByDate, listExpirations } from "@/lib/frontChain";
import { nearestExpirations, chainIvSurface, type ChainIvSurface } from "@/lib/optionChain2";
import { loadTrades, saveTrades } from "@/lib/store";
import { ivContextScore, type IvContextScore } from "@/lib/ivcontext";
import { loadIvHistory, saveIvSnapshot } from "@/lib/ivStore";
import { fetchDailyBars } from "@/lib/massive";
import { fetchMarketMetrics, tastytradeConfigured } from "@/lib/tastytrade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Parámetros del reporte (ajustables).
const MIN_PREMIUM = 100_000; // piso server-side: solo trades "de dinero real"
const LEAN_MAX_PAGES = 6; // tope: ~300 trades notables recientes, no miles
const TABLE_CAP = 100; // cuántas notables mostrar en la tabla del reporte

// Convicción revisa una ventana de 30 días (nota del documento) y guarda lo categorizado.
const CONVICTION_DAYS = 30;
const CONVICTION_MIN_PREMIUM = 1_000_000;
/** Días de la ventana corta del reporte (lo que el streamer sí sirve del tirón). */
const LEAN_DAYS = 5;
const CONVICTION_TABLE_CAP = 150;

// Contexto IV: cuántos vencimientos cercanos de la cadena completa se leen para la
// superficie de IV (option_chain_extended). Acota las llamadas a MarketSnack.
const IV_CHAIN_EXPIRATIONS = 6;

/**
 * Superficie de IV de la cadena COMPLETA (no solo lo que operó): vencimientos
 * cercanos + IV media/ponderada por vencimiento. Devuelve null si algo falla, y
 * entonces el Contexto IV cae a la IV de los trades del flujo (comportamiento previo).
 */
async function fetchChainIvSurface(ticker: string, now: Date): Promise<ChainIvSurface | null> {
  try {
    // Por la cascada Tastytrade → MarketSnack, igual que el 0DTE y el scalping.
    const { dates: todas } = await listExpirations(ticker);
    const dates = nearestExpirations(todas, IV_CHAIN_EXPIRATIONS, now);
    if (dates.length === 0) return null;
    const { byDate } = await fetchChainsByDate(ticker, dates);
    const contracts = [...byDate.values()].flat();
    if (contracts.length === 0) return null;
    return chainIvSurface(contracts, now);
  } catch {
    return null;
  }
}

interface SseEvent {
  type: "step" | "done" | "error";
  [k: string]: unknown;
}
function sse(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Presets para el flujo de la gráfica por ventana de días (piso alto = pocas páginas).
const CHART_PRESETS: Record<number, { minPremium: number; maxPages: number }> = {
  5: { minPremium: 250_000, maxPages: 30 },
  10: { minPremium: 500_000, maxPages: 20 },
  30: { minPremium: 1_000_000, maxPages: 15 },
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const period = searchParams.get("period") ?? "5d";
  const days = Number(searchParams.get("days"));

  // Modo JSON para la gráfica: flujo que cubre N días hacia atrás.
  if (Number.isFinite(days) && days > 0) {
    if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });
    const preset = CHART_PRESETS[days] ?? { minPremium: 500_000, maxPages: 20 };
    try {
      const { trades, truncated, source } = await fetchTickerFlow(ticker, {
        period: "1m",
        days,
        minPremium: preset.minPremium,
        maxPages: preset.maxPages,
      });
      const { interesting } = classifyFlow(trades, new Date());
      return Response.json({
        ticker,
        days,
        minPremium: preset.minPremium,
        rows: interesting.slice(0, 400),
        source,
        truncated,
      });
    } catch (err) {
      const message =
        err instanceof MarketSnackError ? err.message : "Error al consultar el flujo.";
      return Response.json({ error: message }, { status: 502 });
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: SseEvent) => controller.enqueue(encoder.encode(sse(e)));
      try {
        if (!ticker) {
          send({ type: "error", message: "Escribe un ticker o contrato (p. ej. TSLA)." });
          controller.close();
          return;
        }

        send({ type: "step", label: "Pidiendo el Time & Sales…" });
        send({ type: "step", label: `Buscando transacciones ≥ $${(MIN_PREMIUM / 1000).toFixed(0)}K de ${ticker}…` });

        const { trades, truncated, source } = await fetchTickerFlow(ticker, {
          period,
          days: LEAN_DAYS,
          minPremium: MIN_PREMIUM,
          maxPages: LEAN_MAX_PAGES,
        });
        send({
          type: "step",
          label: source === "tastytrade" ? "Flujo de Tastytrade" : "Flujo de MarketSnack",
          detail: `${trades.length} transacciones`,
        });

        if (trades.length === 0) {
          send({ type: "error", message: `Sin transacciones notables (≥ $${(MIN_PREMIUM / 1000).toFixed(0)}K) para "${ticker}".` });
          controller.close();
          return;
        }

        send({ type: "step", label: "Etiquetando bid / ask y marcando interesantes…" });
        const { interesting } = classifyFlow(trades, new Date());
        const report: FlowRow[] = interesting.slice(0, TABLE_CAP);

        send({ type: "step", label: "Calculando Score de Agresividad…" });
        const score = aggressionScore(interesting);

        // ── Convicción: revisa una ventana de 30 días (nota del documento)
        send({ type: "step", label: `Revisando transacciones de los últimos ${CONVICTION_DAYS} días…` });
        /**
         * La ventana de 30 días se ARMA: lo fresco de esta corrida (Tastytrade no
         * sirve más de ~5 sesiones) más lo que el propio agente lleva guardado de
         * corridas anteriores, que es justo para lo que existe `saveTrades`. El
         * dedupe va por `id`, y por eso las impresiones de Tastytrade llevan un id
         * estable (`printId`) y no un número de orden.
         *
         * Con MarketSnack esto era una segunda llamada de 15 páginas; ahora es
         * gratis, porque los trades grandes ya vienen en la misma bajada.
         */
        const desde = Date.now() - CONVICTION_DAYS * 86_400_000;
        const grandes = new Map<number, FlowRow>();
        for (const r of (await loadTrades(ticker).catch(() => null))?.trades ?? []) {
          if (r.premium >= CONVICTION_MIN_PREMIUM && Date.parse(r.timestamp) >= desde) grandes.set(r.id, r);
        }
        const frescasGrandes = classifyFlow(
          trades.filter((t) => t.premium >= CONVICTION_MIN_PREMIUM),
          new Date(),
        ).interesting;
        for (const r of frescasGrandes) grandes.set(r.id, r);
        const acumuladas = [...grandes.values()].sort(
          (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
        );
        // Sin nada acumulado todavía, Convicción se calcula con la ventana corta.
        const convictionRows = acumuladas.length > 0 ? acumuladas : interesting;
        const masAntiguo = convictionRows.length
          ? convictionRows[convictionRows.length - 1].timestamp
          : null;
        const diasCubiertos = masAntiguo
          ? Math.max(1, Math.round((Date.now() - Date.parse(masAntiguo)) / 86_400_000))
          : 0;
        const convictionWindow = acumuladas.length > 0 ? `${diasCubiertos}d acumulados` : period;

        send({ type: "step", label: "Calculando Score de Convicción (spread · dominancia · ejecución)…" });
        const conviction = convictionScore(convictionRows);

        // ── Inusualidad: mismos 30 días, puntuando los griegos de cada trade.
        send({ type: "step", label: "Buscando transacciones inusuales (griegos institucionales)…" });
        const unusuality = unusualityScore(convictionRows);
        // Nota del documento: cruzar con lo que reportan los otros agentes para validar
        // la etiqueta "inusual". Es un proceso aparte y NO afecta el scoreboard.
        const agresividadIds = new Set(interesting.map((r) => r.id));
        const unusualTop = unusuality.top.map(({ row, scores }) => ({
          ...row,
          unusualScores: scores,
          confirmedByAggression: agresividadIds.has(row.id),
        }));

        // ── Contexto IV: promedio de IV por vencimiento + IV Rank.
        // El IV Rank necesita historia: se usa la propia si ya alcanza, y mientras
        // tanto el proxy de volatilidad realizada del subyacente.
        send({ type: "step", label: "Midiendo contexto de volatilidad implícita (IV y IV Rank)…" });
        let ivContext: IvContextScore | null = null;
        try {
          const [dailyBars, ivHist, chainIv, ttMetrics] = await Promise.all([
            fetchDailyBars(ticker, 365).catch(() => []),
            loadIvHistory(ticker).catch(() => null),
            // IV de TODA la cadena (option_chain_extended): más estable que solo los trades.
            fetchChainIvSurface(ticker, new Date()),
            // IV Rank REAL de Tastytrade (si está configurado). Degrada con gracia.
            tastytradeConfigured() ? fetchMarketMetrics([ticker]).catch(() => []) : Promise.resolve([]),
          ]);
          // Tastytrade da el IV Rank como proporción 0-1 ya convertido a % en fetchMarketMetrics.
          const ttIvRank = ttMetrics.find((m) => m.symbol === ticker)?.ivRank ?? null;
          ivContext = ivContextScore({
            rows: convictionRows,
            closes: dailyBars.map((b) => b.close),
            ivHistory: ivHist?.snapshots.map((s) => ({ date: s.date, avgIv: s.avgIv })) ?? [],
            chainIv: chainIv ?? undefined,
            tastytradeIvRank: ttIvRank,
          });
          // Foto diaria de la IV: el IV Rank real se acumula hacia adelante.
          await saveIvSnapshot(ticker, ivContext).catch(() => null);
        } catch {
          // el contexto IV no debe romper el reporte
        }

        // Guardar lo categorizado para que el agente vaya ajustando con el tiempo.
        send({ type: "step", label: "Guardando transacciones categorizadas…" });
        let saved: { total: number; added: number; firstSeen: string | null } | null = null;
        try {
          saved = await saveTrades(ticker, convictionRows);
        } catch {
          // el guardado no debe romper el reporte
        }

        const convictionTable = convictionRows.slice(0, CONVICTION_TABLE_CAP);

        send({
          type: "done",
          rows: report,
          score,
          conviction,
          unusuality: {
            score: unusuality.score,
            avgByParam: unusuality.avgByParam,
            unusualCount: unusuality.unusualCount,
            n: unusuality.n,
            confirmedCount: unusualTop.filter((r) => r.confirmedByAggression).length,
          },
          unusualRows: unusualTop,
          ivContext,
          convictionRows: convictionTable,
          convictionMeta: {
            window: convictionWindow,
            source,
            minPremium: CONVICTION_MIN_PREMIUM,
            total: convictionRows.length,
            shown: convictionTable.length,
            expiredCount: convictionRows.filter((r) => r.expiryStatus === "expirado").length,
            vigenteCount: convictionRows.filter((r) => r.expiryStatus === "vigente").length,
            saved,
          },
          meta: {
            ticker,
            period,
            minPremium: MIN_PREMIUM,
            notableCount: interesting.length,
            shown: report.length,
            truncated,
          },
        });
      } catch (err) {
        const message =
          err instanceof MarketSnackError ? err.message : "Error inesperado al consultar MarketSnack.";
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
