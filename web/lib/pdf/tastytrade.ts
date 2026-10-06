// Cliente tastytrade — Open API REST (sin WebSocket/DXLink: alcanza con
// /market-data/by-type, que da bid/ask/griegos/OI de hasta cientos de
// contratos en una sola llamada). OAuth2 con grant personal (ver
// .env.example): el refresh_token no expira, el access_token dura 15 min y se
// cachea en memoria del proceso hasta que vence.
//
// Reemplaza a Schwab como fuente de la cadena de opciones del Agente 0DTE —
// verificado en vivo (ago 2026): producción de tastytrade es tiempo real de
// fábrica (updated-at a segundos de la hora real), sin el isDelayed=true que
// daba Schwab acá. Ver lib/zerodteSchwab.ts, que queda solo para las barras
// intradía del subyacente (tastytrade no tiene REST de velas, solo DXLink).

export class TastytradeError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TastytradeError";
    this.status = status;
  }
}

const API_BASE = "https://api.tastyworks.com";
const USER_AGENT = "visionary-trades/1.0";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 10_000) return cachedToken.token;

  const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
  const refreshToken = process.env.TASTYTRADE_REFRESH_TOKEN;
  if (!clientSecret || !refreshToken) {
    throw new TastytradeError("Faltan TASTYTRADE_CLIENT_SECRET / TASTYTRADE_REFRESH_TOKEN en .env.local.");
  }

  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new TastytradeError(`No se pudo autenticar con tastytrade (HTTP ${res.status}).`, res.status);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
  return cachedToken.token;
}

async function tastyGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const token = await getAccessToken();
  const url = `${API_BASE}${path}${params ? `?${params.toString()}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TastytradeError(`tastytrade ${path} → HTTP ${res.status}. ${body.slice(0, 160)}`.trim(), res.status);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

export interface NestedChainStrike {
  "strike-price": string;
  call: string;
  put: string;
}

export interface NestedChainExpiration {
  "expiration-date": string;
  "days-to-expiration": number;
  strikes: NestedChainStrike[];
}

interface NestedChainItem {
  "underlying-symbol": string;
  expirations: NestedChainExpiration[];
}

/** Cadena anidada completa (todos los vencimientos) de un subyacente. */
export async function fetchNestedOptionChain(underlying: string): Promise<NestedChainExpiration[]> {
  const data = await tastyGet<{ items: NestedChainItem[] }>(
    `/option-chains/${encodeURIComponent(underlying)}/nested`,
  );
  return data.items?.[0]?.expirations ?? [];
}

export interface TastyQuote {
  symbol: string;
  bid?: string;
  ask?: string;
  last?: string;
  mark?: string;
  "open-interest"?: number;
  volume?: string;
  delta?: string;
  gamma?: string;
  theta?: string;
  vega?: string;
  volatility?: string;
}

/** Tope de símbolos por request — la URL de 100 ronda los ~2200 caracteres, con margen de sobra. */
const CHUNK_SIZE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Cotizaciones en bloque de opciones (bid/ask/griegos/OI/volumen), en tandas paralelas. */
export async function fetchOptionQuotesByType(symbols: string[]): Promise<Map<string, TastyQuote>> {
  const out = new Map<string, TastyQuote>();
  const batches = chunk([...new Set(symbols)], CHUNK_SIZE);
  await Promise.all(
    batches.map(async (batch) => {
      if (batch.length === 0) return;
      const params = new URLSearchParams({ "equity-option": batch.join(",") });
      const data = await tastyGet<{ items: TastyQuote[] }>("/market-data/by-type", params);
      for (const q of data.items ?? []) out.set(q.symbol, q);
    }),
  );
  return out;
}

/** Precio del subyacente — índice (SPX/NDX) o equity/ETF (SPY/QQQ). */
export async function fetchUnderlyingQuote(symbol: string, isIndex: boolean): Promise<number | null> {
  const params = new URLSearchParams({ [isIndex ? "index" : "equity"]: symbol });
  const data = await tastyGet<{ items: TastyQuote[] }>("/market-data/by-type", params);
  const q = data.items?.[0];
  if (!q) return null;
  const n = (v: string | undefined) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return n(q.last) ?? n(q.mark) ?? null;
}

/**
 * Precio de cripto en vivo (ej. "BTC/USD") — verificado en vivo (2026-09-04):
 * `market-data/by-type?cryptocurrency=` da bid/ask/mark reales con
 * `updated-at` a segundos de la hora real, sin el delay de horas que trae la
 * cadena de aggs de Massive para cripto (viene marcada `"status":"DELAYED"`
 * ahí). Solo el precio en vivo — las velas históricas siguen saliendo de
 * Massive (tastytrade no tiene REST de velas, solo DXLink).
 */
export async function fetchCryptoQuote(symbol: string): Promise<number | null> {
  const params = new URLSearchParams({ cryptocurrency: symbol });
  const data = await tastyGet<{ items: TastyQuote[] }>("/market-data/by-type", params);
  const q = data.items?.[0];
  if (!q) return null;
  const n = (v: string | undefined) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return n(q.mark) ?? n(q.last) ?? null;
}

export interface MacroQuote {
  symbol: string;
  last: number;
  prevClose: number;
  dayHigh: number | null;
  dayLow: number | null;
}

/**
 * Cotización con `prev-close` real incluido — para "Análisis del mercado"
 * (ago 2026, pedido explícito), que necesita el % movido de cada
 * instrumento macro (VIX, futuros de índice, bonos, oro, petróleo, bitcoin),
 * no solo el precio. Verificado en vivo: `market-data/by-type` YA trae
 * `prev-close`/`prev-close-date` en la respuesta cruda para índices Y
 * futuros — `fetchUnderlyingQuote`/`fetchFuturesQuote` (arriba) lo
 * descartaban porque solo les hacía falta el precio. Función nueva en vez de
 * tocar esas dos: son de producción (SPX/NDX/ES/NQ en vivo), no arriesgarlas
 * por un campo que solo necesita este caso de uso nuevo.
 */
export async function fetchMacroQuote(params: { index?: string; future?: string }): Promise<MacroQuote | null> {
  const qs = new URLSearchParams(
    params.index ? { index: params.index } : { future: params.future ?? "" },
  );
  const data = await tastyGet<{ items: Record<string, string>[] }>("/market-data/by-type", qs);
  const q = data.items?.[0];
  if (!q) return null;
  const n = (v: string | undefined) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const last = n(q.last) ?? n(q.mark);
  const prevClose = n(q["prev-close"]);
  if (last == null || prevClose == null) return null;
  return {
    symbol: q.symbol ?? params.index ?? params.future ?? "",
    last, prevClose,
    dayHigh: n(q["day-high-price"]),
    dayLow: n(q["day-low-price"]),
  };
}

// ── Futuros (ES/NQ) — el usuario pidió datos reales de /ES y /NQ para poder
// operar mientras el mercado de acciones/índice está cerrado (CME cotiza
// casi 24/5). Verificado en vivo (ago 2026): /instruments/futures da el
// contrato "activo" (más líquido) de un producto, market-data/by-type?future=
// da su cotización real, y /futures-option-chains/{producto}/nested da SUS
// PROPIAS opciones diarias (0DTE reales de CME, no una cadena de índice
// reetiquetada) — siguen cotizando de noche, a diferencia de las opciones de
// SPX/NDX que cierran a las 16:00 ET. MarketSnack NO cubre CME (comprobado:
// "ES" ahí es la acción Eversource Energy, no el futuro), así que no hay net
// premium real para estos — ver lib/magnetWall.ts `hasFlowCoverage`.

export interface TastyFutureInstrument {
  symbol: string;
  "product-code": string;
  "expiration-date": string;
  "active-month": boolean;
  "next-active-month": boolean;
}

/** El contrato de futuro "activo" (más líquido/rolado) de un producto (ej. "ES", "NQ"). */
export async function fetchActiveFuture(productCode: string): Promise<TastyFutureInstrument | null> {
  const params = new URLSearchParams();
  params.append("product-code[]", productCode.toUpperCase());
  const data = await tastyGet<{ items: TastyFutureInstrument[] }>("/instruments/futures", params);
  const items = data.items ?? [];
  return items.find((i) => i["active-month"]) ?? items[0] ?? null;
}

/** Cotización real de un contrato de futuro concreto (ej. "/ESU6"). */
export async function fetchFuturesQuote(symbol: string): Promise<number | null> {
  const params = new URLSearchParams({ future: symbol });
  const data = await tastyGet<{ items: TastyQuote[] }>("/market-data/by-type", params);
  const q = data.items?.[0];
  if (!q) return null;
  const n = (v: string | undefined) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return n(q.mark) ?? n(q.last) ?? null;
}

export interface FuturesOptionStrike {
  "strike-price": string;
  call: string;
  put: string;
}

export interface FuturesOptionExpiration {
  /** El contrato de futuro contra el que liquida esta expiración (ej. "/ESU6"). */
  "underlying-symbol": string;
  "expiration-date": string;
  "days-to-expiration": number;
  "expiration-type": string;
  "stops-trading-at": string;
  strikes: FuturesOptionStrike[];
}

/** Cadena anidada COMPLETA de opciones sobre futuros de un producto (ej. "ES"). */
export async function fetchNestedFuturesOptionChain(productCode: string): Promise<FuturesOptionExpiration[]> {
  const data = await tastyGet<{ "option-chains": { expirations: FuturesOptionExpiration[] }[] }>(
    `/futures-option-chains/${encodeURIComponent(productCode.toUpperCase())}/nested`,
  );
  return data["option-chains"]?.[0]?.expirations ?? [];
}

/** Cotizaciones en bloque de OPCIONES SOBRE FUTUROS — símbolo propio de tastytrade (con espacios, ya URL-encoded por URLSearchParams). */
export async function fetchFuturesOptionQuotesByType(symbols: string[]): Promise<Map<string, TastyQuote>> {
  const out = new Map<string, TastyQuote>();
  const batches = chunk([...new Set(symbols)], CHUNK_SIZE);
  await Promise.all(
    batches.map(async (batch) => {
      if (batch.length === 0) return;
      const params = new URLSearchParams();
      for (const s of batch) params.append("future-option[]", s);
      const data = await tastyGet<{ items: TastyQuote[] }>("/market-data/by-type", params);
      for (const q of data.items ?? []) out.set(q.symbol, q);
    }),
  );
  return out;
}
