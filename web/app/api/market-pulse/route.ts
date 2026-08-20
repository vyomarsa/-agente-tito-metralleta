// GET /api/market-pulse — VIX + sentimiento del mercado para los medidores.
//
// Tres fuentes, cada una en su try/catch: si una falla, el medidor sigue con las
// otras y el motor RENORMALIZA los pesos (nunca rellena el hueco con un 50).
//   · VIX      → Schwab (Massive no está autorizado para índices).
//   · Momento  → barras diarias de SPY (Massive) contra su media de 125 sesiones.
//   · Put/Call → prima ejecutada hoy en TODO el mercado (MarketSnack).
//
// CACHE EN MEMORIA obligatorio: este endpoint lo pide la barra lateral, que vive en
// TODAS las páginas. Sin cache, cada navegación relanzaría un escaneo paginado del
// mercado entero contra MarketSnack.

import { fetchDailyBars } from "@/lib/massive";
import { fetchQuote, SchwabError } from "@/lib/schwab";
import { fetchMarketFlow } from "@/lib/marketsnack";
import { classifyFlow } from "@/lib/flow";
import { sma } from "@/lib/sma";
import { buildPulseComponents, marketSentiment, vixState } from "@/lib/marketPulse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Símbolo del VIX en Schwab (los índices llevan `$`). */
const VIX_SYMBOL = "$VIX";
/** Sesiones de la media de momento (el mismo criterio de momento que usa CNN). */
const MOMENTUM_PERIOD = 125;
/** Días naturales de barras a pedir para que quepan 125 sesiones con holgura. */
const BARS_DAYS = 270;
/** Solo tickets grandes: el put/call de mercado no lo mueve el minorista. */
const FLOW_MIN_PREMIUM = 100_000;
const FLOW_MAX_PAGES = 6;
/** Vida del cache. El pulso del mercado no cambia de minuto a minuto. */
const CACHE_MS = 5 * 60_000;

/** Estado del VIX. `needs_auth` = hay que volver a conectar Schwab en /schwab. */
export type VixStatus = "ok" | "needs_auth" | "error";

interface Payload {
  vix: {
    value: number;
    change: number | null;
    changePercent: number | null;
    state: ReturnType<typeof vixState>;
    /** Mercado cerrado: Schwab manda netChange 0 y no hay "hoy" que enseñar. */
    closed: boolean;
    /** Variación de la ÚLTIMA sesión (apertura → cierre), que sí es informativa. */
    sessionChangePct: number | null;
  } | null;
  vixStatus: VixStatus;
  vixError: string | null;
  sentiment: ReturnType<typeof marketSentiment>;
  updatedAt: string;
  /** Fuentes que fallaron, para poder avisar en la tarjeta sin mentir. */
  missing: string[];
}

let cache: { at: number; payload: Payload } | null = null;

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return Response.json({ ...cache.payload, cached: true });
  }

  const missing: string[] = [];

  // Las tres en paralelo; cada una se traga su propio error, pero se GUARDA el
  // motivo: "falta el VIX" sin decir por qué no se puede diagnosticar desde la UI.
  let vixError: string | null = null;
  let vixNeedsAuth = false;
  const [vixQuote, bars, flow] = await Promise.all([
    fetchQuote(VIX_SYMBOL).catch((e: unknown) => {
      vixError = e instanceof Error ? e.message : String(e);
      vixNeedsAuth = e instanceof SchwabError && Boolean(e.needsAuth);
      return null;
    }),
    fetchDailyBars("SPY", BARS_DAYS).catch(() => []),
    fetchMarketFlow({ period: "1d", minPremium: FLOW_MIN_PREMIUM, maxPages: FLOW_MAX_PAGES })
      .catch(() => null),
  ]);

  // ── VIX ──
  const vixValue = vixQuote?.last ?? vixQuote?.close ?? null;
  if (vixValue == null) {
    missing.push(vixError ? `VIX (Schwab): ${vixError}` : "VIX (Schwab): sin cotización");
  }

  // ── Momento: SPY contra su media de 125 sesiones ──
  const closes = bars.map((b) => b.close).filter((c) => c > 0);
  const spySma = sma(closes, MOMENTUM_PERIOD);
  const spyPrice = closes.length > 0 ? closes[closes.length - 1] : null;
  if (spySma == null) missing.push(`momento (hacen falta ${MOMENTUM_PERIOD} sesiones de SPY)`);

  // ── Put/Call: reparto de la prima ejecutada hoy en todo el mercado ──
  let callPremium = 0, putPremium = 0;
  if (flow) {
    const { rows } = classifyFlow(flow.trades, new Date());
    for (const r of rows) {
      if (r.type === "call") callPremium += r.premium;
      else if (r.type === "put") putPremium += r.premium;
    }
  } else {
    missing.push("flujo del mercado (MarketSnack)");
  }

  const components = buildPulseComponents({
    vix: vixValue,
    spyPrice,
    spySma125: spySma,
    callPremium,
    putPremium,
  });

  const payload: Payload = {
    vix: vixValue != null
      ? {
          value: vixValue,
          change: vixQuote?.netChange ?? null,
          changePercent: vixQuote?.netPercentChange ?? null,
          state: vixState(vixValue),
          closed: (vixQuote?.securityStatus ?? "").toLowerCase() === "closed",
          sessionChangePct:
            vixQuote?.open != null && vixQuote.open > 0 && vixQuote.close != null
              ? ((vixQuote.close - vixQuote.open) / vixQuote.open) * 100
              : null,
        }
      : null,
    vixStatus: vixValue != null ? "ok" : vixNeedsAuth ? "needs_auth" : "error",
    vixError,
    sentiment: marketSentiment(components),
    updatedAt: new Date().toISOString(),
    missing,
  };

  cache = { at: Date.now(), payload };
  return Response.json({ ...payload, cached: false });
}
