// GET /api/vecinos?ticker=SPY[&exp=YYYY-MM-DD] — CONTRATOS VECINOS 2.0.
//
// Reúne las DOS fuentes que pide el método y llama al motor puro (lib/vecinos.ts):
//   (1) cadena 0DTE con GRIEGOS REALES + Open Interest → MarketSnack Option Chain 2.0
//       (gamma real por contrato; nada de Black-Scholes estimado).
//   (2) net premium REAL ejecutado hoy por strike/tipo, separando la compra agresiva
//       (al ASK) de la venta agresiva (al BID) → Time & Sales de MarketSnack.
// El spot sale de Massive y, para índices que Massive no cotiza, de la paridad
// put-call de la propia cadena. Las barras diarias solo sirven de IV de respaldo.

import { fetchCompany, fetchDailyBars, MassiveError } from "@/lib/massive";
import { fetchExpirations, fetchFlow, fetchOptionChain2, MarketSnackError } from "@/lib/marketsnack";
import { normalizeChain2, dteOf } from "@/lib/optionChain2";
import { estimateSpotFromChain, representativeIv } from "@/lib/zerodte";
import { classifyFlow } from "@/lib/flow";
import { buildVecinos, netPremiumByStrike } from "@/lib/vecinos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Índices/ETFs con cadena 0DTE y cobertura de flujo real en MarketSnack. */
const ALLOWED = new Set(["SPY", "QQQ", "IWM", "SPX", "NDX"]);
const TRADING_MINUTES = 390; // 9:30–16:00 ET
const MAX_EXPIRATIONS = 6;   // vencimientos que ofrece el selector
/** El 0DTE mueve tickets chicos: el piso de premium va bajo a propósito. */
const MIN_PREMIUM = 25_000;
const MAX_PAGES = 8;

/**
 * EXTRA del método — confirmación cruzada con el índice hermano. Está pensada para
 * FUTUROS (SPX para ES, NDX para NQ) y solo cuando el propio instrumento NO tiene
 * cobertura de flujo real. Hoy el mapa va VACÍO a propósito: MarketSnack no sirve
 * futuros (comprobado ago 2026 — `NQ` devuelve 404 y `ES` resuelve a la acción
 * Eversource, no al futuro), y los cinco instrumentos de ALLOWED sí tienen flujo
 * propio, así que la regla no aplicaría a ninguno. El motor ya sabe qué hacer con
 * el dato: en cuanto exista una fuente de futuros basta con añadir aquí la entrada.
 */
const SIBLING_INDEX: Record<string, string> = {};

/** Minutos desde medianoche en ET para `now` (null si no se puede). */
function etMinutes(now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}

/** Fracción de la sesión de HOY que resta (las "horas al cierre" del Paso 5). */
function sessionFractionToday(now: Date): { fractionToday: number; minutesLeft: number } {
  const min = etMinutes(now);
  if (min == null) return { fractionToday: 1, minutesLeft: TRADING_MINUTES };
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (min <= open) return { fractionToday: 1, minutesLeft: TRADING_MINUTES };
  if (min >= close) return { fractionToday: 0, minutesLeft: 0 };
  const left = close - min;
  return { fractionToday: left / TRADING_MINUTES, minutesLeft: left };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  const requestedExp = (searchParams.get("exp") ?? "").trim();

  if (!ALLOWED.has(ticker)) {
    return Response.json(
      { error: `Contratos Vecinos soporta solo: ${[...ALLOWED].join(", ")}.` },
      { status: 400 },
    );
  }

  const now = new Date();

  try {
    const expirations = await fetchExpirations(ticker);
    if (expirations.length === 0) {
      return Response.json(
        { error: `MarketSnack no devolvió vencimientos para ${ticker}.` },
        { status: 502 },
      );
    }

    const dates = expirations.map((e) => e.date).sort((a, b) => a.localeCompare(b));
    const futureDates = dates.filter((d) => dteOf(d, now) >= 0);
    const available = futureDates
      .slice(0, MAX_EXPIRATIONS)
      .map((d) => ({ date: d, dte: dteOf(d, now) }));

    // 0DTE = el vencimiento de HOY si existe; si no (fin de semana, festivo), el más
    // cercano. El usuario puede forzar otro con ?exp= si está en la lista.
    const todayExp = dates.find((d) => dteOf(d, now) === 0);
    const nearest = futureDates[0] ?? dates[dates.length - 1];
    const validRequested =
      requestedExp && available.some((a) => a.date === requestedExp) ? requestedExp : null;
    const expiration = validRequested ?? todayExp ?? nearest;
    const isToday = expiration === todayExp;
    const selectedDte = dteOf(expiration, now);

    const [rawChain, company, bars, flowResult] = await Promise.all([
      fetchOptionChain2(ticker, expiration),
      fetchCompany(ticker).catch(() => null),
      fetchDailyBars(ticker, 60).catch(() => []),
      fetchFlow(ticker, { period: "1d", minPremium: MIN_PREMIUM, maxPages: MAX_PAGES })
        .catch(() => null), // sin flujo la señal sigue: cae al respaldo estructural (2b)
    ]);

    const contracts = normalizeChain2(rawChain);
    if (contracts.length === 0) {
      return Response.json(
        { error: `Cadena vacía para ${ticker} (${expiration}).` },
        { status: 502 },
      );
    }

    // Massive no cotiza índices con el ticker pelón (SPX/NDX): respaldo por paridad.
    const spot = company?.price ?? estimateSpotFromChain(contracts);
    if (!spot || spot <= 0) {
      return Response.json(
        { error: `No se pudo obtener el precio (spot) de ${ticker}.` },
        { status: 502 },
      );
    }

    const closes = bars.map((b) => b.close);
    const iv = representativeIv(contracts, closes);

    const rows = flowResult ? classifyFlow(flowResult.trades, now).rows : [];
    const flow = netPremiumByStrike(rows, expiration);

    const { fractionToday, minutesLeft } = sessionFractionToday(now);
    const horizonDays = Math.max(fractionToday + selectedDte, 1 / TRADING_MINUTES);

    const siblingSymbol = SIBLING_INDEX[ticker];
    const sibling = siblingSymbol
      ? await siblingDirection(siblingSymbol, now).catch(() => null)
      : null;

    const signal = buildVecinos({ contracts, spot, iv, horizonDays, flow, sibling });

    return Response.json({
      ticker,
      expiration,
      isToday,
      selectedDte,
      available,
      minutesLeft,
      spot,
      spotSource: company?.price != null ? "quote" : "paridad",
      change: company?.change ?? null,
      changePercent: company?.changePercent ?? null,
      contractCount: contracts.length,
      flowTrades: rows.filter((r) => r.expiration === expiration).length,
      flowStrikes: flow.size,
      flowAvailable: flowResult != null,
      updatedAt: now.toISOString(),
      signal,
    });
  } catch (err) {
    const message =
      err instanceof MarketSnackError || err instanceof MassiveError
        ? err.message
        : "Error inesperado al construir la señal de Contratos Vecinos.";
    return Response.json({ error: message }, { status: 502 });
  }
}

/**
 * Dirección del índice hermano para el EXTRA: se corre el MISMO Paso 1 (imán del
 * GEX contra la grilla real) sobre su cadena 0DTE. No hace falta su flujo: lo único
 * que el método toma prestado del hermano es la DIRECCIÓN, no sus confirmaciones.
 */
async function siblingDirection(symbol: string, now: Date) {
  const exps = await fetchExpirations(symbol);
  const dates = exps.map((e) => e.date).sort((a, b) => a.localeCompare(b));
  const exp = dates.find((d) => dteOf(d, now) === 0) ?? dates.find((d) => dteOf(d, now) > 0);
  if (!exp) return null;

  const [raw, company] = await Promise.all([
    fetchOptionChain2(symbol, exp),
    fetchCompany(symbol).catch(() => null),
  ]);
  const contracts = normalizeChain2(raw);
  const spot = company?.price ?? estimateSpotFromChain(contracts);
  if (!spot || spot <= 0 || contracts.length === 0) return null;

  const s = buildVecinos({
    contracts, spot, iv: representativeIv(contracts, []), horizonDays: 1,
    flow: new Map(),
  });
  return { symbol, direction: s.direction };
}
