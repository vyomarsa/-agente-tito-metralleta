// Estimador del próximo reporte de resultados.
//
// El plan de Massive NO trae calendario de earnings (verificado: /benzinga/v1/earnings
// da 403, /v1/reference/earnings da 404). Se usan DOS proxies y la UI declara que
// es estimación:
//   1. Cadencia de filing_date de /vX/reference/financials (~91 días entre reportes).
//   2. El skew del frente que ivcontext ya calcula (>+10 pts = evento inminente).
//
// La parte pura (estimateNextEarnings, earningsFlag) no toca red.

/**
 * Bandera de earnings de un vencimiento. VIVE AQUÍ, no en wheel.ts, porque este
 * es el módulo que la CALCULA: la definía wheel.ts por accidente histórico y eso
 * ataba `creditSpread` (venta de prima) a la Wheel por un solo tipo.
 */
export type EarningsFlag = "fuera" | "dentro" | "dentro_confirmado" | "no_aplica";

const QUARTER_DAYS = 91;
const DAY = 24 * 60 * 60 * 1000;

function toDay(d: string | number): string {
  return new Date(typeof d === "number" ? d : `${d}T00:00:00Z`).toISOString().slice(0, 10);
}

/**
 * Estima la fecha del próximo reporte a partir de los filing_date pasados.
 * Toma el más reciente y avanza en saltos de ~91 días hasta pasar HOY.
 */
export function estimateNextEarnings(filingDates: string[], now: Date): string | null {
  const times = filingDates
    .map((d) => new Date(`${d}T00:00:00Z`).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length === 0) return null;

  let next = times[times.length - 1];
  const nowT = now.getTime();
  while (next <= nowT) next += QUARTER_DAYS * DAY;
  return toDay(next);
}

export function earningsFlag(input: {
  nextEarnings: string | null;
  expiration: string;
  /** Skew del frente en puntos, de ivcontext. null si no hay dato. */
  frontSkew: number | null;
}): EarningsFlag {
  if (!input.nextEarnings) return "no_aplica";
  const earnings = new Date(`${input.nextEarnings}T00:00:00Z`).getTime();
  const exp = new Date(`${input.expiration}T00:00:00Z`).getTime();
  if (earnings > exp) return "fuera";
  // Cae dentro del vencimiento. ¿Lo confirma el mercado?
  return (input.frontSkew ?? 0) > 10 ? "dentro_confirmado" : "dentro";
}

// ── Fetch (I/O — no se testea) ─────────────────────────────────────────

interface FinancialsResult {
  results?: { filing_date?: string }[];
}

/** Fechas de reporte pasadas de un ticker. Devuelve [] si el ticker no reporta (ETF). */
export async function fetchFilingDates(ticker: string): Promise<string[]> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) return [];
  const clean = ticker.trim().toUpperCase();
  const url =
    `https://api.massive.com/vX/reference/financials?ticker=${encodeURIComponent(clean)}` +
    `&timeframe=quarterly&limit=6&order=desc&sort=filing_date`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" })
    .catch(() => null);
  if (!res || !res.ok) return [];
  const json = (await res.json().catch(() => null)) as FinancialsResult | null;
  return (json?.results ?? [])
    .map((r) => r.filing_date)
    .filter((d): d is string => Boolean(d));
}

// NOTA (limitación declarada): el escaneo Wheel real (app/api/wheel/route.ts)
// siempre llama a esta función con frontSkew: null, porque ese escaneo no
// calcula ivContextScore por ticker (no tiene el flujo de MarketSnack por
// símbolo). En consecuencia, HOY "dentro_confirmado" es INALCANZABLE en
// producción: el flag efectivo es únicamente la cadencia de filing_date (el
// "doble proxy" descrito arriba es, en la práctica, un proxy único). El
// parámetro frontSkew se conserva para el día en que el skew esté disponible
// en el escaneo Wheel; los tests unitarios de este módulo sí lo ejercitan
// pasando un valor > 10 a propósito, y eso está bien.
export async function earningsForTicker(input: {
  ticker: string;
  expiration: string;
  frontSkew: number | null;
  now: Date;
}): Promise<EarningsFlag> {
  const filings = await fetchFilingDates(input.ticker);
  const nextEarnings = estimateNextEarnings(filings, input.now);
  return earningsFlag({ nextEarnings, expiration: input.expiration, frontSkew: input.frontSkew });
}
