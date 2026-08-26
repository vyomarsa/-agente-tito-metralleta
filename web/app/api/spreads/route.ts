// GET /api/spreads?bias=neutral — Escáner de Credit Spreads (weekly del frente, 4–7 DTE) por SSE.
//
// Orquesta I/O y NADA de criterio: todo lo que decide vive en lib/creditSpread.ts.
// El saldo NO llega aquí: la ruta devuelve candidatos con métricas y el
// dimensionamiento (2–3% del capital) se calcula en el cliente con tito.risk.*.
//
// FUENTE: MarketSnack (Option Chain 2.0) — trae delta/IV/OI/bid-ask REALES por
// contrato, así que ya NO depende de Schwab. El mandato PROHÍBE estimar el delta y
// MarketSnack lo da firmado (call +, put −) e IV en decimal. Sin cookie → estado
// claro, nunca estimación silenciosa.

import {
  fetchExpirations,
  fetchOptionChain2,
} from "@/lib/marketsnack";
import { marketsnackConfigured } from "@/lib/marketsnackCookie";
import {
  normalizeChain2,
  expirationsInDteWindow,
  dteOf,
  type Chain2Contract,
} from "@/lib/optionChain2";
import { cachedMarketCap } from "@/lib/marketCapStore";
import { fetchCompany } from "@/lib/massive";
import {
  fetchOptionChain as fetchSchwabChain,
  schwabStatus,
  type SchwabContract,
} from "@/lib/schwab";
import { cachedDailyBars } from "@/lib/barsStore";
import { avg20dVolume } from "@/lib/volume";
import { findLevels } from "@/lib/levels";
import { earningsForTicker } from "@/lib/earnings";
import {
  cachedMacroCalendar,
  macroEventsInWindow,
  addDaysStr,
} from "@/lib/macroCalendar";
import {
  creditSpreadCandidates,
  DTE_MIN,
  DTE_MAX,
  type Bias,
  type SpreadQuote,
  type SpreadScan,
} from "@/lib/creditSpread";
import { SPREAD_UNIVERSE } from "@/lib/spreadUniverse";
import { fetchIvRankMap, fetchTastytradeChain, fetchQuoteToken, tastytradeConfigured, type TtContract, type QuoteToken } from "@/lib/tastytrade";
import type { SpreadSseEvent, Source } from "@/app/spreads/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MarketSnack usa cookie de sesión y pagina la cadena por vencimiento: mantenemos
// la concurrencia baja para no saturar ni provocar rotación de sesión.
const CONCURRENCY = 4;

function sse(event: SpreadSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isBias(v: string | null): v is Bias {
  return v === "alcista" || v === "bajista" || v === "neutral";
}

function isSource(v: string | null): v is Source {
  return v === "tastytrade" || v === "marketsnack" || v === "schwab";
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

/**
 * Chain2Contract (MarketSnack) → SpreadQuote. MarketSnack ya entrega el delta
 * FIRMADO (call +, put −) y la IV en DECIMAL, así que no hay conversión: solo se
 * calcula el DTE de la fecha de vencimiento.
 */
function toSpreadQuote(c: Chain2Contract, now: Date): SpreadQuote {
  return {
    strike: c.strike,
    type: c.type,
    expiration: c.expiration,
    dte: dteOf(c.expiration, now),
    bid: c.bid,
    ask: c.ask,
    delta: c.delta, // MarketSnack ya lo da con signo (calls +, puts −)
    iv: c.iv, // ya en decimal
    openInterest: c.openInterest,
    volume: c.volume,
  };
}

/**
 * Descarga las cadenas de la banda 4–7 DTE desde MarketSnack: una llamada de
 * vencimientos + una de cadena por cada fecha del rango. El motor elige luego el
 * weekly del frente (el vencimiento más cercano de la banda). Devuelve los
 * contratos ya normalizados a SpreadQuote.
 */
async function fetchWindowQuotes(ticker: string, now: Date): Promise<SpreadQuote[]> {
  const expirations = await fetchExpirations(ticker);
  // Toda la banda [4,7]; creditSpreadCandidates se queda con el más cercano.
  const dates = expirationsInDteWindow(expirations.map((e) => e.date), DTE_MIN, DTE_MAX, now);
  const quotes: SpreadQuote[] = [];
  for (const date of dates) {
    const contracts = normalizeChain2(await fetchOptionChain2(ticker, date));
    for (const c of contracts) quotes.push(toSpreadQuote(c, now));
  }
  return quotes;
}

/**
 * SchwabContract → SpreadQuote. Schwab entrega el delta ya FIRMADO (calls +,
 * puts −) igual que MarketSnack, pero la IV viene en PORCENTAJE (p. ej. 32.5) →
 * se pasa a decimal. El DTE se recalcula desde el vencimiento (no se confía en el
 * daysToExpiration de Schwab) para casar exactamente con la banda del motor.
 */
function toSpreadQuoteFromSchwab(c: SchwabContract, now: Date): SpreadQuote {
  return {
    strike: c.strike,
    type: c.contractType,
    expiration: c.expiration,
    dte: dteOf(c.expiration, now),
    bid: c.bid,
    ask: c.ask,
    delta: c.delta, // Schwab ya lo da con signo (puts negativo)
    iv: c.iv != null ? c.iv / 100 : null, // Schwab da IV en % → decimal
    openInterest: c.openInterest,
    volume: c.volume,
  };
}

/**
 * Cadena de la banda 4–7 DTE desde Schwab. A diferencia de MarketSnack (una
 * llamada por vencimiento), Schwab filtra por fromDate/toDate en el servidor: una
 * sola llamada por ticker con greeks/IV/OI/bid-ask de bróker. El motor no cambia.
 */
async function fetchWindowQuotesSchwab(ticker: string, now: Date): Promise<SpreadQuote[]> {
  const today = now.toISOString().slice(0, 10);
  const toDate = addDaysStr(today, DTE_MAX);
  const { contracts } = await fetchSchwabChain(ticker, {
    contractType: "ALL",
    fromDate: today,
    toDate,
  });
  return contracts.map((c) => toSpreadQuoteFromSchwab(c, now));
}

/**
 * TtContract (streamer DXLink de Tastytrade) → SpreadQuote. Tastytrade entrega el
 * delta ya FIRMADO (puts negativo) y la IV en DECIMAL, igual que MarketSnack. El
 * DTE se recalcula desde el vencimiento para casar con la banda del motor.
 */
function toSpreadQuoteFromTt(c: TtContract, now: Date): SpreadQuote {
  return {
    strike: c.strike,
    type: c.type,
    expiration: c.expiration,
    dte: dteOf(c.expiration, now),
    bid: c.bid,
    ask: c.ask,
    delta: c.delta, // Tastytrade ya lo da con signo
    iv: c.iv, // decimal
    openInterest: c.openInterest,
    volume: c.volume,
  };
}

/**
 * Cadena de la banda 4–7 DTE desde Tastytrade (streamer). Una conexión por ticker
 * trae greeks/IV/OI/bid-ask/volumen reales. Se pide con ±1 día de holgura y el
 * motor recorta a la banda exacta con dteOf.
 */
async function fetchWindowQuotesTt(
  ticker: string, now: Date, quoteToken?: QuoteToken,
): Promise<{ quotes: SpreadQuote[]; spot: number | null }> {
  // El spot del subyacente viaja en la MISMA respuesta: no cuesta otra llamada.
  const { contracts, spot } = await fetchTastytradeChain(ticker, {
    dteMin: Math.max(0, DTE_MIN - 1),
    dteMax: DTE_MAX + 1,
    quoteToken,
  });
  return { quotes: contracts.map((c) => toSpreadQuoteFromTt(c, now)), spot };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const biasParam = url.searchParams.get("bias");
  const bias: Bias = isBias(biasParam) ? biasParam : "neutral";
  const sourceParam = url.searchParams.get("source");
  const explicitSource: Source | null = isSource(sourceParam) ? sourceParam : null;
  // Modo experto: degrada los filtros DUROS (macro/tendencia/nivel guardián) a avisos.
  const expert = url.searchParams.get("expert") === "1";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  // La vida máxima del trade para el filtro macro: hoy → hoy+7.
  const tradeHorizonEnd = addDaysStr(today, 7);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: SpreadSseEvent) => controller.enqueue(encoder.encode(sse(e)));
      let failed = 0;
      const scans: SpreadScan[] = [];

      try {
        // 1. Resolver la fuente. Schwab da greeks/IV de bróker en una sola llamada
        // por ticker, pero su OAuth es de un solo usuario y el refresh caduca (~7
        // días): si se pide Schwab y no está conectado, se cae a MarketSnack (si hay
        // cookie) en vez de romper el escáner. El mandato prohíbe estimar el delta,
        // así que sin ninguna fuente real → error claro, nunca estimación silenciosa.
        const hasCookie = await marketsnackConfigured();
        const ttReady = tastytradeConfigured();
        // Prioridad Tastytrade → MarketSnack → Schwab, salvo override ?source=.
        let source: Source = explicitSource ?? (ttReady ? "tastytrade" : hasCookie ? "marketsnack" : "schwab");
        if (source === "tastytrade" && !ttReady) {
          source = hasCookie ? "marketsnack" : "schwab";
          send({ type: "step", label: "Tastytrade sin configurar → usando la siguiente fuente" });
        }
        if (source === "schwab") {
          const st = await schwabStatus().catch(() => null);
          if (!st?.connected) {
            if (hasCookie) {
              source = "marketsnack";
              send({ type: "step", label: "Schwab sin conectar → usando MarketSnack" });
            } else {
              send({
                type: "error",
                kind: "schwab",
                message:
                  "Schwab no está conectado y no hay cookie de MarketSnack de respaldo. Conecta Schwab en /schwab o pega la cookie en /ajustes.",
              });
              return;
            }
          }
        }
        if (source === "marketsnack" && !hasCookie) {
          send({
            type: "error",
            kind: "marketsnack",
            message:
              "Falta la cookie de MarketSnack. Pégala en /ajustes. El escáner necesita delta e IV reales de MarketSnack y el mandato prohíbe estimarlos.",
          });
          return;
        }
        // Un solo api-quote-token para TODO el escaneo (no uno por ticker).
        let ttToken: QuoteToken | undefined;
        if (source === "tastytrade") {
          ttToken = await fetchQuoteToken().catch(() => undefined);
          if (!ttToken) {
            source = hasCookie ? "marketsnack" : "schwab";
            send({ type: "step", label: "Tastytrade sin token de streamer → usando la siguiente fuente" });
          }
        }
        // Firma única: {quotes, spot}. Solo Tastytrade trae el spot; las otras dos
        // mandan null y el escaneo cae a Massive para el precio.
        const fetchQuotes: (t: string, n: Date) => Promise<{ quotes: SpreadQuote[]; spot: number | null }> =
          source === "tastytrade" ? (t, n) => fetchWindowQuotesTt(t, n, ttToken)
            : source === "schwab" ? async (t, n) => ({ quotes: await fetchWindowQuotesSchwab(t, n), spot: null })
              : async (t, n) => ({ quotes: await fetchWindowQuotes(t, n), spot: null });

        // 2. Calendario macro — si no hay, se BLOQUEA (no se opera a ciegas).
        const macro = await cachedMacroCalendar(now);
        if (!macro) {
          send({
            type: "error",
            kind: "macro",
            message:
              "No hay calendario macro (FRED falló y no hay cache). No se opera a ciegas: reintenta más tarde.",
          });
          return;
        }
        const macroEvents = macroEventsInWindow(macro.events, today, tradeHorizonEnd);

        send({
          type: "step",
          label: `Escaneando ${SPREAD_UNIVERSE.length} acciones · sesgo ${bias} · fuente ${source}${
            expert ? " · MODO EXPERTO" : ""
          }${macro.stale ? " · calendario macro en cache viejo" : ""}`,
        });

        // IV Rank REAL de Tastytrade para todo el universo en una tanda. Vacío si
        // no está configurado → cada ticker cae a su proxy de vol realizada.
        const ivRankMap = await fetchIvRankMap(SPREAD_UNIVERSE.map((s) => s.ticker));
        if (ivRankMap.size > 0) {
          send({ type: "step", label: `IV Rank real de Tastytrade para ${ivRankMap.size} tickers` });
        }

        await mapLimit(SPREAD_UNIVERSE, CONCURRENCY, async (sym) => {
          try {
            // Cadena de la banda 4–7 DTE (delta/IV/OI/bid-ask reales) según la fuente.
            const { quotes, spot: quotedSpot } = await fetchQuotes(sym.ticker, now);
            if (quotes.length === 0) {
              failed++;
              send({ type: "step", label: `${sym.ticker}: sin cadena 4–7 DTE` });
              return;
            }

            // El spot viene de Tastytrade en la MISMA llamada de la cadena. Massive
            // solo se consulta si la fuente no lo dio: con 5 peticiones/minuto, dos
            // por símbolo × 103 símbolos dejaban el escaneo entero en "sin precio".
            let spot = quotedSpot != null && quotedSpot > 0 ? quotedSpot : null;
            if (spot == null) {
              const company = await fetchCompany(sym.ticker).catch(() => null);
              spot = company?.price ?? null;
            }
            if (spot == null || !(spot > 0)) {
              failed++;
              send({ type: "step", label: `${sym.ticker}: sin precio` });
              return;
            }
            const marketCap = await cachedMarketCap(sym.ticker, now.getTime());

            // Volumen 20d de la acción (elegibilidad) + cierres para tendencia/IV Rank.
            const bars = await cachedDailyBars(sym.ticker, 365, now);
            const avgVol = avg20dVolume(bars);
            const closes = bars.map((b) => b.close);

            // Soportes/resistencias de precio (findLevels solo con barras + spot):
            // el strike corto debe quedar del lado protegido de un nivel importante.
            const levels = findLevels({ bars, spot, now });
            const supports = levels.supports.map((l) => ({ price: l.price, strength: l.strength }));
            const resistances = levels.resistances.map((l) => ({ price: l.price, strength: l.strength }));

            // Earnings sobre el vencimiento más cercano de la ventana.
            const nearExp = quotes.reduce((a, b) => (b.dte < a.dte ? b : a)).expiration;
            const earnings = await earningsForTicker({
              ticker: sym.ticker,
              expiration: nearExp,
              frontSkew: null,
              now,
            });

            const scan = creditSpreadCandidates({
              ticker: sym.ticker,
              sector: sym.sector,
              bias,
              spot,
              isEtf: sym.isEtf ?? false, // ETFs de índice amplio (SPY/QQQ/IWM) permitidos en venta de prima
              marketCap,
              avgVolume20d: avgVol,
              quotes,
              closes,
              realIvRank: ivRankMap.get(sym.ticker) ?? null,
              supports,
              resistances,
              earnings,
              macroEvents,
              expert,
            });
            scans.push(scan);

            const n = scan.candidates.length;
            send({
              type: "step",
              label:
                n > 0
                  ? `${sym.ticker}: ${n} candidato${n === 1 ? "" : "s"}`
                  : `${sym.ticker}: ${scan.reason ?? "sin candidatos"}`,
            });
          } catch (e) {
            failed++;
            const msg = e instanceof Error ? e.message : "error";
            send({ type: "step", label: `${sym.ticker}: ${msg.slice(0, 60)}` });
          }
        });

        // Ordena: primero los que tienen candidatos, luego por mejor margen.
        scans.sort((a, b) => {
          const av = a.candidates.length > 0 ? 0 : 1;
          const bv = b.candidates.length > 0 ? 0 : 1;
          if (av !== bv) return av - bv;
          const am = a.candidates[0]?.stats.marginOverBreakevenPts ?? -Infinity;
          const bm = b.candidates[0]?.stats.marginOverBreakevenPts ?? -Infinity;
          return bm - am;
        });

        const withCandidates = scans.filter((s) => s.candidates.length > 0).length;
        const discarded = scans.filter((s) => s.candidates.length === 0).length;

        send({
          type: "done",
          bias,
          scans,
          meta: {
            bias,
            source,
            scanned: SPREAD_UNIVERSE.length,
            failed,
            withCandidates,
            discarded,
            degraded: failed > SPREAD_UNIVERSE.length / 2,
            macroStale: macro.stale,
            expert,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado en el escaneo.";
        send({ type: "error", kind: "generic", message });
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
