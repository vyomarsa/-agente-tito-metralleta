// GET /api/wheel?preset=balanceado — Screener de cash-secured puts por SSE.
//
// Orquesta I/O y NADA de criterio: todo lo que decide vive en lib/wheel.ts.
// El saldo NO llega aquí: la ruta devuelve candidatos con métricas y la
// asequibilidad se calcula en el cliente con tito.risk.* de localStorage.

import { fetchWheelChain } from "@/lib/massive";
import { cachedDailyBars } from "@/lib/barsStore";
import { findLevels, type LvlBar } from "@/lib/levels";
import { realizedVolSeries, rankWithin } from "@/lib/ivcontext";
import { fetchIvRankMap, fetchTastytradeChain, tastytradeConfigured, type TtContract } from "@/lib/tastytrade";
import { earningsForTicker } from "@/lib/earnings";
import {
  WHEEL_PRESETS, wheelCandidates,
  type PresetId, type WheelCandidate, type WheelPreset, type ChainQuote,
} from "@/lib/wheel";
import { WHEEL_UNIVERSE } from "@/lib/wheelUniverse";
import type { WheelSseEvent } from "@/app/wheel/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONCURRENCY = 6;

function sse(event: WheelSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isPreset(v: string | null): v is PresetId {
  return v === "conservador" || v === "balanceado" || v === "agresivo";
}

function ttToChainQuote(c: TtContract): ChainQuote {
  return {
    strike: c.strike, expiration: c.expiration, dte: c.dte,
    bid: c.bid, ask: c.ask, lastTrade: c.last, openInterest: c.openInterest,
  };
}

/**
 * Cadena de la Wheel por prioridad: Tastytrade (streamer, bid/ask/OI/spot reales)
 * → Massive de respaldo. Tastytrade da bid/ask/OI/último y el spot del subyacente;
 * la Wheel recalcula IV/delta desde el mid como siempre. Si Tastytrade no da spot o
 * cadena, cae a Massive (que en plan gratis puede traer el spot roto — de ahí el
 * respaldo).
 */
async function wheelChain(
  ticker: string, preset: WheelPreset, now: Date,
): Promise<{ spot: number | null; quotes: ChainQuote[] }> {
  if (tastytradeConfigured()) {
    try {
      const { spot, contracts } = await fetchTastytradeChain(ticker, {
        dteMin: preset.dteMin, dteMax: preset.dteMax,
      });
      const quotes = contracts.map(ttToChainQuote);
      if (spot != null && spot > 0 && quotes.length > 0) return { spot, quotes };
    } catch {
      // cae a Massive
    }
  }
  return fetchWheelChain(ticker, { dteMin: preset.dteMin, dteMax: preset.dteMax, now });
}

/** Corre `worker` sobre `items` con como mucho `limit` en vuelo a la vez. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const presetParam = url.searchParams.get("preset");
  const preset = WHEEL_PRESETS[isPreset(presetParam) ? presetParam : "balanceado"];
  const now = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: WheelSseEvent) => controller.enqueue(encoder.encode(sse(e)));
      let failed = 0;
      const all: WheelCandidate[] = [];

      try {
        send({ type: "step", label: `Escaneando ${WHEEL_UNIVERSE.length} tickers · preset ${preset.label}` });

        // IV Rank REAL de Tastytrade para todo el universo en una tanda. Vacío si
        // no está configurado → cada ticker cae a su proxy de vol realizada.
        const ivRankMap = await fetchIvRankMap(WHEEL_UNIVERSE.map((s) => s.ticker));
        if (ivRankMap.size > 0) {
          send({ type: "step", label: `IV Rank real de Tastytrade para ${ivRankMap.size} tickers` });
        }

        await mapLimit(WHEEL_UNIVERSE, CONCURRENCY, async (sym) => {
          try {
            const chain = await wheelChain(sym.ticker, preset, now);
            if (chain.spot == null || chain.quotes.length === 0) {
              failed++;
              send({ type: "step", label: `${sym.ticker}: sin cadena` });
              return;
            }

            const bars = await cachedDailyBars(sym.ticker, 365, now);
            const lvlBars: LvlBar[] = bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
            const levels = findLevels({ bars: lvlBars, spot: chain.spot, now });

            // IV Rank: el REAL de Tastytrade si está; si no, el proxy de vol realizada.
            const rvSeries = realizedVolSeries(bars.map((b) => b.close), 30);
            const currentRv = rvSeries.length > 0 ? rvSeries[rvSeries.length - 1] : null;
            const proxyRank = currentRv != null ? rankWithin(rvSeries, currentRv) : null;
            const realIvRank = ivRankMap.get(sym.ticker) ?? null;
            const ivRank = realIvRank ?? proxyRank;

            // Earnings sobre el vencimiento más cercano de la ventana.
            // frontSkew: null a propósito — este escaneo Wheel no computa
            // ivContextScore por ticker (no hay flujo de MarketSnack por
            // símbolo aquí), así que la confirmación por skew de earningsFlag
            // ("dentro_confirmado") queda pendiente y hoy nunca dispara; ver
            // la nota en lib/earnings.ts (earningsForTicker).
            const nearExp = chain.quotes.reduce((a, b) => (b.dte < a.dte ? b : a)).expiration;
            const earnings = await earningsForTicker({
              ticker: sym.ticker, expiration: nearExp, frontSkew: null, now,
            });

            const fallbackIv = currentRv != null ? currentRv / 100 : 0.4;
            const cands = wheelCandidates({
              ticker: sym.ticker, spot: chain.spot, quotes: chain.quotes,
              preset, ivRank, realIvRank, supports: levels.supports, earnings, fallbackIv,
            });
            all.push(...cands);
            send({ type: "step", label: `${sym.ticker}: ${cands.filter((c) => !c.blocked).length} candidatos` });
          } catch {
            failed++;
            send({ type: "step", label: `${sym.ticker}: error` });
          }
        });

        all.sort((a, b) => {
          if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
          return (b.score?.total ?? 0) - (a.score?.total ?? 0);
        });

        const withCandidates = new Set(all.filter((c) => !c.blocked).map((c) => c.ticker)).size;
        send({
          type: "done",
          candidates: all,
          meta: {
            preset: preset.label,
            scanned: WHEEL_UNIVERSE.length,
            failed,
            withCandidates,
            degraded: failed > WHEEL_UNIVERSE.length / 2,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado en el escaneo.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
