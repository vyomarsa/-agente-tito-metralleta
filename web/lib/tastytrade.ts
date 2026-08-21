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
// OAuth2 personal grant — refresca el access token
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string; // "Bearer"
  expires_in: number; // segundos (~900)
  scope?: string;
}

async function fetchAccessToken(): Promise<StoredToken> {
  const res = await fetch(`${baseUrl()}/oauth/token`, {
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
  });
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

async function getJson<T>(pathAndQuery: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}${pathAndQuery}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    cache: "no-store",
  });
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
  "call-streamer-symbol"?: string;
  "put-streamer-symbol"?: string;
}
interface NestedExpiration {
  "expiration-date"?: string; // YYYY-MM-DD
  "days-to-expiration"?: number;
  strikes?: NestedStrike[];
}
interface NestedChainResponse {
  data?: { items?: Array<{ expirations?: NestedExpiration[] }> };
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
}

interface SymMeta { strike: number; expiration: string; type: "call" | "put"; dte: number }
interface ChainFilter { expirations?: number; dteMin?: number; dteMax?: number }

/**
 * Núcleo compartido: saca el api-quote-token + la estructura del chain, filtra los
 * vencimientos (por ventana de DTE o por los N más cercanos), corre el snapshot del
 * streamer y devuelve el meta por símbolo + lo recogido + el símbolo subyacente.
 */
async function streamChain(
  clean: string,
  filter: ChainFilter,
  opts: { timeoutMs?: number; includeUnderlying?: boolean },
): Promise<{ meta: Map<string, SymMeta>; snap: Map<string, import("./tastytradeStream").DxFields>; underlying: string | null }> {
  const [qt, nested] = await Promise.all([
    getJson<QuoteTokenResponse>("/api-quote-tokens"),
    getJson<NestedChainResponse>(`/option-chains/${encodeURIComponent(clean)}/nested`),
  ]);
  const url = qt.data?.["dxlink-url"];
  const token = qt.data?.token;
  if (!url || !token) throw new TastytradeError("Tastytrade no devolvió el api-quote-token para el streamer.");

  let exps = (nested.data?.items?.[0]?.expirations ?? [])
    .filter((e) => e["expiration-date"])
    .sort((a, b) => (a["days-to-expiration"] ?? 1e9) - (b["days-to-expiration"] ?? 1e9));
  if (filter.dteMin != null || filter.dteMax != null) {
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
      if (s["call-streamer-symbol"]) meta.set(s["call-streamer-symbol"], { strike, expiration, type: "call", dte });
      if (s["put-streamer-symbol"]) meta.set(s["put-streamer-symbol"], { strike, expiration, type: "put", dte });
    }
  }
  // Símbolo del subyacente en dxFeed = el ticker plano (equities/ETFs).
  const underlying = opts.includeUnderlying ? clean : null;
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
export async function fetchTastytradeChain(
  ticker: string,
  opts: { dteMin?: number; dteMax?: number; timeoutMs?: number } = {},
): Promise<{ spot: number | null; contracts: TtContract[] }> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return { spot: null, contracts: [] };
  const { meta, snap, underlying } = await streamChain(
    clean, { dteMin: opts.dteMin, dteMax: opts.dteMax }, { timeoutMs: opts.timeoutMs, includeUnderlying: true },
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
