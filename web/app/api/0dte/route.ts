// GET /api/0dte?ticker=SPY — Cadena 0DTE (cero días al vencimiento) en JSON.
//
// Fuente = MarketSnack Option Chain 2.0 (greeks/IV/OI/volumen REALES por contrato)
// para el vencimiento de HOY; spot y variación desde Massive; barras diarias para
// la IV de respaldo. Motor puro en lib/zerodte.ts. Guarda una foto para la memoria.

import { fetchCompany, fetchDailyBars, MassiveError } from "@/lib/massive";
import { fetchExpirations, fetchOptionChain2, MarketSnackError } from "@/lib/marketsnack";
import { normalizeChain2, dteOf } from "@/lib/optionChain2";
import { buildZeroDte, estimateSpotFromChain } from "@/lib/zerodte";
import { saveZeroDtePrediction } from "@/lib/zerodteStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Índices/ETFs 0DTE soportados. SPX se marca experimental (validación). */
const ALLOWED = new Set(["SPY", "QQQ", "SPX", "IWM"]);
const TRADING_MINUTES = 390; // 9:30–16:00 ET

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

/**
 * Fracción de la sesión de HOY que resta (en "días" para el cono) y minutos
 * restantes. 1 = jornada completa por delante. Para vencimientos futuros se le
 * suma el nº de días hasta ese vencimiento (ver `horizonDays` en el handler).
 */
function sessionFractionToday(now: Date): { fractionToday: number; minutesLeft: number } {
  const min = etMinutes(now);
  if (min == null) return { fractionToday: 1, minutesLeft: TRADING_MINUTES };
  const open = 9 * 60 + 30; // 9:30
  const close = 16 * 60;    // 16:00
  if (min <= open) return { fractionToday: 1, minutesLeft: TRADING_MINUTES };
  if (min >= close) return { fractionToday: 0, minutesLeft: 0 }; // cerrado → hoy ya no queda sesión
  const left = close - min;
  return { fractionToday: left / TRADING_MINUTES, minutesLeft: left };
}

const MAX_EXPIRATIONS = 8; // cuántos vencimientos futuros ofrecer en el selector

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  const requestedExp = (searchParams.get("exp") ?? "").trim(); // YYYY-MM-DD opcional

  if (!ALLOWED.has(ticker)) {
    return Response.json(
      { error: `0DTE soportado solo para: ${[...ALLOWED].join(", ")}.` },
      { status: 400 },
    );
  }

  const now = new Date();

  try {
    const expirations = await fetchExpirations(ticker);
    if (expirations.length === 0) {
      return Response.json(
        { error: `MarketSnack no devolvió vencimientos para ${ticker}. ${ticker === "SPX" ? "SPX es experimental: prueba SPY o QQQ." : ""}`.trim() },
        { status: 502 },
      );
    }

    // Vencimientos futuros disponibles (dte>=0) para el selector, más cercano primero.
    const dates = expirations.map((e) => e.date).sort((a, b) => a.localeCompare(b));
    const futureDates = dates.filter((d) => dteOf(d, now) >= 0);
    const available = futureDates
      .slice(0, MAX_EXPIRATIONS)
      .map((d) => ({ date: d, dte: dteOf(d, now) }));

    // 0DTE = vencimiento de HOY si existe; si no, el más cercano (isToday=false).
    const todayExp = dates.find((d) => dteOf(d, now) === 0);
    const nearest = futureDates[0] ?? dates[dates.length - 1];
    // Si el usuario pidió un vencimiento válido y disponible, se respeta; si no, 0DTE.
    const validRequested = requestedExp && available.some((a) => a.date === requestedExp)
      ? requestedExp
      : null;
    const expiration = validRequested ?? todayExp ?? nearest;
    const isToday = expiration === todayExp;
    const selectedDte = dteOf(expiration, now);

    const [rawChain, company, bars] = await Promise.all([
      fetchOptionChain2(ticker, expiration),
      fetchCompany(ticker).catch(() => null),
      fetchDailyBars(ticker, 60).catch(() => []),
    ]);

    const contracts = normalizeChain2(rawChain);
    // Massive no da precio para índices (SPX usa `I:SPX`); derivamos el spot de la
    // paridad put-call sobre la propia cadena como respaldo.
    const spot = company?.price ?? estimateSpotFromChain(contracts);

    if (!spot || spot <= 0) {
      return Response.json({ error: `No se pudo obtener el precio (spot) de ${ticker}.` }, { status: 502 });
    }
    if (contracts.length === 0) {
      return Response.json({ error: `Cadena 0DTE vacía para ${ticker} (${expiration}).` }, { status: 502 });
    }

    // Horizonte del cono: fracción que resta HOY + días completos hasta el vencimiento.
    const { fractionToday, minutesLeft } = sessionFractionToday(now);
    const horizonDays = Math.max(fractionToday + selectedDte, 1 / TRADING_MINUTES);
    const analysis = buildZeroDte({
      contracts,
      spot,
      closes: bars.map((b) => b.close),
      now,
      horizonDays,
    });

    // Foto para la memoria (solo el vencimiento de HOY; best-effort).
    if (isToday) {
      void saveZeroDtePrediction(ticker, {
        spot,
        base: analysis.scenarios.base.target,
        bull: analysis.scenarios.bull.target,
        bear: analysis.scenarios.bear.target,
        lean: analysis.lean,
        confidence: analysis.confidence,
      }, now).catch(() => null);
    }

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
      analysis,
    });
  } catch (err) {
    const message =
      err instanceof MarketSnackError || err instanceof MassiveError
        ? err.message
        : "Error inesperado al construir la cadena 0DTE.";
    return Response.json({ error: message }, { status: 502 });
  }
}
