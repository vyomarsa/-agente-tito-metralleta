// Cliente de Tastytrade (Open API). Solo se usa en el servidor.
//
// Cuarta fuente de datos del agente (junto a Massive, MarketSnack y Schwab).
// Tastytrade usa un modelo OAuth2 de "personal grant" MÁS SIMPLE que el de tres
// patas de Schwab: NO hay redirect ni intercambio de `code`. En su lugar:
//
//   1. Creas una OAuth Application en el portal de Tastytrade y obtienes un
//      client_secret.
//   2. En "OAuth Applications → Manage → Create Grant" el portal te da un
//      **refresh_token de por vida** (no caduca).
//   3. El servidor cambia ese refresh_token por un **access token de 15 min**
//      (grant_type=refresh_token) y lo refresca solo cuando está por caducar.
//
// Por eso aquí NO hace falta guardar el refresh_token en disco ni un flujo de
// navegador: el refresh_token vive en `.env.local` y solo cacheamos el access
// token (efímero) en `data/tastytrade-tokens.json`.
//
// Qué aporta frente a las otras fuentes: el endpoint `/market-metrics` trae
// **IV Rank e IV percentile REALES**, liquidez, beta, correlación y fechas de
// earnings — justo el IV Rank que hoy el agente solo estima por volatilidad
// realizada (ver `lib/ivcontext.ts`).
//
// ⚠️ Entorno SANDBOX (api.cert.tastyworks.com): pensado para probar cuentas y
// órdenes; sus datos de mercado suelen venir vacíos o simulados. Para IV Rank y
// quotes REALES hace falta una app OAuth de PRODUCCIÓN (TASTYTRADE_ENV=production).

import { promises as fs } from "fs";
import path from "path";

const API_URL_PROD = "https://api.tastyworks.com";
const API_URL_CERT = "https://api.cert.tastyworks.com";

// Tastytrade EXIGE un User-Agent en cada request; sin él, nginx responde 401
// "Authorization Required" (Node fetch no lo manda por defecto → 401). curl sí lo
// manda, por eso funcionaba en pruebas directas y fallaba desde la app.
const USER_AGENT = "tito-metralleta/1.0";

const TOKEN_FILE = path.join(process.cwd(), "data", "tastytrade-tokens.json");

export class TastytradeError extends Error {
  status?: number;
  /** true cuando falta configurar credenciales o el refresh_token es inválido. */
  needsAuth?: boolean;
  constructor(message: string, opts: { status?: number; needsAuth?: boolean } = {}) {
    super(message);
    this.name = "TastytradeError";
    this.status = opts.status;
    this.needsAuth = opts.needsAuth;
  }
}

// ---------------------------------------------------------------------------
// Configuración desde el entorno (.env.local)
// ---------------------------------------------------------------------------

/** Entorno activo: sandbox (cert) por defecto, production si se pide explícito. */
export function tastytradeEnv(): "sandbox" | "production" {
  return process.env.TASTYTRADE_ENV === "production" ? "production" : "sandbox";
}

function baseUrl(): string {
  return tastytradeEnv() === "production" ? API_URL_PROD : API_URL_CERT;
}

function clientSecret(): string {
  const v = process.env.TASTYTRADE_CLIENT_SECRET;
  if (!v) throw new TastytradeError("Falta TASTYTRADE_CLIENT_SECRET en el entorno (.env.local).", { needsAuth: true });
  return v;
}

function refreshToken(): string {
  const v = process.env.TASTYTRADE_REFRESH_TOKEN;
  if (!v)
    throw new TastytradeError(
      "Falta TASTYTRADE_REFRESH_TOKEN en el entorno (.env.local). Genéralo en el portal: OAuth Applications → Manage → Create Grant.",
      { needsAuth: true },
    );
  return v;
}

/** ¿Están configuradas las credenciales? (para ocultar la fuente si no lo están). */
export function tastytradeConfigured(): boolean {
  return Boolean(process.env.TASTYTRADE_CLIENT_SECRET && process.env.TASTYTRADE_REFRESH_TOKEN);
}

// ---------------------------------------------------------------------------
// Cache del access token efímero (data/tastytrade-tokens.json, gitignored)
// ---------------------------------------------------------------------------

interface StoredToken {
  access_token: string;
  /** epoch ms en el que caduca el access_token (~15 min). */
  access_expires_at: number;
  /** entorno con el que se emitió — para invalidar el cache si cambia. */
  env: "sandbox" | "production";
}

async function readToken(): Promise<StoredToken | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

async function writeToken(t: StoredToken): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Estado de conexión para la UI (sin exponer secretos)
// ---------------------------------------------------------------------------

export interface TastytradeStatus {
  configured: boolean;
  env: "sandbox" | "production";
  /** true si hay un access token cacheado y aún válido. */
  connected: boolean;
  accessExpiresAt: number | null;
}

export async function tastytradeStatus(): Promise<TastytradeStatus> {
  const configured = tastytradeConfigured();
  const env = tastytradeEnv();
  const cached = configured ? await readToken() : null;
  const connected = Boolean(
    cached && cached.env === env && Date.now() < cached.access_expires_at,
  );
  return {
    configured,
    env,
    connected,
    accessExpiresAt: cached?.access_expires_at ?? null,
  };
}

/** Borra el access token cacheado (fuerza un refresh en la próxima llamada). */
export async function tastytradeDisconnect(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {
    // ya no existía
  }
}

// ---------------------------------------------------------------------------
// Tope de tiempo del REST
// ---------------------------------------------------------------------------

/**
 * Tope por intento contra el REST de Tastytrade.
 *
 * Sin tope, un `fetch` pelado espera lo que haga falta, y la Tarjeta de Decisión
 * se quedaba colgada con él. Medido el 2026-08-26 sobre `/option-chains/nested`,
 * la latencia es **bimodal**: lo normal son 0,5–1,5 s (y 6,2–7,3 s en SPX, que es
 * la cadena más grande), pero de vez en cuando una llamada se atasca y sale
 * SIEMPRE en **21,03–21,07 s** — cinco muestras clavadas en el mismo valor, o sea
 * un tope de algo suyo, no una cuesta. Esperar ese atasco no aporta nada.
 *
 * 12 s deja ~1,6× de margen sobre el peor SPX legítimo observado y corta el atasco
 * mucho antes. Bajarlo de 8 s empezaría a cortar cadenas grandes de verdad.
 *
 * Ajustable con `TASTYTRADE_REST_TIMEOUT_MS`, como `MASSIVE_MAX_RPM` en el
 * regulador de Massive: si algún día su API se pone lenta de forma sostenida, se
 * sube sin tocar código.
 */
const REST_TIMEOUT_DEFAULT_MS = 12_000;

function restTimeoutMs(): number {
  const n = Number(process.env.TASTYTRADE_REST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : REST_TIMEOUT_DEFAULT_MS;
}

/** Un reintento y no más: el atasco es aislado — la llamada siguiente vuelve a ir a 0,5 s. */
const REST_INTENTOS = 2;

function esCorteDeTiempo(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * `fetch` con tope de tiempo y UN reintento.
 *
 * **Solo reintenta el corte de tiempo y el fallo de red.** Un error HTTP NO se
 * reintenta y sale tal cual: un 401 va a volver a ser 401, y machacar un 429 es la
 * peor respuesta posible a un límite de tasa. Quien llama distingue los dos casos
 * por el mensaje del `TastytradeError`.
 */
async function fetchConTope(
  url: string,
  init: RequestInit,
  quePide: string,
  timeoutMs = restTimeoutMs(),
): Promise<Response> {
  let ultimo: unknown;
  for (let intento = 1; intento <= REST_INTENTOS; intento++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      ultimo = err;
      if (!esCorteDeTiempo(err) && !(err instanceof TypeError)) throw err;
    }
  }
  const motivo = esCorteDeTiempo(ultimo)
    ? `no respondió en ${Math.round(timeoutMs / 1000)} s`
    : "no se pudo alcanzar";
  throw new TastytradeError(
    `Tastytrade ${motivo} al pedir ${quePide} (${REST_INTENTOS} intentos). Reintenta en unos segundos.`,
  );
}

// ---------------------------------------------------------------------------
// OAuth2 personal grant — refresca el access token
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string; // "Bearer"
  expires_in: number; // segundos (~900)
  scope?: string;
}

async function fetchAccessToken(): Promise<StoredToken> {
  // El token va TAMBIÉN con tope: es lo primero de cada llamada, así que un atasco
  // aquí cuelga por igual la cadena, los greeks y las métricas.
  const res = await fetchConTope(
    `${baseUrl()}/oauth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_secret: clientSecret(),
        refresh_token: refreshToken(),
      }),
      cache: "no-store",
    },
    "el access token",
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new TastytradeError(
      `Tastytrade rechazó el refresh del token (${res.status}). ${txt.slice(0, 200)}`.trim(),
      { status: res.status, needsAuth: res.status === 400 || res.status === 401 },
    );
  }
  const t = (await res.json()) as TokenResponse;
  const stored: StoredToken = {
    access_token: t.access_token,
    access_expires_at: Date.now() + t.expires_in * 1000,
    env: tastytradeEnv(),
  };
  await writeToken(stored);
  return stored;
}

/** Devuelve un access token válido, refrescándolo si le queda menos de 1 min. */
async function getAccessToken(): Promise<string> {
  if (!tastytradeConfigured()) {
    throw new TastytradeError(
      "Tastytrade no está configurado. Pon TASTYTRADE_CLIENT_SECRET y TASTYTRADE_REFRESH_TOKEN en .env.local.",
      { needsAuth: true },
    );
  }
  const cached = await readToken();
  const MARGIN_MS = 60 * 1000;
  if (
    cached &&
    cached.env === tastytradeEnv() &&
    Date.now() < cached.access_expires_at - MARGIN_MS
  ) {
    return cached.access_token;
  }
  const refreshed = await fetchAccessToken();
  return refreshed.access_token;
}

// ---------------------------------------------------------------------------
// Llamadas autenticadas a la API
// ---------------------------------------------------------------------------

async function getJson<T>(pathAndQuery: string, timeoutMs = restTimeoutMs()): Promise<T> {
  const token = await getAccessToken();
  const res = await fetchConTope(
    `${baseUrl()}${pathAndQuery}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      cache: "no-store",
    },
    pathAndQuery.split("?")[0],
    timeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TastytradeError(describeStatus(res.status, body), {
      status: res.status,
      needsAuth: res.status === 401,
    });
  }
  return (await res.json()) as T;
}

// --- Market metrics (IV Rank / IV percentile reales) ---
// Doc: GET /market-metrics?symbols=AAPL,MSFT — devuelve { data: { items: [...] } }

interface RawMarketMetric {
  symbol?: string;
  "implied-volatility-index"?: string;
  "implied-volatility-index-rank"?: string; // 0..1 (proporción)
  "implied-volatility-percentile"?: string; // 0..1
  "implied-volatility-rank"?: string;
  "tos-implied-volatility-index-rank"?: string;
  "liquidity-rating"?: number;
  "liquidity-rank"?: string;
  beta?: string;
  "corr-spy-3month"?: string;
  "market-cap"?: string;
  "earnings"?: { "expected-report-date"?: string; "time-of-day"?: string };
}

export interface MarketMetric {
  symbol: string;
  /** IV Rank en porcentaje 0-100 (el proxy del agente se puede reemplazar por esto). */
  ivRank: number | null;
  /** IV percentile en porcentaje 0-100. */
  ivPercentile: number | null;
  /** IV index (nivel de IV) en porcentaje 0-100. */
  ivIndex: number | null;
  liquidityRating: number | null;
  beta: number | null;
  corrSpy3m: number | null;
  earningsDate: string | null;
}

/** Convierte "0.4231" (proporción) a 42.31 (%). Deja null si no viene. */
function pct(raw?: string): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 10;
}

function num(raw?: string): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface MarketMetricsResponse {
  data?: { items?: RawMarketMetric[] };
}

/**
 * IV Rank / IV percentile REALES de uno o varios subyacentes.
 *
 * ⚠️ En sandbox suele venir vacío; usar producción para datos reales.
 */
export async function fetchMarketMetrics(symbols: string[]): Promise<MarketMetric[]> {
  const clean = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (clean.length === 0) return [];
  const json = await getJson<MarketMetricsResponse>(
    `/market-metrics?symbols=${encodeURIComponent(clean.join(","))}`,
  );
  const items = json.data?.items ?? [];
  return items
    .filter((it) => it.symbol)
    .map((it) => ({
      symbol: it.symbol as string,
      ivRank: pct(it["implied-volatility-index-rank"] ?? it["implied-volatility-rank"]),
      ivPercentile: pct(it["implied-volatility-percentile"]),
      ivIndex: pct(it["implied-volatility-index"]),
      liquidityRating: it["liquidity-rating"] ?? num(it["liquidity-rank"]),
      beta: num(it.beta),
      corrSpy3m: num(it["corr-spy-3month"]),
      earningsDate: it.earnings?.["expected-report-date"] ?? null,
    }));
}

/**
 * IV Rank REAL (0-100) de varios subyacentes en un Map { TICKER -> ivRank }, para
 * los escáneres (spreads/wheel) que recorren un universo. Aprovecha que
 * `/market-metrics` acepta muchos símbolos por llamada; batchea de 40 en 40 para
 * no armar URLs gigantes. Degrada con gracia: si Tastytrade no está configurado o
 * falla, devuelve un Map vacío y cada motor cae a su proxy de vol realizada.
 */
export async function fetchIvRankMap(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!tastytradeConfigured() || symbols.length === 0) return out;
  const uniq = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const BATCH = 40;
  for (let i = 0; i < uniq.length; i += BATCH) {
    try {
      const metrics = await fetchMarketMetrics(uniq.slice(i, i + BATCH));
      for (const m of metrics) if (m.ivRank != null) out.set(m.symbol, m.ivRank);
    } catch {
      // seguimos con lo que haya; el resto usa el proxy del motor
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chain + greeks REALES por el streamer DXLink (delta/gamma/IV/OI/bid-ask)
// ---------------------------------------------------------------------------

interface QuoteTokenResponse {
  data?: { token?: string; "dxlink-url"?: string; level?: string };
}

interface NestedStrike {
  "strike-price"?: string;
  /** Símbolo OCC con relleno de espacios ("SPXW  260917C07445000"). */
  call?: string;
  put?: string;
  "call-streamer-symbol"?: string;
  "put-streamer-symbol"?: string;
}
interface NestedExpiration {
  "expiration-date"?: string; // YYYY-MM-DD
  "days-to-expiration"?: number;
  /** "AM" | "PM". SPX trae las dos para el mismo día (ver `pickExpirations`). */
  "settlement-type"?: string;
  strikes?: NestedStrike[];
}
interface NestedChainResponse {
  data?: { items?: Array<{ "root-symbol"?: string; expirations?: NestedExpiration[] }> };
}

/** Greek real por contrato, misma forma que realGreeksMap/schwab (iv en DECIMAL). */
export interface TtGreek {
  gamma: number;
  iv: number;
  delta?: number;
  bid?: number;
  ask?: number;
  openInterest?: number;
}

/** Contrato normalizado de la cadena de Tastytrade (delta/IV/OI/bid-ask REALES). */
export interface TtContract {
  strike: number;
  type: "call" | "put";
  expiration: string; // YYYY-MM-DD
  dte: number;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  iv: number | null; // decimal
  gamma: number | null;
  openInterest: number;
  volume: number; // volumen del día
  last: number | null; // último precio operado
  /** Símbolo OCC compacto ("SPY260917C00761000"), el mismo formato que MarketSnack. */
  symbol?: string;
  theta?: number | null;
  vega?: number | null;
}

interface SymMeta { strike: number; expiration: string; type: "call" | "put"; dte: number; occ: string }
interface ChainFilter {
  expirations?: number; dteMin?: number; dteMax?: number;
  /** Vencimientos EXACTOS (YYYY-MM-DD). Manda sobre los otros filtros. */
  dates?: string[];
}

/**
 * Un vencimiento por fecha, fusionando TODAS las raíces del nested.
 *
 * `streamChain` leía solo `items[0]`, y en SPX eso depende del orden en que
 * Tastytrade liste las raíces: hay dos, `SPXW` (diarias, liquidación PM) y `SPX`
 * (mensual, liquidación AM), y el tercer viernes las DOS tienen la misma fecha.
 * Mezclarlas duplicaría cada strike de ese día en el GEX. Se queda la PM, que es
 * la que cotiza hasta la campana y la que opera un 0DTE; a igualdad, la de más strikes.
 * Verificado el 2026-09-17: SPXW 42 vencimientos, SPX 21, coinciden el 18-sep.
 */
function pickExpirations(items: NonNullable<NonNullable<NestedChainResponse["data"]>["items"]>): NestedExpiration[] {
  const byDate = new Map<string, NestedExpiration>();
  const rank = (e: NestedExpiration) =>
    (e["settlement-type"] === "PM" ? 1_000_000 : 0) + (e.strikes?.length ?? 0);
  for (const it of items) {
    for (const e of it.expirations ?? []) {
      const d = e["expiration-date"];
      if (!d) continue;
      const ya = byDate.get(d);
      if (!ya || rank(e) > rank(ya)) byDate.set(d, e);
    }
  }
  return [...byDate.values()].sort(
    (a, b) => (a["days-to-expiration"] ?? 1e9) - (b["days-to-expiration"] ?? 1e9),
  );
}

/**
 * Estructura de la cadena con cache corto en memoria.
 *
 * El 0DTE la pide una vez por minuto durante toda la sesión, y la de SPX es la más
 * pesada del REST (6–7 s medidos). Los strikes listados no cambian dentro de unos
 * minutos; los PRECIOS no salen de aquí sino del streamer, así que el cache no
 * envejece ninguna cotización. `days-to-expiration` sí cambia a medianoche, y 5 min
 * de TTL lo deja pasar a tiempo. Single-flight: dos escaneos a la vez comparten la llamada.
 */
const NESTED_TTL_MS = 5 * 60_000;
type NestedEntry = { at: number; p: Promise<NestedExpiration[]> };
const nestedCache: Map<string, NestedEntry> =
  (globalThis as { __ttNested?: Map<string, NestedEntry> }).__ttNested ??
  ((globalThis as { __ttNested?: Map<string, NestedEntry> }).__ttNested = new Map());

function fetchNested(clean: string): Promise<NestedExpiration[]> {
  const ya = nestedCache.get(clean);
  if (ya && Date.now() - ya.at < NESTED_TTL_MS) return ya.p;
  const p = getJson<NestedChainResponse>(`/option-chains/${encodeURIComponent(clean)}/nested`)
    .then((r) => pickExpirations(r.data?.items ?? []));
  nestedCache.set(clean, { at: Date.now(), p });
  // Un fallo no se cachea: el siguiente intento vuelve a preguntar.
  p.catch(() => { if (nestedCache.get(clean)?.p === p) nestedCache.delete(clean); });
  return p;
}

/** "SPXW  260917C07445000" → "SPXW260917C07445000" (el formato de MarketSnack y de `occSymbol`). */
function compactOcc(raw: string | undefined): string {
  return (raw ?? "").replace(/\s+/g, "");
}

/**
 * Vencimientos listados (fecha + DTE), sin abrir el streamer. Para el selector del
 * 0DTE y para elegir el frente en el scalping. Lanza TastytradeError si falla.
 */
export async function fetchTastytradeExpirations(ticker: string): Promise<{ date: string; dte: number }[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return [];
  const exps = await fetchNested(clean);
  return exps.map((e) => ({ date: e["expiration-date"] as string, dte: e["days-to-expiration"] ?? 0 }));
}

/** Token + URL del streamer DXLink. Autoriza la conexión (NO es por ticker). */
export interface QuoteToken { url: string; token: string }

/**
 * Pide un `api-quote-token` (autoriza el streamer). Se puede REUTILIZAR en muchas
 * conexiones/tickers dentro de un mismo escaneo → los escáneres lo piden una sola
 * vez y lo pasan a cada `fetchTastytradeChain`, en vez de uno por ticker.
 */
export async function fetchQuoteToken(): Promise<QuoteToken> {
  const qt = await getJson<QuoteTokenResponse>("/api-quote-tokens");
  const url = qt.data?.["dxlink-url"];
  const token = qt.data?.token;
  if (!url || !token) throw new TastytradeError("Tastytrade no devolvió el api-quote-token para el streamer.");
  return { url, token };
}

/**
 * Núcleo compartido: saca el api-quote-token + la estructura del chain, filtra los
 * vencimientos (por ventana de DTE o por los N más cercanos), corre el snapshot del
 * streamer y devuelve el meta por símbolo + lo recogido + el símbolo subyacente.
 */
/**
 * Símbolo del subyacente en el streamer (dxFeed) cuando NO coincide con el ticker.
 *
 * Verificado el 2026-08-24 suscribiendo `Quote`: `BRK/B` cotiza (mid 498.16) y ni
 * `BRKB` ni `BRK.B` devuelven nada. Ojo: el REST de Tastytrade sí quiere `BRKB`
 * (`/option-chains/BRKB/nested` da 15 vencimientos, `BRK.B` da 0), así que las dos
 * formas conviven a propósito — esta tabla traduce SOLO para el streamer.
 */
const STREAMER_UNDERLYING: Record<string, string> = {
  BRKB: "BRK/B",
};

async function streamChain(
  clean: string,
  filter: ChainFilter,
  opts: { timeoutMs?: number; includeUnderlying?: boolean; preToken?: QuoteToken },
): Promise<{ meta: Map<string, SymMeta>; snap: Map<string, import("./tastytradeStream").DxFields>; underlying: string | null }> {
  // El token se reutiliza si viene pre-obtenido (escaneos); si no, se pide aquí.
  const [tok, allExps] = await Promise.all([
    opts.preToken ? Promise.resolve(opts.preToken) : fetchQuoteToken(),
    fetchNested(clean),
  ]);
  const { url, token } = tok;

  let exps = allExps;
  if (filter.dates && filter.dates.length > 0) {
    const want = new Set(filter.dates);
    exps = exps.filter((e) => want.has(e["expiration-date"] as string));
  } else if (filter.dteMin != null || filter.dteMax != null) {
    exps = exps.filter((e) => {
      const d = e["days-to-expiration"] ?? -1;
      return (filter.dteMin == null || d >= filter.dteMin) && (filter.dteMax == null || d <= filter.dteMax);
    });
  } else {
    exps = exps.slice(0, filter.expirations ?? 8);
  }

  const meta = new Map<string, SymMeta>();
  for (const e of exps) {
    const expiration = e["expiration-date"] as string;
    const dte = e["days-to-expiration"] ?? 0;
    for (const s of e.strikes ?? []) {
      const strike = Number(s["strike-price"]);
      if (!Number.isFinite(strike)) continue;
      if (s["call-streamer-symbol"]) meta.set(s["call-streamer-symbol"], { strike, expiration, type: "call", dte, occ: compactOcc(s.call) });
      if (s["put-streamer-symbol"]) meta.set(s["put-streamer-symbol"], { strike, expiration, type: "put", dte, occ: compactOcc(s.put) });
    }
  }
  // Símbolo del subyacente en dxFeed = el ticker plano (equities/ETFs).
  // El SUBYACENTE en el streamer no siempre se escribe como el ticker del REST:
  // las clases de acción llevan barra en dxFeed. Sin esta traducción, `BRKB` no
  // cotiza, el spot sale null y el símbolo se descarta entero por "sin precio".
  const underlying = opts.includeUnderlying ? (STREAMER_UNDERLYING[clean] ?? clean) : null;
  const symbols = [...meta.keys()];
  if (underlying) symbols.push(underlying);
  if (symbols.length === 0) return { meta, snap: new Map(), underlying };

  const { dxlinkSnapshot } = await import("./tastytradeStream");
  const snap = await dxlinkSnapshot({ url, token, symbols, timeoutMs: opts.timeoutMs });
  return { meta, snap, underlying };
}

/**
 * Mapa { "strike|expiration|type" -> {gamma, iv, ...} } con greeks REALES de
 * Tastytrade (streamer DXLink), listo para inyectar en gexAnalysis/gexHeatmap.
 * Toma los N vencimientos más cercanos (por defecto 8, como el heatmap). Server-only.
 * Degrada con gracia: si algo falla lanza TastytradeError y el llamador cae a la
 * siguiente fuente de la cascada (MarketSnack → Schwab).
 */
export async function fetchTastytradeGreeks(
  ticker: string,
  opts: { expirations?: number; timeoutMs?: number } = {},
): Promise<Record<string, TtGreek>> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return {};
  const { meta, snap } = await streamChain(clean, { expirations: opts.expirations ?? 8 }, { timeoutMs: opts.timeoutMs });

  const out: Record<string, TtGreek> = {};
  for (const [sym, f] of snap) {
    const m = meta.get(sym);
    if (!m) continue;
    const gamma = f.gamma != null && f.gamma > 0 ? f.gamma : null;
    const iv = f.iv != null && f.iv > 0 ? f.iv : null;
    if (gamma == null && iv == null) continue;
    out[`${m.strike}|${m.expiration}|${m.type}`] = {
      gamma: gamma ?? 0, iv: iv ?? 0, delta: f.delta, bid: f.bid, ask: f.ask, openInterest: f.oi,
    };
  }
  return out;
}

/**
 * Cadena COMPLETA de Tastytrade (contratos con delta/IV/OI/bid-ask REALES) en una
 * ventana de DTE, más el spot del subyacente (todo por el mismo streamer). Para los
 * escáneres de spreads/wheel. Server-only. Lanza TastytradeError si falla → el
 * llamador cae a MarketSnack/Massive.
 */
/**
 * Spot del subyacente por el streamer, SIN bajar la cadena entera.
 *
 * El 0DTE lo derivaba por paridad put-call porque Massive no da precio con el plan
 * gratis. Aquí se pide directo: una suscripción `Quote` de UN símbolo, ~2 s. El
 * snapshot no resuelve por "todos con greeks" (un subyacente no tiene), así que
 * cierra por el temporizador de silencio — de ahí el timeout corto.
 */
export async function fetchTastytradeSpot(
  ticker: string,
  opts: { quoteToken?: QuoteToken; timeoutMs?: number } = {},
): Promise<number | null> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return null;
  const symbol = STREAMER_UNDERLYING[clean] ?? clean;
  const tok = opts.quoteToken ?? (await fetchQuoteToken());
  const { dxlinkSnapshot } = await import("./tastytradeStream");
  const snap = await dxlinkSnapshot({
    url: tok.url, token: tok.token, symbols: [symbol], timeoutMs: opts.timeoutMs ?? 5000,
  });
  const u = snap.get(symbol);
  if (u?.bid != null && u?.ask != null && u.bid > 0 && u.ask > 0) return (u.bid + u.ask) / 2;
  // Fuera de sesión puede llegar el último trade y no la horquilla.
  return u?.last != null && u.last > 0 ? u.last : null;
}

/** Cotización de un subyacente tal y como la sirve el streamer. */
export interface TtQuote {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  prevClose: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
}

/**
 * Cotizaciones de varios subyacentes por UNA conexión de streamer.
 *
 * Reemplaza al snapshot masivo de Massive, que en el plan gratis responde
 * **403 NOT_AUTHORIZED** (verificado 2026-08-24) — por eso la cinta de arriba
 * salía entera en "—". Precio = último operado, y si no ha operado, el mid de la
 * horquilla. La variación sale contra `prevDayClosePrice` del evento Summary.
 */
export async function fetchTastytradeQuotes(
  tickers: string[],
  opts: { quoteToken?: QuoteToken; timeoutMs?: number } = {},
): Promise<Map<string, TtQuote>> {
  const out = new Map<string, TtQuote>();
  const limpios = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (limpios.length === 0) return out;

  // El streamer usa otra forma para las clases de acción (BRKB → BRK/B).
  const aStreamer = new Map(limpios.map((t) => [STREAMER_UNDERLYING[t] ?? t, t]));
  const tok = opts.quoteToken ?? (await fetchQuoteToken());
  const { dxlinkUnderlyings } = await import("./tastytradeStream");
  const snap = await dxlinkUnderlyings({
    url: tok.url, token: tok.token, symbols: [...aStreamer.keys()], timeoutMs: opts.timeoutMs,
  });

  for (const [sym, f] of snap) {
    const ticker = aStreamer.get(sym);
    if (!ticker) continue;
    const mid = f.bid != null && f.ask != null ? (f.bid + f.ask) / 2 : null;
    const price = f.last ?? mid;
    const prev = f.prevClose ?? null;
    const change = price != null && prev != null ? price - prev : null;
    out.set(ticker, {
      price,
      change,
      changePercent: change != null && prev ? (change / prev) * 100 : null,
      prevClose: prev,
      dayOpen: f.dayOpen ?? null,
      dayHigh: f.dayHigh ?? null,
      dayLow: f.dayLow ?? null,
      dayVolume: f.dayVolume ?? null,
    });
  }
  return out;
}

/** Periodo dxFeed por timeframe de la app. */
const CANDLE_PERIOD: Record<string, string> = {
  "1y": "d",
  // 1 minuto: lo pide el flujo para saber a qué precio cotizaba el subyacente en
  // cada impresión de la cinta (ver lib/flowSources).
  "1m": "1m",
  "15m10d": "15m",
  "5m5d": "5m",
  // 4 horas como el 4H de TradingView: SOLO horario regular (`tho=true`) y
  // alineadas a la sesión (`a=s`) → velas de 9:30 y 13:30 ET. Sin esos dos
  // modificadores dxFeed corta cada 4 h desde medianoche e incluye extended
  // hours, y la MA200 sale de otras velas (verificado 2026-10-05).
  "4h": "4h,tho=true,a=s",
};

/**
 * Velas del subyacente por el streamer. Tastytrade NO las da por REST: van por
 * DXLink con el evento `Candle` y símbolos tipo `AAPL{=d}` / `AAPL{=5m}`.
 *
 * Verificado contra producción el 2026-08-24: las diarias coinciden al céntimo con
 * las de Massive (AAPL 21-ago 309.35 · 20-ago 311.30) y las de 5m traen el día en
 * curso **en premarket**, que el plan gratis de Massive ni siquiera tiene.
 */
export async function fetchTastytradeCandles(
  ticker: string,
  tf: string,
  days: number,
  opts: { quoteToken?: QuoteToken; timeoutMs?: number } = {},
): Promise<{ time: number; open: number; high: number; low: number; close: number }[]> {
  const clean = ticker.trim().toUpperCase();
  const period = CANDLE_PERIOD[tf];
  if (!clean || !period) return [];
  const base = STREAMER_UNDERLYING[clean] ?? clean;
  const tok = opts.quoteToken ?? (await fetchQuoteToken());
  const { dxlinkCandles } = await import("./tastytradeStream");
  const velas = await dxlinkCandles({
    url: tok.url,
    token: tok.token,
    symbol: `${base}{=${period}}`,
    fromTime: Date.now() - days * 24 * 60 * 60 * 1000,
    timeoutMs: opts.timeoutMs,
  });
  // TfBar espera segundos UNIX; dxFeed entrega epoch ms.
  return velas.map((v) => ({
    time: Math.floor(v.time / 1000),
    open: v.open, high: v.high, low: v.low, close: v.close,
  }));
}

/** Contrato de la cadena, con lo que el flujo necesita para rellenar cada impresión. */
export interface TtFlowContract {
  occ: string;
  type: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  openInterest: number;
  volume: number;
}

/**
 * Cadena indexada por el símbolo del STREAMER (no el OCC), que es la clave con la
 * que llegan las impresiones del Time & Sales. Es el mismo snapshot que
 * `fetchTastytradeChain`: se expone aparte para no tener que rehacer el mapeo
 * streamer→contrato en `lib/flowSources`.
 */
export async function streamChainForFlow(
  ticker: string,
  opts: { expirations?: number; dteMin?: number; dteMax?: number; quoteToken?: QuoteToken; timeoutMs?: number } = {},
): Promise<{ contratos: Map<string, TtFlowContract> }> {
  const clean = ticker.trim().toUpperCase();
  const contratos = new Map<string, TtFlowContract>();
  if (!clean) return { contratos };
  const { meta, snap } = await streamChain(
    clean,
    { expirations: opts.expirations ?? 8, dteMin: opts.dteMin, dteMax: opts.dteMax },
    { timeoutMs: opts.timeoutMs, preToken: opts.quoteToken },
  );
  for (const [sym, m] of meta) {
    const f = snap.get(sym);
    contratos.set(sym, {
      occ: m.occ,
      type: m.type,
      strike: m.strike,
      expiration: m.expiration,
      dte: m.dte,
      delta: f?.delta ?? null,
      gamma: f?.gamma ?? null,
      theta: f?.theta ?? null,
      vega: f?.vega ?? null,
      iv: f?.iv != null && f.iv > 0 ? f.iv : null,
      openInterest: f?.oi ?? 0,
      volume: f?.volume ?? 0,
    });
  }
  return { contratos };
}

export async function fetchTastytradeChain(
  ticker: string,
  opts: {
    dteMin?: number; dteMax?: number; timeoutMs?: number; quoteToken?: QuoteToken;
    /** Nº de vencimientos más cercanos, cuando no se filtra por DTE. */
    expirations?: number;
    /** Vencimientos exactos (YYYY-MM-DD); mandan sobre DTE y `expirations`. */
    dates?: string[];
  } = {},
): Promise<{ spot: number | null; contracts: TtContract[] }> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return { spot: null, contracts: [] };
  const { meta, snap, underlying } = await streamChain(
    clean, { dteMin: opts.dteMin, dteMax: opts.dteMax, expirations: opts.expirations, dates: opts.dates },
    { timeoutMs: opts.timeoutMs, includeUnderlying: true, preToken: opts.quoteToken },
  );

  // Spot del subyacente = mid de su Quote (si llegó).
  let spot: number | null = null;
  if (underlying) {
    const u = snap.get(underlying);
    if (u && u.bid != null && u.ask != null && u.bid > 0 && u.ask > 0) spot = (u.bid + u.ask) / 2;
  }

  const contracts: TtContract[] = [];
  for (const [sym, f] of snap) {
    const m = meta.get(sym);
    if (!m) continue; // salta el subyacente y símbolos desconocidos
    contracts.push({
      strike: m.strike, type: m.type, expiration: m.expiration, dte: m.dte,
      bid: f.bid ?? null, ask: f.ask ?? null,
      delta: f.delta ?? null, iv: f.iv != null && f.iv > 0 ? f.iv : null,
      gamma: f.gamma ?? null, openInterest: f.oi ?? 0,
      volume: f.volume ?? 0, last: f.last ?? null,
      symbol: m.occ || undefined, theta: f.theta ?? null, vega: f.vega ?? null,
    });
  }
  return { spot, contracts };
}

function describeStatus(status: number, body: string): string {
  switch (status) {
    case 401:
      return "Tastytrade rechazó el token (401). Revisa TASTYTRADE_CLIENT_SECRET y TASTYTRADE_REFRESH_TOKEN.";
    case 403:
      return "Tastytrade denegó el acceso (403). Revisa los scopes de la OAuth Application (read).";
    case 404:
      return "Tastytrade no encontró datos para ese símbolo (404).";
    case 429:
      return "Límite de tasa de Tastytrade alcanzado (429). Reintenta en unos segundos.";
    default:
      return `Tastytrade respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}
