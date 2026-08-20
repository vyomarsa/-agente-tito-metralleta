// Cliente del API interno de MarketSnack (app.marketsnack.com). Solo servidor.
// Auth por cookie de sesión. La cookie se lee EN CADA PETICIÓN desde el almacén
// (lib/marketsnackCookie.ts): data/marketsnack-cookie.json → respaldo .env.local.
// Renovarla en /ajustes surte efecto sin reiniciar. Ver SCOREDCARD/Scoredcard.md.

import type { RawTrade } from "./flow";
import type { Chain2RawContract } from "./optionChain2";
import { getCookie } from "./marketsnackCookie";

const BASE_URL = "https://app.marketsnack.com";

export class MarketSnackError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MarketSnackError";
    this.status = status;
  }
}

/** Cookie activa desde el almacén (archivo o .env.local). Async: se lee por petición. */
async function cookie(): Promise<string> {
  try {
    return await getCookie();
  } catch (e) {
    throw new MarketSnackError(
      e instanceof Error ? e.message : "Falta la cookie de MarketSnack.",
    );
  }
}

export interface FetchFlowOptions {
  period?: string; // "1d" | "5d" | "1m"
  maxPages?: number;
  minPremium?: number; // filtro server-side: solo trades con premium ≥ este valor ($)
  targetDays?: number; // detener la paginación al cubrir N días hacia atrás
  onPage?: (page: number, accumulated: number) => void | Promise<void>;
}

export interface FlowResult {
  trades: RawTrade[];
  pages: number;
  truncated: boolean;
}

/**
 * Descarga el flujo (Time & Sales) de un ticker desde MarketSnack, paginando por
 * `next_page_token`. Endpoint: /api/flow_feed?filter[scope]=all&filter[symbol][]=TICKER&period=…
 */
export async function fetchFlow(
  ticker: string,
  opts: FetchFlowOptions = {},
): Promise<FlowResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketSnackError("Ticker vacío.");
  return paginate(clean, opts);
}

/**
 * Igual que `fetchFlow` pero SIN filtro de símbolo: devuelve el flujo de todo el
 * mercado. Es lo que alimenta el screener de /ideas — el piso de premium
 * (`minPremium`) filtra server-side, así que el payload se mantiene chico.
 */
export async function fetchMarketFlow(opts: FetchFlowOptions = {}): Promise<FlowResult> {
  return paginate(null, opts);
}

/** Un vencimiento disponible para un ticker (de /api/assets/{TICKER}/expirations). */
export interface ExpirationEntry {
  date: string; // "YYYY-MM-DD"
  symbols: string[];
}

/**
 * Lista los vencimientos disponibles de un ticker, ordenados de más cercano a más lejano.
 * Endpoint: /api/assets/{TICKER}/expirations. Es la fuente de fechas para pedir cadenas
 * con `fetchOptionChain2` (una llamada por fecha). Payload chico (solo fechas).
 */
export async function fetchExpirations(ticker: string): Promise<ExpirationEntry[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketSnackError("Ticker vacío.");
  const cookieHeader = await cookie();
  const url = `${BASE_URL}/api/assets/${encodeURIComponent(clean)}/expirations`;

  const res = await fetch(url, {
    headers: { Accept: "application/json", Cookie: cookieHeader },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza MARKETSNACK_COOKIE en .env.local.",
      res.status,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MarketSnackError(
      `MarketSnack respondió ${res.status}. ${body.slice(0, 200)}`.trim(),
      res.status,
    );
  }

  const json: unknown = await res.json();
  if (!Array.isArray(json)) return [];
  return (json as ExpirationEntry[])
    .filter((e) => e && typeof e.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Descarga la Option Chain 2.0 (extendida) de MarketSnack para UN vencimiento.
 * Endpoint: /api/assets/{TICKER}/option_chain_extended?expiration_date=YYYY-MM-DD
 * A diferencia del flow feed NO pagina: devuelve el array plano de contratos de esa
 * expiración, con greeks/IV/MID reales. El shape se normaliza con `normalizeChain2`.
 * Para varias expiraciones, llamar una vez por fecha.
 */
export async function fetchOptionChain2(
  ticker: string,
  expirationDate: string,
): Promise<Chain2RawContract[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketSnackError("Ticker vacío.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) {
    throw new MarketSnackError(`expiration_date inválida: ${expirationDate}. Usa YYYY-MM-DD.`);
  }
  const cookieHeader = await cookie();
  const params = new URLSearchParams({ expiration_date: expirationDate });
  const url = `${BASE_URL}/api/assets/${encodeURIComponent(clean)}/option_chain_extended?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json", Cookie: cookieHeader },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza MARKETSNACK_COOKIE en .env.local.",
      res.status,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MarketSnackError(
      `MarketSnack respondió ${res.status}. ${body.slice(0, 200)}`.trim(),
      res.status,
    );
  }

  // El endpoint devuelve un array plano; toleramos también { list: [...] } por si acaso.
  const json: unknown = await res.json();
  if (Array.isArray(json)) return json as Chain2RawContract[];
  if (json && typeof json === "object" && Array.isArray((json as { list?: unknown }).list)) {
    return (json as { list: Chain2RawContract[] }).list;
  }
  return [];
}

/** Cuerpo de paginación compartido. `symbol === null` → escaneo de todo el mercado. */
async function paginate(
  symbol: string | null,
  opts: FetchFlowOptions = {},
): Promise<FlowResult> {
  const clean = symbol;
  const period = opts.period ?? "5d";
  const maxPages = opts.maxPages ?? 10;
  const cookieHeader = await cookie();

  const trades: RawTrade[] = [];
  let token: string | null = null;
  let page = 0;
  let truncated = false;
  // La paginación del feed camina hacia atrás en el tiempo; con targetDays paramos
  // al cubrir la ventana pedida.
  const cutoffMs = opts.targetDays ? Date.now() - opts.targetDays * 86_400_000 : null;

  do {
    page += 1;
    const params = new URLSearchParams();
    params.set("filter[scope]", "all");
    if (clean) params.append("filter[symbol][]", clean);
    params.set("period", period);
    if (opts.minPremium && opts.minPremium > 0) {
      params.set("filter[premium][gte]", String(Math.floor(opts.minPremium)));
    }
    if (token) params.set("next_page_token", token);
    const url = `${BASE_URL}/api/flow_feed?${params.toString()}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json", Cookie: cookieHeader },
      cache: "no-store",
      redirect: "manual",
    });

    // Sesión inválida/expirada → MarketSnack redirige a /login o responde 401.
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new MarketSnackError(
        "Sesión de MarketSnack inválida o expirada. Actualiza MARKETSNACK_COOKIE en .env.local.",
        res.status,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MarketSnackError(
        `MarketSnack respondió ${res.status}. ${body.slice(0, 200)}`.trim(),
        res.status,
      );
    }

    const json: { list?: RawTrade[]; meta?: { next_page_token?: string } } =
      await res.json();
    const list = json.list ?? [];
    trades.push(...list);
    await opts.onPage?.(page, trades.length);

    token = json.meta?.next_page_token ?? null;
    if (list.length === 0) break;
    if (cutoffMs != null) {
      const oldest = list[list.length - 1]?.timestamp;
      if (oldest && Date.parse(oldest) < cutoffMs) break; // ventana cubierta
    }
    if (page >= maxPages) {
      truncated = Boolean(token);
      break;
    }
  } while (token);

  return { trades, pages: page, truncated };
}
