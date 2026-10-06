// ============================================================================
// Cliente de Charles Schwab (Market Data). Solo se usa en el servidor.
//
// Reemplaza a Massive como fuente del Option Chain porque entrega lo que el
// Proceso Principal pide y Massive no daba en este plan:
//   · BID real  → Open Premium = OI × Bid, tal como está especificado
//   · griegos reales (delta/gamma/theta/vega/rho) e IV por contrato
//   · openInterest y totalVolume
//
// Auth: OAuth2 client_credentials. El token dura 3600 s y se cachea en memoria.
// Salvedad: los datos vienen con RETRASO (el chain trae `isDelayed`).
// ============================================================================

import type { ContractGreeks, RawContract } from "./types";
import { getAccessToken as titoAccessToken } from "@/lib/schwab";

const TOKEN_URL =
  process.env.SCHWAB_TOKEN_URL ?? "https://api.schwabapi.com/v1/oauth/token";
const API_BASE =
  process.env.SCHWAB_API_BASE ?? "https://api.schwabapi.com/marketdata/v1";

/** Schwab usa centinelas en vez de null cuando un griego no está disponible. */
const SENTINELS = new Set([-999, -1, 999]);

export class SchwabError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SchwabError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- token cache

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Invalida el token en caché (para tests o tras un 401). */
export function resetSchwabToken(): void {
  cachedToken = null;
}

function credentials(): { id: string; secret: string } {
  const id = process.env.SCHWAB_CLIENT_ID;
  const secret = process.env.SCHWAB_CLIENT_SECRET;
  if (!id || !secret) {
    throw new SchwabError(
      "Faltan SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET en el entorno (.env.local).",
    );
  }
  return { id, secret };
}

/**
 * Token de acceso, cacheado en memoria. Se renueva 60 s antes de expirar para
 * no quedarse con uno vencido a mitad de una petición.
 */
export async function getAccessToken(): Promise<string> {
  // Integrado en Tito: usa el token OAuth que Tito ya mantiene (data/schwab-tokens.json,
  // se autoriza en /schwab) en vez de un token propio de esta sección.
  try {
    return await titoAccessToken();
  } catch (err) {
    throw new SchwabError(err instanceof Error ? err.message : String(err));
  }
}

// ------------------------------------------------------------------- parseo

/** Forma de un contrato dentro de callExpDateMap / putExpDateMap. */
export interface SchwabOption {
  putCall?: string;
  symbol?: string;
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  closePrice?: number;
  totalVolume?: number;
  openInterest?: number;
  volatility?: number; // en PORCENTAJE (30.53)
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  strikePrice?: number;
  daysToExpiration?: number;
  multiplier?: number;
}

export interface SchwabChainResponse {
  symbol?: string;
  status?: string;
  isDelayed?: boolean;
  underlyingPrice?: number;
  numberOfContracts?: number;
  callExpDateMap?: Record<string, Record<string, SchwabOption[]>>;
  putExpDateMap?: Record<string, Record<string, SchwabOption[]>>;
}

/** Descarta centinelas y no-números. */
function num(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (SENTINELS.has(v)) return null;
  return v;
}

/** Positivo estricto (para precios: Schwab manda 0.0 cuando no hay quote). */
function pos(v: unknown): number | undefined {
  const n = num(v);
  return n !== null && n > 0 ? n : undefined;
}

/**
 * Clave de vencimiento de Schwab: "2026-07-24:0" → "2026-07-24".
 */
export function parseExpirationKey(key: string): string {
  return key.split(":")[0] ?? "";
}

/**
 * Símbolo de Schwab ("AAPL  260724C00322500", con relleno) al formato que ya usa
 * el proyecto ("O:AAPL260724C00322500", estilo Massive/OCC compacto).
 */
export function toOccTicker(schwabSymbol: string | undefined): string {
  if (!schwabSymbol) return "";
  const compact = schwabSymbol.replace(/\s+/g, "");
  return compact ? `O:${compact}` : "";
}

function toGreeks(o: SchwabOption): ContractGreeks {
  const ivPct = num(o.volatility);
  return {
    delta: num(o.delta),
    gamma: num(o.gamma),
    theta: num(o.theta),
    vega: num(o.vega),
    rho: num(o.rho),
    // Schwab entrega la IV en porcentaje; el resto del proyecto la usa en decimal.
    iv: ivPct !== null ? ivPct / 100 : null,
  };
}

/** Convierte un contrato de Schwab al RawContract normalizado del proyecto. */
export function toRawContract(
  o: SchwabOption,
  expiration: string,
  underlyingTicker: string,
  underlyingPrice: number | null,
): RawContract {
  const bid = pos(o.bid);
  const ask = pos(o.ask);
  return {
    details: {
      contract_type: o.putCall?.toLowerCase() === "put" ? "put" : "call",
      expiration_date: expiration,
      strike_price: num(o.strikePrice) ?? 0,
      shares_per_contract: num(o.multiplier) ?? 100,
      ticker: toOccTicker(o.symbol),
    },
    day: {
      volume: num(o.totalVolume) ?? 0,
      close: pos(o.closePrice),
    },
    last_trade: { price: pos(o.last) ?? pos(o.mark) },
    open_interest: num(o.openInterest) ?? 0,
    underlying_asset: {
      price: underlyingPrice ?? undefined,
      ticker: underlyingTicker,
    },
    quote: { bid, ask },
    greeks: toGreeks(o),
  };
}

export interface SchwabChainResult {
  contracts: RawContract[];
  underlyingPrice: number | null;
  delayed: boolean;
  expirationCount: number;
}

/**
 * Aplana la respuesta de Schwab (callExpDateMap + putExpDateMap) a una lista
 * plana de RawContract. PURA: sin red, testeable.
 */
export function parseSchwabChain(
  json: SchwabChainResponse,
  ticker: string,
): SchwabChainResult {
  const underlyingPrice = num(json.underlyingPrice);
  const contracts: RawContract[] = [];
  const expirations = new Set<string>();

  for (const map of [json.callExpDateMap, json.putExpDateMap]) {
    if (!map) continue;
    for (const [expKey, strikes] of Object.entries(map)) {
      const expiration = parseExpirationKey(expKey);
      if (expiration) expirations.add(expiration);
      for (const list of Object.values(strikes)) {
        for (const o of list) {
          contracts.push(toRawContract(o, expiration, ticker, underlyingPrice));
        }
      }
    }
  }

  // SPX en OpEx mensual (3er viernes): la cadena trae el SEMANAL PM (.SPXW → OCC
  // "O:SPXW…", el 0DTE que TRADEA) Y el MENSUAL AM (.SPX → "O:SPX…", que dejó de
  // cotizar el jueves y settla con la apertura). Ambos vencen hoy → sin filtrar, el
  // GEX suma el OI de los dos por strike (imán/flip/NetGEX erróneos). Nos quedamos
  // SOLO con el SPXW cuando existe. En días normales el SPX 0DTE ya es SPXW → inocuo.
  let out = contracts;
  if (ticker.toUpperCase() === "SPX") {
    const hasSpxw = contracts.some((c) => c.details?.ticker?.startsWith("O:SPXW"));
    if (hasSpxw) out = contracts.filter((c) => c.details?.ticker?.startsWith("O:SPXW"));
  }

  return {
    contracts: out,
    underlyingPrice,
    delayed: Boolean(json.isDelayed),
    expirationCount: expirations.size,
  };
}

// -------------------------------------------------------------------- fetch

export interface FetchChainOptions {
  /** Se llama con el avance del procesado. */
  onProgress?: (label: string, detail?: string) => void | Promise<void>;
  /** Limita el rango de vencimientos (días). Sin valor = toda la cadena. */
  maxDte?: number;
}

/**
 * Cortes en días para trocear la descarga.
 *
 * El gateway de Schwab corta el cuerpo de la respuesta alrededor de **10 MB**
 * y devuelve `502 {"errorcode":"protocol.http.TooBigBody"}`. Un subyacente con
 * vencimientos diarios (SPY, QQQ) no cabe entero: medido el 24-jul-2026, SPY
 * pesaba 9.0 MB a 90 días y reventaba a 180. Así que se pide por ventanas de
 * vencimiento y se fusiona. Los tramos son más finos cerca del spot, que es
 * donde se concentran los vencimientos.
 */
export const DTE_WINDOWS = [0, 30, 90, 180, 365, 1100];

/** Máximo de bisecciones cuando una ventana sigue siendo demasiado grande. */
const MAX_SPLIT_DEPTH = 4;

function maxDteDefault(): number | undefined {
  const n = Number(process.env.SCHWAB_MAX_DTE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(days: number): string {
  return ymd(new Date(Date.now() + days * 86_400_000));
}

/** ¿El fallo es por cuerpo demasiado grande? Entonces conviene partir la ventana. */
function isTooBigBody(status: number, body: string): boolean {
  return status === 502 && body.includes("TooBigBody");
}

/** Construye los tramos [desde, hasta] en días, respetando un tope opcional. */
export function dteWindows(maxDte?: number): Array<[number, number]> {
  const cuts = maxDte
    ? [...DTE_WINDOWS.filter((d) => d < maxDte), maxDte]
    : DTE_WINDOWS;
  const out: Array<[number, number]> = [];
  for (let i = 1; i < cuts.length; i++) out.push([cuts[i - 1], cuts[i]]);
  return out;
}

/** Una petición de cadena acotada por fechas. Devuelve null si la ventana no existe. */
async function fetchWindow(
  ticker: string,
  from: number,
  to: number,
  depth: number,
): Promise<SchwabChainResponse[]> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    symbol: ticker,
    contractType: "ALL",
    includeUnderlyingQuote: "true",
    fromDate: addDays(from),
    toDate: addDays(to),
  });

  const res = await fetch(`${API_BASE}/chains?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (res.ok) {
    const json = (await res.json()) as SchwabChainResponse;
    // Un tramo sin vencimientos responde SUCCESS con los mapas vacíos; es normal.
    return [json];
  }

  const body = await res.text().catch(() => "");

  // Cuerpo demasiado grande: partir la ventana por la mitad y reintentar.
  if (isTooBigBody(res.status, body) && depth < MAX_SPLIT_DEPTH && to - from > 1) {
    const mid = Math.floor((from + to) / 2);
    const [a, b] = await Promise.all([
      fetchWindow(ticker, from, mid, depth + 1),
      fetchWindow(ticker, mid + 1, to, depth + 1),
    ]);
    return [...a, ...b];
  }

  if (res.status === 401) resetSchwabToken();
  throw new SchwabError(describeStatus(res.status, ticker, body), res.status);
}

/**
 * Descarga la option chain completa desde Schwab, troceada por ventanas de
 * vencimiento y fusionada. Ver DTE_WINDOWS para el porqué del troceo.
 */
export async function fetchOptionChain(
  ticker: string,
  options: FetchChainOptions = {},
): Promise<SchwabChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new SchwabError("Ticker vacío.");

  const windows = dteWindows(options.maxDte ?? maxDteDefault());

  const contracts: RawContract[] = [];
  const expirations = new Set<string>();
  const seen = new Set<string>(); // dedupe: los bordes de ventana son inclusivos
  let underlyingPrice: number | null = null;
  let delayed = false;

  for (const [from, to] of windows) {
    await options.onProgress?.(
      `Descargando option chain de ${clean} desde Schwab…`,
      `vencimientos ${from}-${to} días`,
    );

    const responses = await fetchWindow(clean, from, to, 0);

    for (const json of responses) {
      if (json.status && json.status !== "SUCCESS" && json.status !== "NO_DATA") {
        continue;
      }
      const part = parseSchwabChain(json, clean);
      if (underlyingPrice === null) underlyingPrice = part.underlyingPrice;
      if (part.delayed) delayed = true;

      for (const c of part.contracts) {
        const key = c.details?.ticker ?? "";
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        contracts.push(c);
        const exp = c.details?.expiration_date;
        if (exp) expirations.add(exp);
      }
    }

    await options.onProgress?.(
      `Descargando option chain de ${clean} desde Schwab…`,
      `${contracts.length} contratos acumulados`,
    );
  }

  if (contracts.length === 0) {
    throw new SchwabError(`Schwab no devolvió contratos para "${clean}".`);
  }

  await options.onProgress?.(
    `Procesando ${contracts.length} contratos…`,
    `${expirations.size} vencimientos`,
  );

  return {
    contracts,
    underlyingPrice,
    delayed,
    expirationCount: expirations.size,
  };
}

/** Quote del subyacente (precio, rango del día, cierre previo). */
export interface SchwabQuote {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  prevClose: number | null;
}

interface SchwabQuoteRaw {
  quote?: {
    lastPrice?: number;
    netChange?: number;
    netPercentChange?: number;
    openPrice?: number;
    highPrice?: number;
    lowPrice?: number;
    totalVolume?: number;
    closePrice?: number;
  };
}

/**
 * Quote del subyacente. Cubre el hueco del snapshot de acción de Massive,
 * que este plan tampoco autoriza (403).
 */
export async function fetchQuote(ticker: string): Promise<SchwabQuote | null> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return null;

  const token = await getAccessToken();
  const res = await fetch(
    `${API_BASE}/quotes?symbols=${encodeURIComponent(clean)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!res.ok) {
    if (res.status === 401) resetSchwabToken();
    return null;
  }

  const json = (await res.json()) as Record<string, SchwabQuoteRaw>;
  const q = json[clean]?.quote;
  if (!q) return null;

  return {
    price: num(q.lastPrice),
    change: num(q.netChange),
    changePercent: num(q.netPercentChange),
    dayOpen: num(q.openPrice),
    dayHigh: num(q.highPrice),
    dayLow: num(q.lowPrice),
    dayVolume: num(q.totalVolume),
    prevClose: num(q.closePrice),
  };
}

/**
 * Precio en vivo de un futuro (p.ej. "/ES"). Schwab resuelve "/ES" al contrato
 * del frente (p.ej. "/ESU26"), así que la CLAVE de la respuesta no es "/ES" —
 * se toma la primera clave que no sea "errors". Devuelve null si falla.
 */
export async function fetchFuturePrice(symbol: string): Promise<number | null> {
  const clean = symbol.trim();
  if (!clean) return null;
  const token = await getAccessToken();
  const res = await fetch(
    `${API_BASE}/quotes?symbols=${encodeURIComponent(clean)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!res.ok) {
    if (res.status === 401) resetSchwabToken();
    return null;
  }
  const json = (await res.json()) as Record<string, { quote?: { lastPrice?: number; mark?: number } }>;
  const key = Object.keys(json).find((k) => k !== "errors");
  const q = key ? json[key]?.quote : undefined;
  return pos(q?.lastPrice) ?? pos(q?.mark) ?? null;
}

/** Barra intradía OHLC. `time` en segundos unix. */
export interface IntradayBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SchwabCandle {
  open?: number; high?: number; low?: number; close?: number; datetime?: number;
}

/**
 * Barras intradía del subyacente desde Schwab `pricehistory`. Solo servidor.
 *
 * Massive NO autoriza las barras de índice (I:SPX da NOT_AUTHORIZED), pero
 * Schwab sí las da para `$SPX`. `symbol` ya debe venir normalizado (`$SPX`).
 *
 * Usa `startDate`/`endDate` explícitos, NO `periodType=day&period=1`: ese
 * devolvía la sesión ANTERIOR (medido 30-jul-2026: con period=1 la última vela
 * era de ayer, con fechas explícitas es la de hoy y cierra en el precio real).
 * Se pide una ventana de ~36 h y se filtra a la sesión (fecha ET) más reciente.
 */
export async function fetchIntradayBars(
  symbol: string,
  minutes = 5,
): Promise<IntradayBar[]> {
  const clean = symbol.trim();
  if (!clean) return [];

  const token = await getAccessToken();
  const now = Date.now();
  const params = new URLSearchParams({
    symbol: clean,
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
    if (res.status === 401) resetSchwabToken();
    throw new SchwabError(describeStatus(res.status, clean, ""), res.status);
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

  // La ventana de 36 h abarca ~1.5 sesiones; el chart quiere solo la última.
  // Se filtra a la fecha ET del último candle.
  const etDay = (sec: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(sec * 1000);
  const lastDay = etDay(all[all.length - 1].time);
  return all.filter((b) => etDay(b.time) === lastDay);
}

/**
 * Barras intradía de VARIAS sesiones (para revisar pronósticos de días pasados).
 * A diferencia de fetchIntradayBars, NO filtra a la última sesión: devuelve todo
 * el rango de `days`. Massive no autoriza barras de índice (403); Schwab sí.
 */
export async function fetchIntradayBarsRange(
  symbol: string,
  days = 10,
  minutes = 5,
): Promise<IntradayBar[]> {
  const clean = symbol.trim();
  if (!clean) return [];

  const token = await getAccessToken();
  const now = Date.now();
  const params = new URLSearchParams({
    symbol: clean,
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
    if (res.status === 401) resetSchwabToken();
    throw new SchwabError(describeStatus(res.status, clean, ""), res.status);
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

function describeStatus(status: number, ticker: string, body: string): string {
  switch (status) {
    case 401:
      return "Schwab rechazó el token. Se renovará en el próximo intento.";
    case 403:
      return "La app de Schwab no tiene permiso para Market Data. Revisa su estado en el portal.";
    case 404:
      return `Schwab no encontró datos para "${ticker}".`;
    case 429:
      return "Límite de tasa de Schwab alcanzado. Reintenta en unos segundos.";
    default:
      return `Schwab respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}
