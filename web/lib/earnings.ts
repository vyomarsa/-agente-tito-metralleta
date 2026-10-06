// Calendario de earnings — desde TASTYTRADE.
//
// Antes esto era un ESTIMADOR sobre Massive: el plan no traía calendario, así que
// se proyectaba el próximo reporte a ~91 días del último `filing_date` de
// `/vX/reference/financials`. Con Massive fuera (directiva del dueño) y con
// Tastytrade sirviendo `earnings.expected-report-date` en `/market-metrics`, ya no
// hace falta estimar nada: se pide la fecha.
//
// **Esto NO es cosmético.** El filtro de earnings del mandato de venta de prima no
// admite excepciones, y con el plan de Massive cancelado `fetchFilingDates`
// devolvía `[]` en silencio → `no_aplica` → el filtro llevaba meses INERTE, dejando
// pasar tickers que reportaban dentro del vencimiento.
//
// La parte pura (`earningsFlag`, `earningsDeFecha`) no toca red.

import { fetchMarketMetrics, tastytradeConfigured } from "./tastytrade";

/**
 * Bandera de earnings de un vencimiento. VIVE AQUÍ, no en wheel.ts, porque este
 * es el módulo que la CALCULA: la definía wheel.ts por accidente histórico y eso
 * ataba `creditSpread` (venta de prima) a la Wheel por un solo tipo.
 */
export type EarningsFlag = "fuera" | "dentro" | "dentro_confirmado" | "no_aplica";

// ── Parte pura ──────────────────────────────────────────────────────────────

/**
 * ¿Cae el reporte dentro del vencimiento?
 *
 * Asume que `nextEarnings` es una fecha FUTURA. Para una fecha que puede venir del
 * pasado —como las de Tastytrade— usa `earningsDeFecha`, que aplica esa regla
 * antes de llamar aquí.
 */
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

/**
 * Bandera a partir de la fecha CRUDA de Tastytrade.
 *
 * **La fecha de Tastytrade puede ser la del ÚLTIMO reporte, no la del próximo.**
 * Medido el 2026-09-07: GOOGL 22-jul, META y MSFT 29-jul, NVDA 26-ago, todas
 * pasadas. Como cualquier fecha pasada es anterior al vencimiento, `earningsFlag`
 * las leía como "dentro" y bloqueaba el ticker por un reporte de hacía semanas —
 * en la pestaña de scalping eso fue **cuatro de los seis rojos de ese día**.
 *
 * Una fecha pasada significa "ya reportó", y el siguiente está a un trimestre:
 * para un vencimiento de esta semana, eso es **fuera**.
 */
export function earningsDeFecha(
  reportado: string | null,
  expiracion: string,
  hoy: string,
): EarningsFlag {
  if (!reportado) return "no_aplica";
  if (reportado < hoy) return "fuera";
  return earningsFlag({ nextEarnings: reportado, expiration: expiracion, frontSkew: null });
}

// ── Fetch (I/O — no se testea) ─────────────────────────────────────────────

/**
 * Cache de fechas de reporte.
 *
 * Una fecha de earnings se mueve una vez por trimestre, así que 12 h es
 * conservador de sobra y evita que un escaneo de 102 símbolos vuelva a pedir lo
 * mismo en la pasada siguiente. `null` (el ticker no reporta, o Tastytrade no lo
 * cubre) también se cachea: sin eso, los ETFs del universo repreguntarían en cada
 * pasada — el mismo cache negativo que hizo falta en `marketCapStore`.
 *
 * En `globalThis` porque Next recarga módulos en desarrollo.
 */
const TTL_MS = 12 * 60 * 60 * 1000;

interface Entrada { at: number; date: string | null }
const cache: Map<string, Entrada> =
  (globalThis as { __earningsCache?: Map<string, Entrada> }).__earningsCache ??
  ((globalThis as { __earningsCache?: Map<string, Entrada> }).__earningsCache = new Map());

function vigente(k: string, now: number): Entrada | null {
  const e = cache.get(k);
  return e && now - e.at < TTL_MS ? e : null;
}

/**
 * Pide en UNA llamada las fechas de muchos símbolos y llena el cache.
 *
 * `/market-metrics` acepta la lista entera, así que el escaneo de venta de prima
 * (102 símbolos) pasa de 102 peticiones a 1. Llamar a esto antes del bucle es
 * opcional: sin él, `earningsForTicker` funciona igual, solo que de uno en uno.
 */
export async function prefetchEarningsDates(symbols: string[], now = Date.now()): Promise<void> {
  if (!tastytradeConfigured()) return;
  const faltan = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))]
    .filter((s) => !vigente(s, now));
  if (faltan.length === 0) return;

  try {
    const metricas = await fetchMarketMetrics(faltan);
    const porSimbolo = new Map(metricas.map((m) => [m.symbol.toUpperCase(), m.earningsDate ?? null]));
    // Se apuntan TODOS los pedidos, no solo los que volvieron: un símbolo que
    // Tastytrade no cubre es un `null` legítimo, y no cachearlo lo convierte en
    // una petición perdida en cada pasada.
    for (const s of faltan) cache.set(s, { at: now, date: porSimbolo.get(s) ?? null });
  } catch {
    // Best-effort: si falla, cada ticker lo intentará por su cuenta y, si tampoco,
    // la bandera sale "no_aplica" y quien la consume ya avisa de que no se sabe.
  }
}

/** Fecha de reporte de un ticker (cacheada). `null` si no reporta o no se sabe. */
export async function fetchEarningsDate(ticker: string, now = Date.now()): Promise<string | null> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return null;
  const ya = vigente(clean, now);
  if (ya) return ya.date;
  if (!tastytradeConfigured()) return null;

  try {
    const m = await fetchMarketMetrics([clean]);
    const date = m.find((x) => x.symbol.toUpperCase() === clean)?.earningsDate ?? null;
    cache.set(clean, { at: now, date });
    return date;
  } catch {
    return null;
  }
}

/**
 * Bandera de earnings de un ticker sobre un vencimiento.
 *
 * NOTA (limitación declarada): `frontSkew` se conserva en la firma porque
 * `dentro_confirmado` lo necesita, pero los escaneos que llaman aquí no calculan
 * el skew del frente y pasan `null`. En la práctica el flag efectivo es
 * fuera/dentro/no_aplica.
 */
export async function earningsForTicker(input: {
  ticker: string;
  expiration: string;
  frontSkew: number | null;
  now: Date;
}): Promise<EarningsFlag> {
  const date = await fetchEarningsDate(input.ticker, input.now.getTime());
  const hoy = input.now.toISOString().slice(0, 10);
  if (!date) return "no_aplica";
  if (date < hoy) return "fuera";
  return earningsFlag({
    nextEarnings: date,
    expiration: input.expiration,
    frontSkew: input.frontSkew,
  });
}
