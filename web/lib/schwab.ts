// Cliente de Charles Schwab (Trader API — Market Data). Solo se usa en el servidor.
//
// Tercera fuente de datos del agente (junto a Massive y MarketSnack). A diferencia
// de Massive (API key Bearer) y MarketSnack (cookie de sesión), Schwab usa
// **OAuth 2.0**: hay que aprobar la app una vez en el navegador (flujo de tres
// patas) y a partir de ahí el servidor refresca el access token solo.
//
// - access_token  ~30 min  → se refresca automáticamente cuando falta < 1 min.
// - refresh_token ~7 días  → cuando caduca hay que volver a autorizar en el navegador.
//
// La gran ventaja frente a Massive: la cadena de opciones de Schwab trae en UNA
// sola llamada los **greeks (delta/gamma/theta/vega), IV, Open Interest y bid/ask**
// — justo lo que el plan de Massive NO autoriza y que hoy se estima por Black-Scholes.

import { promises as fs } from "fs";
import path from "path";

const AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const MARKETDATA_URL = "https://api.schwabapi.com/marketdata/v1";

const TOKEN_FILE = path.join(process.cwd(), "data", "schwab-tokens.json");

export class SchwabError extends Error {
  status?: number;
  /** true cuando el problema es que falta autorizar (no hay tokens o caducó el refresh). */
  needsAuth?: boolean;
  constructor(message: string, opts: { status?: number; needsAuth?: boolean } = {}) {
    super(message);
    this.name = "SchwabError";
    this.status = opts.status;
    this.needsAuth = opts.needsAuth;
  }
}

// ---------------------------------------------------------------------------
// Configuración desde el entorno (.env.local)
// ---------------------------------------------------------------------------

function clientId(): string {
  const v = process.env.SCHWAB_CLIENT_ID;
  if (!v) throw new SchwabError("Falta SCHWAB_CLIENT_ID en el entorno (.env.local).");
  return v;
}

function clientSecret(): string {
  const v = process.env.SCHWAB_CLIENT_SECRET;
  if (!v) throw new SchwabError("Falta SCHWAB_CLIENT_SECRET en el entorno (.env.local).");
  return v;
}

function redirectUri(): string {
  const v = process.env.SCHWAB_REDIRECT_URI;
  if (!v) throw new SchwabError("Falta SCHWAB_REDIRECT_URI en el entorno (.env.local).");
  return v;
}

/** ¿Están configuradas las credenciales? (para ocultar la fuente si no lo están). */
export function schwabConfigured(): boolean {
  return Boolean(
    process.env.SCHWAB_CLIENT_ID &&
      process.env.SCHWAB_CLIENT_SECRET &&
      process.env.SCHWAB_REDIRECT_URI,
  );
}

// ---------------------------------------------------------------------------
// Almacenamiento de tokens (data/schwab-tokens.json, gitignored)
// ---------------------------------------------------------------------------

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** epoch ms en el que caduca el access_token. */
  access_expires_at: number;
  /** epoch ms en el que se emitió el refresh_token (para avisar de los ~7 días). */
  refresh_issued_at: number;
}

async function readTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function writeTokens(t: StoredTokens): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
}

/** Estado de conexión para la UI (sin exponer los tokens). */
export interface SchwabStatus {
  configured: boolean;
  /** Hay tokens guardados en disco. NO implica que sirvan. */
  hasTokens: boolean;
  /** COMPROBADO EN VIVO: se pudo obtener un access token utilizable ahora mismo. */
  connected: boolean;
  /** true cuando hay que volver a autorizar en /schwab. */
  needsAuth: boolean;
  /** Motivo cuando connected=false, con la respuesta cruda de Schwab. */
  error: string | null;
  accessExpiresAt: number | null;
  refreshIssuedAt: number | null;
  /**
   * Días aprox. que le quedan al refresh_token. Es una ESTIMACIÓN por reloj local:
   * Schwab puede revocarlo antes (y lo hace). `connected` es la verdad; esto solo
   * sirve para avisar con antelación.
   */
  refreshDaysLeft: number | null;
}

/**
 * Estado de la conexión con Schwab. **Comprueba en vivo**, igual que hace
 * `cookieStatus()` con MarketSnack: antes `connected` valía `Boolean(tokens)`, o sea
 * "hay un archivo de tokens en disco", y seguía diciendo "conectado ✅" con un
 * refresh token que Schwab había revocado. Ahora se pide de verdad un access token.
 * Barato: si el que hay en disco sigue vigente (~30 min) no se llama a Schwab.
 */
export async function schwabStatus(): Promise<SchwabStatus> {
  const configured = schwabConfigured();
  const stored = configured ? await readTokens() : null;

  let connected = false;
  let needsAuth = configured && !stored;
  let error: string | null = null;
  if (stored) {
    try {
      await getAccessToken();
      connected = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      needsAuth = e instanceof SchwabError ? Boolean(e.needsAuth) : false;
    }
  }

  // Se releen: getAccessToken puede haber refrescado y reescrito el archivo.
  const tokens = connected ? await readTokens() : stored;

  const REFRESH_TTL_DAYS = 7;
  let refreshDaysLeft: number | null = null;
  if (tokens) {
    const elapsedDays = (Date.now() - tokens.refresh_issued_at) / (24 * 60 * 60 * 1000);
    refreshDaysLeft = Math.max(0, Math.round((REFRESH_TTL_DAYS - elapsedDays) * 10) / 10);
  }

  return {
    configured,
    hasTokens: Boolean(stored),
    connected,
    needsAuth,
    error,
    accessExpiresAt: tokens?.access_expires_at ?? null,
    refreshIssuedAt: tokens?.refresh_issued_at ?? null,
    refreshDaysLeft,
  };
}

/** Desconecta: borra los tokens guardados (para re-autorizar de cero). */
export async function schwabDisconnect(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {
    // ya no existía
  }
}

// ---------------------------------------------------------------------------
// Flujo OAuth 2.0 (tres patas)
// ---------------------------------------------------------------------------

/** URL a la que se manda al usuario para aprobar la app en Schwab. */
export function buildAuthorizeUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
  });
  if (state) params.set("state", state);
  return `${AUTH_URL}?${params.toString()}`;
}

function basicAuthHeader(): string {
  const raw = `${clientId()}:${clientSecret()}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // segundos
  token_type: string;
  scope?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new SchwabError(
      `Schwab rechazó el token (${res.status}). ${txt.slice(0, 200)}`.trim(),
      { status: res.status, needsAuth: res.status === 400 || res.status === 401 },
    );
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Canjea el `code` que Schwab devuelve en el callback por access + refresh token.
 * Schwab pone el `code` en la query de la redirect URI (a veces URL-encoded con
 * un sufijo "@" que hay que conservar tal cual llegó).
 */
export async function exchangeCode(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
  const t = await postToken(body);
  const now = Date.now();
  await writeTokens({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    access_expires_at: now + t.expires_in * 1000,
    refresh_issued_at: now,
  });
}

async function refreshAccessToken(tokens: StoredTokens): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  let t: TokenResponse;
  try {
    t = await postToken(body);
  } catch (e) {
    if (e instanceof SchwabError && e.needsAuth) {
      // Se CONSERVA la respuesta cruda de Schwab. Un 400/401 aquí casi siempre es
      // el refresh caducado, pero también puede ser una credencial de app mal
      // puesta o un body malformado, y tapar el motivo original hacía imposible
      // distinguirlos desde fuera (se diagnosticó a ciegas una vez; nunca más).
      throw new SchwabError(
        `El refresh token de Schwab no sirve (dura ~7 días). Vuelve a conectar en /schwab. — ${e.message}`,
        { status: e.status, needsAuth: true },
      );
    }
    throw e;
  }
  const now = Date.now();
  // Schwab reemite también el refresh_token en cada refresh; si no viniera,
  // conservamos el anterior (y su fecha de emisión original).
  // OJO — el reloj del refresh solo se reinicia si Schwab devuelve un refresh token
  // DISTINTO. Schwab NO rota el refresh token: reemite el MISMO en cada refresco,
  // así que la condición ingenua `t.refresh_token ? now : …` lo reiniciaba en CADA
  // refresco de access token y la cuenta atrás de 7 días no avanzaba nunca: /schwab
  // decía "quedan 5.4 días" con un token que Schwab ya daba por muerto. El TTL corre
  // desde la AUTORIZACIÓN, no desde el último refresco.
  const rotated = Boolean(t.refresh_token) && t.refresh_token !== tokens.refresh_token;
  const next: StoredTokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? tokens.refresh_token,
    access_expires_at: now + t.expires_in * 1000,
    refresh_issued_at: rotated ? now : tokens.refresh_issued_at,
  };
  await writeTokens(next);
  return next;
}

/** Devuelve un access token válido, refrescándolo si le queda menos de 1 min.
 *  Exportado para que la sección Prueba de Fuego (lib/pdf) use la MISMA conexión. */
export async function getAccessToken(): Promise<string> {
  const tokens = await readTokens();
  if (!tokens) {
    throw new SchwabError("Schwab no está conectado. Autoriza la app en /schwab.", {
      needsAuth: true,
    });
  }
  const MARGIN_MS = 60 * 1000;
  if (Date.now() < tokens.access_expires_at - MARGIN_MS) {
    return tokens.access_token;
  }
  const refreshed = await refreshAccessToken(tokens);
  return refreshed.access_token;
}

// ---------------------------------------------------------------------------
// Market Data — llamadas autenticadas
// ---------------------------------------------------------------------------

async function getJson<T>(pathAndQuery: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${MARKETDATA_URL}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SchwabError(describeStatus(res.status, body), {
      status: res.status,
      needsAuth: res.status === 401,
    });
  }
  return (await res.json()) as T;
}

// --- Tipos de la respuesta de la cadena de opciones de Schwab ---

interface SchwabOptionContract {
  putCall?: "PUT" | "CALL";
  symbol?: string;
  strikePrice?: number;
  expirationDate?: string; // "2026-08-15T00:00:00.000+00:00" o "2026-08-15"
  daysToExpiration?: number;
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  totalVolume?: number;
  openInterest?: number;
  volatility?: number; // IV en % (p.ej. 32.5)
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

/** Mapa { "2026-08-15:30" -> { strike -> [contratos] } } que devuelve Schwab. */
type SchwabExpDateMap = Record<string, Record<string, SchwabOptionContract[]>>;

interface SchwabChainResponse {
  symbol?: string;
  status?: string;
  underlyingPrice?: number;
  underlying?: { last?: number; mark?: number };
  callExpDateMap?: SchwabExpDateMap;
  putExpDateMap?: SchwabExpDateMap;
}

/** Contrato normalizado — incluye lo que Massive no da: greeks + IV. */
export interface SchwabContract {
  symbol: string;
  contractType: "call" | "put";
  strike: number;
  expiration: string; // YYYY-MM-DD
  dte: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number;
  openInterest: number;
  iv: number | null; // en % (decimal ×100 ya aplicado por Schwab)
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface SchwabChainResult {
  underlyingPrice: number | null;
  contracts: SchwabContract[];
}

function normExpDate(raw?: string): string {
  if (!raw) return "";
  return raw.slice(0, 10);
}

/** −999.0 es el centinela de "sin dato" de Schwab en greeks/IV. */
function cleanNum(n?: number): number | null {
  if (n == null || !Number.isFinite(n) || n <= -999) return null;
  return n;
}

function flattenExpMap(
  map: SchwabExpDateMap | undefined,
  type: "call" | "put",
  out: SchwabContract[],
): void {
  if (!map) return;
  for (const strikeMap of Object.values(map)) {
    for (const contracts of Object.values(strikeMap)) {
      for (const c of contracts) {
        const strike = c.strikePrice;
        if (strike == null) continue;
        out.push({
          symbol: c.symbol ?? "",
          contractType: type,
          strike,
          expiration: normExpDate(c.expirationDate),
          dte: c.daysToExpiration ?? 0,
          bid: cleanNum(c.bid),
          ask: cleanNum(c.ask),
          last: cleanNum(c.last),
          volume: c.totalVolume ?? 0,
          openInterest: c.openInterest ?? 0,
          iv: cleanNum(c.volatility),
          delta: cleanNum(c.delta),
          gamma: cleanNum(c.gamma),
          theta: cleanNum(c.theta),
          vega: cleanNum(c.vega),
        });
      }
    }
  }
}

/**
 * Cadena de opciones completa de un ticker con greeks + IV + OI + bid/ask.
 *
 * `strikeCount` limita cuántos strikes alrededor del precio devuelve (por defecto
 * todos). `fromDate`/`toDate` (YYYY-MM-DD) acotan vencimientos.
 */
export async function fetchOptionChain(
  ticker: string,
  opts: {
    contractType?: "CALL" | "PUT" | "ALL";
    strikeCount?: number;
    fromDate?: string;
    toDate?: string;
  } = {},
): Promise<SchwabChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new SchwabError("Ticker vacío.");

  const params = new URLSearchParams({
    symbol: clean,
    contractType: opts.contractType ?? "ALL",
    includeUnderlyingQuote: "true",
  });
  if (opts.strikeCount) params.set("strikeCount", String(opts.strikeCount));
  if (opts.fromDate) params.set("fromDate", opts.fromDate);
  if (opts.toDate) params.set("toDate", opts.toDate);

  const json = await getJson<SchwabChainResponse>(`/chains?${params.toString()}`);

  const contracts: SchwabContract[] = [];
  flattenExpMap(json.callExpDateMap, "call", contracts);
  flattenExpMap(json.putExpDateMap, "put", contracts);

  const underlyingPrice =
    json.underlyingPrice ?? json.underlying?.mark ?? json.underlying?.last ?? null;

  return { underlyingPrice, contracts };
}

// --- Quote del subyacente ---

export interface SchwabQuote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  netChange: number | null;
  netPercentChange: number | null;
  totalVolume: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /**
   * "Normal", "Closed"… Importa porque con el mercado CERRADO Schwab manda
   * `netChange: 0`, y pintarlo tal cual se lee como "hoy no se movió", que es
   * falso: es que no hay sesión en curso.
   */
  securityStatus: string | null;
}

interface SchwabQuoteResponse {
  [symbol: string]: {
    quote?: {
      lastPrice?: number;
      bidPrice?: number;
      askPrice?: number;
      netChange?: number;
      netPercentChange?: number;
      totalVolume?: number;
      openPrice?: number;
      highPrice?: number;
      lowPrice?: number;
      closePrice?: number;
      securityStatus?: string;
    };
  };
}

export async function fetchQuote(ticker: string): Promise<SchwabQuote | null> {
  const clean = ticker.trim().toUpperCase();
  const json = await getJson<SchwabQuoteResponse>(
    `/quotes?symbols=${encodeURIComponent(clean)}`,
  );
  const q = json[clean]?.quote;
  if (!q) return null;
  return {
    symbol: clean,
    last: cleanNum(q.lastPrice),
    bid: cleanNum(q.bidPrice),
    ask: cleanNum(q.askPrice),
    netChange: cleanNum(q.netChange),
    netPercentChange: cleanNum(q.netPercentChange),
    totalVolume: q.totalVolume ?? null,
    open: cleanNum(q.openPrice),
    high: cleanNum(q.highPrice),
    low: cleanNum(q.lowPrice),
    close: cleanNum(q.closePrice),
    securityStatus: q.securityStatus ?? null,
  };
}

// --- Historial de precios (velas diarias) ---
// La razón de ser de esta función: Massive NO está autorizado para índices
// ($SPX, $NDX, $RUT, $VIX), así que sus barras vienen vacías. Schwab sí cotiza
// índices, de modo que es la fuente de velas cuando Massive no las da.

export interface SchwabBar {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SchwabPriceHistoryResponse {
  candles?: Array<{
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    datetime?: number; // epoch ms
  }>;
  symbol?: string;
  empty?: boolean;
}

export async function fetchPriceHistory(
  ticker: string,
  opts: { years?: number } = {},
): Promise<SchwabBar[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new SchwabError("Ticker vacío.");

  const params = new URLSearchParams({
    symbol: clean,
    periodType: "year",
    period: String(opts.years ?? 1),
    frequencyType: "daily",
    frequency: "1",
    needExtendedHoursData: "false",
  });

  const json = await getJson<SchwabPriceHistoryResponse>(
    `/pricehistory?${params.toString()}`,
  );

  if (json.empty || !json.candles) return [];

  return json.candles
    .filter(
      (c) =>
        c.datetime != null &&
        c.open != null &&
        c.high != null &&
        c.low != null &&
        c.close != null,
    )
    .map((c) => ({
      time: c.datetime as number,
      open: c.open as number,
      high: c.high as number,
      low: c.low as number,
      close: c.close as number,
      volume: c.volume ?? 0,
    }));
}

function describeStatus(status: number, body: string): string {
  switch (status) {
    case 401:
      return "Schwab rechazó el token (401). Reconecta la app en /schwab.";
    case 403:
      return "Schwab denegó el acceso (403). Revisa que la app esté aprobada y con el scope de Market Data.";
    case 404:
      return "Schwab no encontró datos para ese símbolo (404).";
    case 429:
      return "Límite de tasa de Schwab alcanzado (429). Reintenta en unos segundos.";
    default:
      return `Schwab respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}
