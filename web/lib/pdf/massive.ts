// Cliente de Massive (massive.com — antes Polygon.io). Solo se usa en el servidor.

import type { CompanyInfo, DailyBar, RawContract, TfBar } from "./types";
import { marketDateStr } from "./occ";
import { fetchChainFromTastytrade } from "@/lib/chainSources";

const BASE_URL = "https://api.massive.com";

const EXCHANGE_NAMES: Record<string, string> = {
  XNAS: "Nasdaq",
  XNYS: "NYSE",
  ARCX: "NYSE Arca",
  XASE: "NYSE American",
  BATS: "Cboe BZX",
  IEXG: "IEX",
};

export class MassiveError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MassiveError";
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new MassiveError("Falta MASSIVE_API_KEY en el entorno (.env.local).");
  return key;
}

function maxPages(): number {
  const n = Number(process.env.MASSIVE_MAX_PAGES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}

/**
 * fetch con reintento ante 429 (rate limit por minuto de Massive). La cadena de
 * opciones sola dispara decenas de páginas seguidas, así que un 429 aislado a
 * mitad de ráfaga es normal y se resuelve solo esperando el `Retry-After`
 * (o un backoff fijo si no viene) en vez de abortar la consulta entera.
 */
async function fetchMassive(url: string, key: string, retries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (res.status !== 429 || attempt >= retries) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * (attempt + 1);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

export interface FetchProgress {
  /** Se llama al terminar cada página, con el número de página y el total acumulado. */
  onPage?: (page: number, accumulated: number) => void | Promise<void>;
}

export interface ChainResult {
  contracts: RawContract[];
  underlyingPrice: number | null;
  pages: number;
  truncated: boolean;
}

/**
 * Descarga la option chain completa de un ticker siguiendo la paginación por `next_url`.
 * Emite progreso por página. Corta en MASSIVE_MAX_PAGES como salvaguarda.
 */
async function fetchOptionChainMassive(
  ticker: string,
  progress: FetchProgress = {},
): Promise<ChainResult> {
  const key = apiKey();
  const limit = maxPages();
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");

  const contracts: RawContract[] = [];
  let underlyingPrice: number | null = null;
  let url: string | null =
    `${BASE_URL}/v3/snapshot/options/${encodeURIComponent(clean)}?limit=250`;
  let page = 0;
  let truncated = false;

  while (url) {
    page += 1;
    const res: Response = await fetchMassive(url, key);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MassiveError(
        describeStatus(res.status, clean, body),
        res.status,
      );
    }

    const json: {
      results?: RawContract[];
      next_url?: string;
    } = await res.json();

    const results = json.results ?? [];
    for (const c of results) {
      contracts.push(c);
      if (underlyingPrice === null && typeof c.underlying_asset?.price === "number") {
        underlyingPrice = c.underlying_asset.price;
      }
    }

    await progress.onPage?.(page, contracts.length);

    if (page >= limit) {
      truncated = Boolean(json.next_url);
      break;
    }
    url = json.next_url ?? null;
  }

  return { contracts, underlyingPrice, pages: page, truncated };
}

interface TickerDetails {
  name?: string;
  market_cap?: number;
  primary_exchange?: string;
  homepage_url?: string;
  total_employees?: number;
  list_date?: string;
  sic_description?: string;
  description?: string;
  branding?: { logo_url?: string; icon_url?: string };
}

interface StockSnapshot {
  todaysChange?: number;
  todaysChangePerc?: number;
  day?: { o?: number; h?: number; l?: number; c?: number; v?: number };
  min?: { c?: number };
  prevDay?: { c?: number };
}

async function getJson<T>(path: string): Promise<T | null> {
  const key = apiKey();
  const res = await fetchMassive(`${BASE_URL}${path}`, key);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MassiveError(describeStatus(res.status, "", body), res.status);
  }
  return (await res.json()) as T;
}

/** Detalles de referencia + snapshot de precio, combinados en CompanyInfo. */
export async function fetchCompany(ticker: string): Promise<CompanyInfo> {
  const clean = ticker.trim().toUpperCase();
  const [details, snap] = await Promise.all([
    getJson<{ results?: TickerDetails }>(
      `/v3/reference/tickers/${encodeURIComponent(clean)}`,
    ).catch(() => null),
    getJson<{ ticker?: StockSnapshot }>(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(clean)}`,
    ).catch(() => null),
  ]);

  const d = details?.results ?? {};
  const t = snap?.ticker ?? {};
  const exchangeCode = d.primary_exchange;

  return {
    ticker: clean,
    name: d.name ?? null,
    exchange: exchangeCode ? EXCHANGE_NAMES[exchangeCode] ?? exchangeCode : null,
    marketCap: d.market_cap ?? null,
    homepageUrl: d.homepage_url ?? null,
    employees: d.total_employees ?? null,
    listDate: d.list_date ?? null,
    sector: d.sic_description ?? null,
    description: d.description ?? null,
    hasLogo: Boolean(d.branding?.logo_url || d.branding?.icon_url),
    price: t.day?.c ?? t.min?.c ?? t.prevDay?.c ?? null,
    change: t.todaysChange ?? null,
    changePercent: t.todaysChangePerc ?? null,
    dayOpen: t.day?.o ?? null,
    dayHigh: t.day?.h ?? null,
    dayLow: t.day?.l ?? null,
    dayVolume: t.day?.v ?? null,
    prevClose: t.prevDay?.c ?? null,
  };
}

interface AggBar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Descarga TODAS las páginas de un rango de aggs, siguiendo `next_url` (igual
 * que `fetchOptionChain`) — verificado en vivo (2026-09-04) que el endpoint de
 * aggs SÍ pagina para rangos grandes: BTC (24/7, mucha más densidad de datos
 * por día que una acción) truncaba en silencio a la primera página con
 * `getJson` de una sola llamada, dejando el precio/velas de varias semanas de
 * atraso sin ningún error — un solo `fetch` no alcanza para timeframes
 * intradía de BTC con muchos días de historia.
 */
async function fetchAggsAllPages(ticker: string, firstPath: string): Promise<AggBar[]> {
  const key = apiKey();
  const limit = maxPages();
  const out: AggBar[] = [];
  let url: string | null = `${BASE_URL}${firstPath}`;
  let page = 0;

  while (url) {
    page += 1;
    const res = await fetchMassive(url, key);
    if (res.status === 404) break;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MassiveError(describeStatus(res.status, ticker, body), res.status);
    }
    const json: { results?: AggBar[]; next_url?: string } = await res.json();
    out.push(...(json.results ?? []));
    if (page >= limit) break;
    url = json.next_url ?? null;
  }
  return out;
}

/** Barras diarias del subyacente en los últimos `days` días (para la gráfica). */
export async function fetchDailyBars(ticker: string, days = 365): Promise<DailyBar[]> {
  const clean = ticker.trim().toUpperCase();
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const path =
    `/v2/aggs/ticker/${encodeURIComponent(clean)}/range/1/day/` +
    `${toDateStr(from.getTime())}/${toDateStr(to.getTime())}` +
    `?adjusted=true&sort=asc&limit=500`;
  const bars = await fetchAggsAllPages(clean, path).catch(() => []);
  return bars.map((b) => ({
    time: toDateStr(b.t),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v ?? 0,
  }));
}

// Cache corto en memoria + dedup de pedidos en vuelo, mismo motivo que
// `barsStore.ts` (ese cachea barras diarias un día entero; acá hace falta un
// TTL corto porque los timeframes intradía se refrescan solos, ej. BTC cada
// 60s). Sin esto, un timeframe "caro" en días (ej. BTC 4h = 180 días de velas
// horarias, varias páginas) golpeado por el auto-refresh + más de una pestaña
// abierta al mismo tiempo agota el límite de peticiones por minuto de Massive
// y esa temporalidad cae a "sin datos" en silencio (visto en vivo 2026-09-13).
const BARS_CACHE_TTL_MS = 20_000;
const barsCache = new Map<string, { at: number; bars: TfBar[] }>();
const barsInFlight = new Map<string, Promise<TfBar[]>>();

/** Barras del subyacente (diario o intradía) con tiempo UNIX en segundos. */
export async function fetchBars(
  ticker: string,
  multiplier: number,
  timespan: "day" | "minute" | "hour" | "week",
  days: number,
): Promise<TfBar[]> {
  const clean = ticker.trim().toUpperCase();
  const key = `${clean}:${multiplier}:${timespan}:${days}`;

  const cached = barsCache.get(key);
  if (cached && Date.now() - cached.at < BARS_CACHE_TTL_MS) return cached.bars;

  const existing = barsInFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const to = new Date();
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
      const path =
        `/v2/aggs/ticker/${encodeURIComponent(clean)}/range/${multiplier}/${timespan}/` +
        `${toDateStr(from.getTime())}/${toDateStr(to.getTime())}` +
        `?adjusted=true&sort=asc&limit=50000`;
      const raw = await fetchAggsAllPages(clean, path).catch(() => []);
      const bars = raw.map((b) => ({
        time: Math.floor(b.t / 1000),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v ?? 0,
      }));
      if (bars.length > 0) barsCache.set(key, { at: Date.now(), bars });
      return bars;
    } finally {
      barsInFlight.delete(key);
    }
  })();
  barsInFlight.set(key, promise);
  return promise;
}

/** Descarga la imagen del logo (o icono) para servirla por proxy. */
export async function fetchLogoImage(
  ticker: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const key = apiKey();
  const clean = ticker.trim().toUpperCase();
  const details = await getJson<{ results?: TickerDetails }>(
    `/v3/reference/tickers/${encodeURIComponent(clean)}`,
  ).catch(() => null);
  const url = details?.results?.branding?.logo_url ?? details?.results?.branding?.icon_url;
  if (!url) return null;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "image/png";
  return { data: await res.arrayBuffer(), contentType };
}

/**
 * Cadena de PUTS filtrada en el servidor para el screener de Wheel.
 *
 * Los filtros (`contract_type`, `expiration_date.gte/lte`, `strike_price.lte`)
 * los resuelve Massive, así que un ticker cabe en UNA página en vez de exigir
 * la cadena completa paginada. Verificado el 2026-07-24: 126 contratos, sin
 * next_url.
 *
 * `last_quote` (bid/ask) SÍ viene en este plan; `greeks` e `implied_volatility`
 * NO — el delta se calcula por Black-Scholes en lib/wheel.ts.
 */
export interface WheelChainResult {
  spot: number | null;
  quotes: WheelChainQuote[];
}

export interface WheelChainQuote {
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  openInterest: number;
  /**
   * Cierre del día del CONTRATO (no del subyacente) — respaldo cuando no hay
   * `last_quote`/`last_trade` (ver la nota en `fetchCreditSpreadChain`).
   * Opcional: `fetchWheelChain` no lo rellena, solo lo usa Venta de Primas.
   */
  dayClose?: number | null;
  /** IV que Massive ya trae calculada para este contrato, si la trae. */
  impliedVolatility?: number | null;
}

interface WheelRawContract {
  details?: { strike_price?: number; expiration_date?: string; contract_type?: string };
  last_quote?: { bid?: number; ask?: number };
  last_trade?: { price?: number };
  day?: { close?: number; vwap?: number };
  implied_volatility?: number;
  open_interest?: number;
  underlying_asset?: { price?: number };
}

export async function fetchWheelChain(
  ticker: string,
  opts: { dteMin: number; dteMax: number; now?: Date },
): Promise<WheelChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  // Ancla "hoy" en el día de mercado ET (no UTC): después de las ~8 PM ET el
  // día UTC ya saltó al siguiente y el dte/rango de vencimientos saldría
  // desfasado un día (ver el aviso en marketDateStr, lib/occ.ts).
  const todayET = marketDateStr(now);
  const todayETMs = Date.parse(`${todayET}T00:00:00Z`);
  const from = toDateStr(todayETMs + opts.dteMin * day);
  const to = toDateStr(todayETMs + opts.dteMax * day);

  const path =
    `/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?contract_type=put&expiration_date.gte=${from}&expiration_date.lte=${to}&limit=250`;

  const json = await getJson<{ results?: WheelRawContract[] }>(path);
  const results = json?.results ?? [];

  let spot: number | null = null;
  const quotes: WheelChainQuote[] = [];

  for (const c of results) {
    const strike = c.details?.strike_price;
    const expiration = c.details?.expiration_date;
    if (!(strike != null && strike > 0) || !expiration) continue;
    if (spot == null && c.underlying_asset?.price) spot = c.underlying_asset.price;

    const dte = Math.round(
      (Date.parse(`${expiration}T00:00:00Z`) - todayETMs) / day,
    );

    quotes.push({
      strike,
      expiration,
      dte,
      bid: c.last_quote?.bid ?? null,
      ask: c.last_quote?.ask ?? null,
      lastTrade: c.last_trade?.price ?? null,
      openInterest: c.open_interest ?? 0,
    });
  }

  // Solo puts OTM: los ITM no son cash-secured puts de Wheel, son otra cosa.
  const otm = spot != null ? quotes.filter((q) => q.strike <= spot) : quotes;
  return { spot, quotes: otm };
}

export interface NearTermContract {
  strike: number;
  expiration: string;
  contractType: "call" | "put";
  optionTicker: string;
}

export interface NearTermChainResult {
  spot: number | null;
  contracts: NearTermContract[];
}

/**
 * Cadena acotada a un rango de vencimiento cercano (AMBOS lados, calls y
 * puts de una — a diferencia de `fetchWheelChain`, que solo pide puts) —
 * mismo patrón de `expiration_date.gte/.lte` filtrado en el servidor de
 * Massive, evita traer la cadena multi-mes completa solo para mirar el
 * vencimiento más próximo. Usado por "Grandes empresas" (Prueba de Fuego,
 * ago 2026): a diferencia de SPX/SPY/QQQ (0DTE real de tastytrade), estas
 * empresas no siempre tienen opciones diarias — `dteMax` da margen para
 * encontrar el vencimiento más próximo que exista de verdad.
 */
async function fetchNearTermChainMassive(
  ticker: string,
  opts: { dteMin?: number; dteMax: number; now?: Date },
): Promise<NearTermChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const todayET = marketDateStr(now);
  const todayETMs = Date.parse(`${todayET}T00:00:00Z`);
  const from = toDateStr(todayETMs + (opts.dteMin ?? 0) * day);
  const to = toDateStr(todayETMs + opts.dteMax * day);

  const path =
    `/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?expiration_date.gte=${from}&expiration_date.lte=${to}&limit=250`;

  const json = await getJson<{ results?: RawContract[] }>(path);
  const results = json?.results ?? [];

  let spot: number | null = null;
  const contracts: NearTermContract[] = [];
  for (const c of results) {
    const strike = c.details?.strike_price;
    const expiration = c.details?.expiration_date;
    const rawType = c.details?.contract_type;
    const optionTicker = c.details?.ticker;
    if (spot == null && c.underlying_asset?.price) spot = c.underlying_asset.price;
    if (strike == null || !expiration || !optionTicker || (rawType !== "call" && rawType !== "put")) continue;
    contracts.push({ strike, expiration, contractType: rawType, optionTicker });
  }
  return { spot, contracts };
}

/**
 * Cadena de AMBOS lados (calls y puts) para el screener de Venta de Primas.
 * A diferencia de `fetchWheelChain` (solo puts, filtrados a OTM porque la
 * Wheel solo vende un lado), un spread de crédito necesita la cadena COMPLETA
 * alrededor del spot en ambos tipos: la pata corta puede quedar en cualquier
 * strike OTM y la pata larga se busca a un ancho de distancia, así que hace
 * falta ver strikes a ambos lados sin descartar nada de antemano — el filtro
 * OTM lo aplica `creditSpreadCandidatesForTicker` (lib/creditSpreads.ts), no
 * esta función de I/O.
 *
 * Dos peticiones (call y put) al mismo endpoint que `fetchWheelChain`, cada
 * una ya acotada por Massive al rango de vencimiento — mismo patrón, el doble
 * de llamadas.
 *
 * LIMITACIÓN REAL RE-VERIFICADA EN VIVO (ago 2026, no la nota vieja de
 * jul 2026 que decía lo contrario): en este plan, `/v3/snapshot/options/{t}`
 * NO trae `last_quote` (bid/ask) NI `last_trade` para NINGÚN contrato —
 * probado en vivo sobre IWM/AAPL/SPY, 0 de 250 resultados con bid en cada
 * caso. Sí trae `day.close`/`day.vwap` (cierre del contrato hoy, ~209/250
 * contratos) y, novedad frente a esa nota vieja, `implied_volatility` casi
 * siempre (250/250 en la prueba de SPY calls) — se usa cuando está, con
 * bisección propia (`impliedVol`) como respaldo. Como tampoco hay
 * `underlying_asset.price`, el spot NO sale de aquí: la ruta usa el último
 * cierre de `cachedDailyBars` (mismas barras que ya pide para la volatilidad
 * realizada). El crédito real "vender al bid, comprar al ask" que pide el
 * prompt se degrada, cuando no hay bid/ask real, a una ESTIMACIÓN
 * conservadora desde `day.close` con el mismo haircut del 10% que ya usa
 * `HAIRCUT.ultimo` en lib/wheel.ts para el mismo problema — ver
 * `resolveLegQuote` en lib/creditSpreads.ts. Se marca `creditSource` en cada
 * candidato y se declara en la UI; nunca se presenta como precio real cuando
 * no lo es.
 */
export interface CreditSpreadChainResult {
  spot: number | null;
  puts: WheelChainQuote[];
  calls: WheelChainQuote[];
}

async function fetchSideChain(
  clean: string,
  contractType: "call" | "put",
  from: string,
  to: string,
  todayETMs: number,
): Promise<{ spot: number | null; quotes: WheelChainQuote[] }> {
  const day = 24 * 60 * 60 * 1000;
  const path =
    `/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?contract_type=${contractType}&expiration_date.gte=${from}&expiration_date.lte=${to}&limit=250`;

  const json = await getJson<{ results?: WheelRawContract[] }>(path);
  const results = json?.results ?? [];

  let spot: number | null = null;
  const quotes: WheelChainQuote[] = [];
  for (const c of results) {
    const strike = c.details?.strike_price;
    const expiration = c.details?.expiration_date;
    if (!(strike != null && strike > 0) || !expiration) continue;
    if (spot == null && c.underlying_asset?.price) spot = c.underlying_asset.price;

    const dte = Math.round((Date.parse(`${expiration}T00:00:00Z`) - todayETMs) / day);
    quotes.push({
      strike, expiration, dte,
      bid: c.last_quote?.bid ?? null,
      ask: c.last_quote?.ask ?? null,
      lastTrade: c.last_trade?.price ?? null,
      openInterest: c.open_interest ?? 0,
      dayClose: c.day?.close ?? c.day?.vwap ?? null,
      impliedVolatility: c.implied_volatility ?? null,
    });
  }
  return { spot, quotes };
}

export async function fetchCreditSpreadChain(
  ticker: string,
  opts: { dteMin: number; dteMax: number; now?: Date },
): Promise<CreditSpreadChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const todayET = marketDateStr(now);
  const todayETMs = Date.parse(`${todayET}T00:00:00Z`);
  const from = toDateStr(todayETMs + opts.dteMin * day);
  const to = toDateStr(todayETMs + opts.dteMax * day);

  const [putSide, callSide] = await Promise.all([
    fetchSideChain(clean, "put", from, to, todayETMs),
    fetchSideChain(clean, "call", from, to, todayETMs),
  ]);

  return {
    spot: putSide.spot ?? callSide.spot,
    puts: putSide.quotes,
    calls: callSide.quotes,
  };
}

// ── Backtest ("Prueba de Fuego") ────────────────────────────────────────────

export interface OptionContractRef {
  ticker: string;
  strike: number;
  expiration: string; // YYYY-MM-DD
}

/**
 * Lista de referencia de contratos (strike + vencimiento), incluyendo YA VENCIDOS
 * (`expired=true`) — es la única forma de saber qué contratos existían en una
 * ventana pasada. NO trae precio ni Open Interest, solo la identidad del contrato.
 */
export async function fetchOptionContractsList(
  ticker: string,
  opts: { contractType: "call" | "put"; expirationGte: string; expirationLte: string },
): Promise<OptionContractRef[]> {
  const key = apiKey();
  const clean = ticker.trim().toUpperCase();
  const out: OptionContractRef[] = [];
  let url: string | null =
    `${BASE_URL}/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(clean)}` +
    `&contract_type=${opts.contractType}&expiration_date.gte=${opts.expirationGte}` +
    `&expiration_date.lte=${opts.expirationLte}&expired=true&limit=1000`;

  while (url) {
    const res = await fetchMassive(url, key);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MassiveError(describeStatus(res.status, clean, body), res.status);
    }
    const json: {
      results?: { ticker?: string; strike_price?: number; expiration_date?: string }[];
      next_url?: string;
    } = await res.json();
    for (const c of json.results ?? []) {
      if (c.ticker && typeof c.strike_price === "number" && c.expiration_date) {
        out.push({ ticker: c.ticker, strike: c.strike_price, expiration: c.expiration_date });
      }
    }
    url = json.next_url ?? null;
  }
  return out;
}

/** Barra diaria (open/high/low/close) de UN contrato de opción en UNA fecha. null si no operó ese día. */
export async function fetchOptionDayBar(
  optionTicker: string,
  dateStr: string,
): Promise<{ open: number; high: number; low: number; close: number } | null> {
  const key = apiKey();
  const path = `/v2/aggs/ticker/${encodeURIComponent(optionTicker)}/range/1/day/${dateStr}/${dateStr}?adjusted=true&limit=1`;
  const json = await getJson<{ results?: { o: number; h: number; l: number; c: number }[] }>(path).catch(
    () => null,
  );
  const bar = json?.results?.[0];
  if (!bar) return null;
  return { open: bar.o, high: bar.h, low: bar.l, close: bar.c };
}

// ── Day trading en vivo ("Prueba de Fuego" TSLA/SPX) ────────────────────────

export interface OptionQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  lastTrade: number | null;
  openInterest: number | null;
  underlyingPrice: number | null;
}

interface SingleContractSnapshot {
  results?: {
    details?: { ticker?: string };
    last_quote?: { bid?: number; ask?: number; midpoint?: number };
    last_trade?: { price?: number };
    open_interest?: number;
    underlying_asset?: { price?: number };
  };
}

/**
 * Quote en vivo de UN contrato de opción (para trackear P/L en el day trading).
 * `optionTicker` acepta tanto el símbolo OCC puro (p. ej. de `buildOccSymbol`,
 * lib/occ.ts) como el formato de `Row.optionTicker` (`details.ticker` de Massive,
 * que ya trae el prefijo `O:`) — Massive exige el prefijo en este endpoint
 * puntual, así que se agrega acá si falta (verificado en vivo: sin el prefijo
 * responde 404 aunque el contrato exista). null si Massive no tiene snapshot.
 */
export async function fetchOptionQuote(
  underlyingTicker: string,
  optionTicker: string,
): Promise<OptionQuote | null> {
  const underlying = underlyingTicker.trim().toUpperCase();
  const symbol = optionTicker.startsWith("O:") ? optionTicker : `O:${optionTicker}`;
  const path = `/v3/snapshot/options/${encodeURIComponent(underlying)}/${encodeURIComponent(symbol)}`;
  const json = await getJson<SingleContractSnapshot>(path).catch(() => null);
  const r = json?.results;
  if (!r) return null;
  const bid = r.last_quote?.bid ?? null;
  const ask = r.last_quote?.ask ?? null;
  const mid = r.last_quote?.midpoint ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
  return {
    symbol: r.details?.ticker ?? optionTicker,
    bid,
    ask,
    mid,
    lastTrade: r.last_trade?.price ?? null,
    openInterest: r.open_interest ?? null,
    underlyingPrice: r.underlying_asset?.price ?? null,
  };
}

function describeStatus(status: number, ticker: string, body: string): string {
  switch (status) {
    case 401:
    case 403:
      return "Autenticación rechazada por Massive. Revisa la API key.";
    case 404:
      return `Massive no encontró datos para "${ticker}".`;
    case 429:
      return "Límite de tasa de Massive alcanzado. Reintenta en unos segundos.";
    default:
      return `Massive respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}

// ---------------------------------------------------------------------------
// Integración con Tito: el plan de Massive del dueño NO incluye
// /v3/snapshot/options (403 NOT_AUTHORIZED, verificado oct 2026), así que las
// cadenas salen primero de Tastytrade (lib/chainSources, la misma fuente que usa
// Tito, ya en formato RawContract) y Massive queda solo como respaldo.
// ---------------------------------------------------------------------------

export async function fetchOptionChain(
  ticker: string,
  progress: FetchProgress = {},
): Promise<ChainResult> {
  try {
    const tt = await fetchChainFromTastytrade(ticker);
    if (tt.contracts.length > 0) {
      await progress.onPage?.(1, tt.contracts.length);
      return { contracts: tt.contracts, underlyingPrice: tt.underlyingPrice, pages: 1, truncated: false };
    }
  } catch {
    // Tastytrade caído o sin credenciales: se intenta Massive.
  }
  return fetchOptionChainMassive(ticker, progress);
}

export async function fetchNearTermChain(
  ticker: string,
  opts: { dteMin?: number; dteMax: number; now?: Date },
): Promise<NearTermChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  try {
    const now = opts.now ?? new Date();
    const day = 24 * 60 * 60 * 1000;
    const todayETMs = Date.parse(`${marketDateStr(now)}T00:00:00Z`);
    const from = toDateStr(todayETMs + (opts.dteMin ?? 0) * day);
    const to = toDateStr(todayETMs + opts.dteMax * day);
    const tt = await fetchChainFromTastytrade(clean);
    const contracts: NearTermContract[] = [];
    for (const c of tt.contracts) {
      const strike = c.details?.strike_price;
      const expiration = c.details?.expiration_date;
      const rawType = c.details?.contract_type;
      const optionTicker = c.details?.ticker;
      if (strike == null || !expiration || !optionTicker || (rawType !== "call" && rawType !== "put")) continue;
      if (expiration < from || expiration > to) continue;
      contracts.push({ strike, expiration, contractType: rawType, optionTicker });
    }
    if (contracts.length > 0) return { spot: tt.underlyingPrice, contracts };
  } catch {
    // Tastytrade caído o sin credenciales: se intenta Massive.
  }
  return fetchNearTermChainMassive(clean, opts);
}
