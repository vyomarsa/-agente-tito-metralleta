// Cliente Schwab específico del Agente 0DTE. Reutiliza el OAuth real
// (`getAccessToken` de ./schwab, ahora exportado) en vez de duplicarlo — el
// resto (parseo de la cadena con griegos, pricehistory) es propio porque el
// `schwab.ts` real no propaga bid/griegos a `RawContract`/`Row` (el resto del
// proyecto no los necesita) ni tiene `pricehistory`. Ver plan de port.

import { getAccessToken, SchwabError } from "./schwab";
import type { ZContractGreeks, ZRow } from "./zerodteTypes";

const API_BASE =
  process.env.SCHWAB_API_BASE ?? "https://api.schwabapi.com/marketdata/v1";

/** Schwab usa centinelas en vez de null cuando un griego no está disponible. */
const SENTINELS = new Set([-999, -1, 999]);

function num(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (SENTINELS.has(v)) return null;
  return v;
}

function pos(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

interface SchwabOption {
  putCall?: string;
  bid?: number;
  ask?: number;
  totalVolume?: number;
  openInterest?: number;
  volatility?: number; // en PORCENTAJE (30.53)
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  strikePrice?: number;
  symbol?: string;
}

interface SchwabChainResponse {
  isDelayed?: boolean;
  underlyingPrice?: number;
  callExpDateMap?: Record<string, Record<string, SchwabOption[]>>;
  putExpDateMap?: Record<string, Record<string, SchwabOption[]>>;
}

function toGreeks(o: SchwabOption): ZContractGreeks | null {
  const delta = num(o.delta);
  const gamma = num(o.gamma);
  const theta = num(o.theta);
  const vega = num(o.vega);
  const ivPct = num(o.volatility);
  if (delta == null && gamma == null && theta == null && vega == null && ivPct == null) {
    return null;
  }
  return { delta, gamma, theta, vega, iv: ivPct != null ? ivPct / 100 : null };
}

/** Aplana callExpDateMap/putExpDateMap de Schwab a ZRow[]. PURA, testeable. */
export function parseZeroDteChain(
  json: SchwabChainResponse,
): { rows: ZRow[]; underlyingPrice: number | null; delayed: boolean } {
  const rows: ZRow[] = [];
  const walk = (map: SchwabChainResponse["callExpDateMap"], contractType: "call" | "put") => {
    if (!map) return;
    for (const [expKey, strikes] of Object.entries(map)) {
      const expiration = expKey.split(":")[0] ?? "";
      for (const list of Object.values(strikes)) {
        for (const o of list) {
          const strike = num(o.strikePrice);
          if (strike == null) continue;
          rows.push({
            optionTicker: o.symbol?.replace(/\s+/g, "") ?? "",
            contractType,
            expiration,
            strike,
            openInterest: num(o.openInterest) ?? 0,
            volume: num(o.totalVolume) ?? 0,
            bid: pos(o.bid),
            ask: pos(o.ask),
            greeks: toGreeks(o),
          });
        }
      }
    }
  };
  walk(json.callExpDateMap, "call");
  walk(json.putExpDateMap, "put");
  return {
    rows,
    underlyingPrice: num(json.underlyingPrice),
    delayed: Boolean(json.isDelayed),
  };
}

/**
 * Cadena de UN solo vencimiento (fromDate = toDate = day), ya parseada con
 * griegos reales. No pasa por el chunking de `fetchOptionChain` real (pensado
 * para la cadena completa multi-vencimiento) — una sola fecha nunca desborda
 * el límite de 10MB del gateway de Schwab.
 */
export async function fetchZeroDteChain(
  symbol: string,
  day: string,
): Promise<{ rows: ZRow[]; underlyingPrice: number | null; delayed: boolean }> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    symbol,
    contractType: "ALL",
    includeUnderlyingQuote: "true",
    fromDate: day,
    toDate: day,
    strikeCount: "500",
  });
  const res = await fetch(`${API_BASE}/chains?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(
      `Schwab respondió ${res.status} para ${symbol}. ${body.slice(0, 160)}`.trim(),
      res.status,
    );
  }
  const json = (await res.json()) as SchwabChainResponse;
  return parseZeroDteChain(json);
}

export interface IntradayBar {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SchwabCandle {
  open?: number; high?: number; low?: number; close?: number; datetime?: number;
}

/**
 * Barras intradía del subyacente (Schwab `pricehistory`) filtradas a la sesión
 * más reciente. `symbol` ya debe venir normalizado (p. ej. "$SPX"). Massive no
 * autoriza barras de índice; Schwab sí.
 */
export async function fetchIntradayBars(symbol: string, minutes = 5): Promise<IntradayBar[]> {
  const token = await getAccessToken();
  const now = Date.now();
  const params = new URLSearchParams({
    symbol,
    frequencyType: "minute",
    frequency: String(minutes),
    needExtendedHoursData: "false",
    startDate: String(now - 36 * 60 * 60 * 1000),
    endDate: String(now),
  });
  const res = await fetch(`${API_BASE}/pricehistory?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new SchwabError(`Schwab respondió ${res.status} en /pricehistory para ${symbol}.`, res.status);
  }
  const json = (await res.json()) as { candles?: SchwabCandle[] };
  if (!Array.isArray(json.candles)) return [];
  const all = json.candles
    .filter((c) => c.datetime != null && c.open != null)
    .map((c) => ({
      time: Math.floor((c.datetime as number) / 1000),
      open: c.open as number,
      high: c.high as number,
      low: c.low as number,
      close: c.close as number,
    }));
  if (all.length === 0) return [];
  const etDay = (sec: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(sec * 1000);
  const lastDay = etDay(all[all.length - 1].time);
  return all.filter((b) => etDay(b.time) === lastDay);
}

/** Barras intradía de varias sesiones (para revisar pronósticos pasados). */
export async function fetchIntradayBarsRange(
  symbol: string,
  days = 10,
  minutes = 5,
): Promise<IntradayBar[]> {
  const token = await getAccessToken();
  const now = Date.now();
  const params = new URLSearchParams({
    symbol,
    frequencyType: "minute",
    frequency: String(minutes),
    needExtendedHoursData: "false",
    startDate: String(now - days * 24 * 60 * 60 * 1000),
    endDate: String(now),
  });
  const res = await fetch(`${API_BASE}/pricehistory?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new SchwabError(`Schwab respondió ${res.status} en /pricehistory para ${symbol}.`, res.status);
  }
  const json = (await res.json()) as { candles?: SchwabCandle[] };
  if (!Array.isArray(json.candles)) return [];
  return json.candles
    .filter((c) => c.datetime != null && c.open != null)
    .map((c) => ({
      time: Math.floor((c.datetime as number) / 1000),
      open: c.open as number,
      high: c.high as number,
      low: c.low as number,
      close: c.close as number,
    }));
}
