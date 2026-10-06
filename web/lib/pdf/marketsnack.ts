// Cliente del API interno de MarketSnack (app.marketsnack.com). Solo servidor.
// Auth por cookie de sesión. Fuente: lib/marketsnackCookie.ts, que se lee EN CADA
// PETICIÓN (no al arrancar) — así /ajustes puede actualizarla sin reiniciar `next dev`.
// MARKETSNACK_COOKIE en .env.local sigue funcionando como respaldo si aún no se ha
// guardado nada ahí. Ver SCOREDCARD/Scoredcard.md.

import type { RawTrade } from "./flow";
import { loadCookie } from "./marketsnackCookie";
import type { ActivitySummary } from "./contratosVecinos3";
import { summarizeActivity } from "./contratosVecinos3";
import type { ContractPremiumSummary, TradeSummaryBucket } from "./neighborContracts";
import { summarizeTradeBuckets } from "./neighborContracts";
import type { ExtendedChainContract, GexStatsBucket } from "./spxLevels";

const BASE_URL = "https://app.marketsnack.com";

export class MarketSnackError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MarketSnackError";
    this.status = status;
  }
}

async function cookie(): Promise<string> {
  const c = await loadCookie();
  if (!c) {
    throw new MarketSnackError(
      "Falta la cookie de sesión de MarketSnack. Configúrala en /ajustes (o en MARKETSNACK_COOKIE, .env.local).",
    );
  }
  return c;
}

/**
 * Prueba una cookie candidata contra MarketSnack SIN guardarla — la usa /ajustes
 * (y el extractor automático) para rechazar cookies que no sirven antes de pisar
 * la que sí funcionaba. Pega contra `/api/assets/SPY`, el endpoint más liviano del
 * cliente (un solo precio), igual que `fetchAssetPrice`.
 */
export async function testMarketSnackCookie(
  candidate: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${BASE_URL}/api/assets/SPY`, {
      headers: { Accept: "application/json", Cookie: candidate },
      cache: "no-store",
      redirect: "manual",
    });
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      return { ok: false, message: `MarketSnack respondió ${res.status}: sesión inválida o expirada.` };
    }
    if (!res.ok) {
      return { ok: false, message: `MarketSnack respondió ${res.status}.` };
    }
    const json: { latest_price?: number; regular_price?: number } = await res
      .json()
      .catch(() => ({}) as { latest_price?: number; regular_price?: number });
    if (json.latest_price == null && json.regular_price == null) {
      return { ok: false, message: "MarketSnack respondió 200 pero sin datos reconocibles — revisa la cookie." };
    }
    return { ok: true, message: "Cookie válida — MarketSnack respondió con datos de SPY." };
  } catch (err) {
    return { ok: false, message: `No se pudo contactar a MarketSnack: ${(err as Error).message}` };
  }
}

export interface FetchFlowOptions {
  period?: string; // "1d" | "5d" | "1m"
  maxPages?: number;
  minPremium?: number; // filtro server-side: solo trades con premium ≥ este valor ($)
  targetDays?: number; // detener la paginación al cubrir N días hacia atrás
  /** Ventana de fecha exacta (YYYY-MM-DD, inclusive) — para reconstruir un día histórico. */
  dateGte?: string;
  dateLte?: string;
  /**
   * Filtro server-side por lado de ejecución — probado en vivo (2026-08-18):
   * "ASKSIDE" ya agrupa ASKSIDE + AT_ASK + ABOVE_ASK (no hace falta pedir los 3).
   * Reduce a la mitad los trades a paginar cuando el caller solo le interesa
   * compra agresiva al ask (ej. unusual-swing) — mismo criterio, menos páginas.
   */
  side?: string[];
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
    if (opts.dateGte) params.set("filter[date][gte]", opts.dateGte);
    if (opts.dateLte) params.set("filter[date][lte]", opts.dateLte);
    if (opts.side && opts.side.length > 0) {
      for (const s of opts.side) params.append("filter[side][]", s);
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
        "Sesión de MarketSnack inválida o expirada. Actualiza la cookie en /ajustes.",
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

/**
 * Precio en vivo del subyacente vía `GET /api/assets/{ticker}` — MISMO
 * endpoint que alimenta el encabezado de la app de MarketSnack. `latest_price`
 * ya resuelve solo regular/pre-market/after-hours (coincide con
 * `extended_price` fuera de horario regular y con `regular_price` dentro).
 * Distinto de `fetchFlow`/`fetchContractTradeSummary`: esto NO son trades de
 * opciones, es directamente el precio del activo — la fuente correcta para
 * el spot en vivo, a diferencia del snapshot de acciones de Massive (que no
 * refleja pre-market/after-hours, ver lib/dayTrade.ts `resolveLiveSpot`).
 * `null` si el ticker no existe o la respuesta no trae un precio válido — no
 * es un error fatal, `resolveLiveSpot` tiene más fuentes de respaldo.
 */
export async function fetchAssetPrice(ticker: string): Promise<number | null> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return null;
  const res = await fetch(`${BASE_URL}/api/assets/${encodeURIComponent(clean)}`, {
    headers: { Accept: "application/json", Cookie: await cookie() },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza la cookie en /ajustes.",
      res.status,
    );
  }
  if (!res.ok) return null;

  const json: { latest_price?: number; regular_price?: number } = await res.json();
  const price = json.latest_price ?? json.regular_price ?? null;
  return price != null && price > 0 ? price : null;
}

export interface AssetSnapshot {
  price: number | null;
  regularChangePct: number | null;
  extendedChangePct: number | null;
  extendedType: string | null; // "Pre-market" | "After hours" | null
  marketStatus: string | null;
  earningsDate: string | null;
}

/**
 * Igual que `fetchAssetPrice` pero sin descartar el resto de la respuesta —
 * para "Análisis del mercado" (ago 2026): necesita el % movido en regular Y
 * en pre-market/after-hours por separado (no solo el precio resuelto), y de
 * paso trae `earnings_date` (real, cuando MarketSnack ya lo tiene agendado —
 * `null` la mayor parte del año, entre temporadas de resultados). Función
 * nueva en vez de ensanchar `fetchAssetPrice`: esa la usan rutas de
 * producción que solo necesitan el número.
 */
export async function fetchAssetSnapshot(ticker: string): Promise<AssetSnapshot | null> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return null;
  const res = await fetch(`${BASE_URL}/api/assets/${encodeURIComponent(clean)}`, {
    headers: { Accept: "application/json", Cookie: await cookie() },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza la cookie en /ajustes.",
      res.status,
    );
  }
  if (!res.ok) return null;

  const json: {
    latest_price?: number;
    regular_price?: number;
    regular_price_change?: { percentage?: number };
    extended_price_change?: { percentage?: number };
    extended_price_type?: string;
    market_status?: string;
    earnings_date?: string | null;
  } = await res.json();

  return {
    price: json.latest_price ?? json.regular_price ?? null,
    regularChangePct: json.regular_price_change?.percentage ?? null,
    extendedChangePct: json.extended_price_change?.percentage ?? null,
    extendedType: json.extended_price_type ?? null,
    marketStatus: json.market_status ?? null,
    earningsDate: json.earnings_date ?? null,
  };
}

export interface AssetChartPoint {
  t: string;
  v: number;
}

/**
 * Serie de precio en vivo del subyacente, 5 min de resolución, vía
 * `GET /api/assets/{ticker}/chart?period=1d` — SOLO acepta "1d" (probado en
 * vivo, "5d" da 422). A diferencia de `fetchBars`/`fetchDailyBars` de Massive
 * (velas OHLC, pero atrasadas ~1 día en este entorno — verificado en vivo,
 * ago 2026: ni la barra diaria ni la de 15 min de HOY existen todavía), este
 * endpoint SÍ cubre HOY completo, pre-market incluido: primer punto a las
 * 4:00 ET (verificado en vivo con AAPL, 193 puntos desde 08:00 UTC/4:00 ET
 * hasta after-hours). Solo trae precio puntual (`v`), no rango OHLC — para
 * "Grandes empresas" (Prueba de Fuego) se usa como vela sintética
 * (open=high=low=close=v) SOLO para el tramo de hoy que Massive no tiene
 * todavía; el resto del histórico sigue viniendo de Massive.
 */
export async function fetchAssetPriceChart(ticker: string): Promise<AssetChartPoint[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return [];
  const url = `${BASE_URL}/api/assets/${encodeURIComponent(clean)}/chart?period=1d`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Cookie: await cookie() },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza la cookie en /ajustes.",
      res.status,
    );
  }
  if (!res.ok) return [];

  const json: { data?: AssetChartPoint[] } = await res.json();
  return json.data ?? [];
}

/**
 * GEX agregado de MarketSnack, ya calculado por ellos (call_wall, put_wall,
 * magnet, max_pain, gamma_flip, net_gex) — vía `GET /api/assets/{ticker}/
 * gex_stats_chart`, buckets de 5 min. Ver lib/spxLevels.ts. Distinto de
 * `lib/gex.ts` (nuestra aproximación Black-Scholes): esto es el GEX "real" de
 * MarketSnack, pedido explícito (2026-07-30) para el panel de
 * Soportes y Resistencias de SPX. `[]` si no hay datos, no es error fatal.
 */
export async function fetchGexStats(
  ticker: string,
  opts: { period?: string } = {},
): Promise<GexStatsBucket[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return [];
  const period = opts.period ?? "1d";
  const url = `${BASE_URL}/api/assets/${encodeURIComponent(clean)}/gex_stats_chart?period=${period}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Cookie: await cookie() },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza la cookie en /ajustes.",
      res.status,
    );
  }
  if (!res.ok) return [];

  const json: { data?: GexStatsBucket[] } = await res.json();
  return json.data ?? [];
}

/**
 * Cadena completa de UNA expiración con greeks REALES (gamma incluida, no
 * estimada) y `premium_breakdown` (bid/mid/ask) por contrato — vía `GET
 * /api/assets/{ticker}/option_chain_extended?expiration_date=`. Da, en una
 * sola llamada, el net premium de HOY de todos los strikes de esa
 * expiración (lo que `trade_summaries` da contrato por contrato) más la
 * gamma real para calcular GEX sin aproximar. Ver lib/spxLevels.ts. `[]` si
 * la expiración no tiene contratos, no es error fatal.
 */
export async function fetchOptionChainExtended(
  ticker: string,
  expirationDate: string,
): Promise<ExtendedChainContract[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean || !expirationDate) return [];
  const url = `${BASE_URL}/api/assets/${encodeURIComponent(clean)}/option_chain_extended?expiration_date=${encodeURIComponent(expirationDate)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Cookie: await cookie() },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza la cookie en /ajustes.",
      res.status,
    );
  }
  if (!res.ok) return [];

  const json: ExtendedChainContract[] = await res.json();
  return Array.isArray(json) ? json : [];
}

/**
 * Buckets de 5 min de un contrato puntual (net premium ya desglosado en
 * ask/bid/mid) — endpoint distinto a `flow_feed`, uno por símbolo OCC exacto.
 * Ver lib/neighborContracts.ts (contratos vecinos). Array vacío = el contrato
 * no tuvo trades hoy, no es error.
 */
export async function fetchContractTradeSummary(
  occSymbol: string,
  opts: { period?: string } = {},
): Promise<TradeSummaryBucket[]> {
  const period = opts.period ?? "1d";
  const url = `${BASE_URL}/api/option_contracts/${encodeURIComponent(occSymbol)}/trade_summaries?period=${period}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Cookie: await cookie() },
    cache: "no-store",
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new MarketSnackError(
      "Sesión de MarketSnack inválida o expirada. Actualiza la cookie en /ajustes.",
      res.status,
    );
  }
  if (!res.ok) return []; // contrato sin datos hoy (ej. 404), no es error

  const json: { data?: TradeSummaryBucket[] } = await res.json();
  return json.data ?? [];
}

/**
 * `fetchContractTradeSummary` para varios símbolos a la vez, ya reducidos a
 * net premium (`summarizeTradeBuckets`). Batchea en chunks de `concurrency`
 * (default 8) para no disparar todos los fetches de una — Búsqueda de
 * contratos puede pedir esto hasta 5 veces por escaneo (uno por finalista).
 * Un símbolo individual sin datos se omite; una sesión inválida (401/403)
 * propaga el MarketSnackError, igual que `paginate()`.
 */
export async function fetchContractPremiumSummaries(
  occSymbols: string[],
  opts: { period?: string; concurrency?: number } = {},
): Promise<Map<string, ContractPremiumSummary>> {
  const unique = [...new Set(occSymbols)];
  const concurrency = opts.concurrency ?? 8;
  const out = new Map<string, ContractPremiumSummary>();

  for (let i = 0; i < unique.length; i += concurrency) {
    const chunk = unique.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (symbol) => {
        const buckets = await fetchContractTradeSummary(symbol, { period: opts.period });
        return [symbol, summarizeTradeBuckets(buckets)] as const;
      }),
    );
    for (const [symbol, summary] of results) out.set(symbol, summary);
  }

  return out;
}

/**
 * Igual que `fetchContractPremiumSummaries`, pero para "Contratos vecinos
 * 3.0" (lib/contratosVecinos3.ts): resume con `summarizeActivity` en vez de
 * `summarizeTradeBuckets` — a diferencia de esa, acá el `mid_premium` SÍ
 * cuenta (es "Premium Traded" total, no solo la dirección) y se conserva una
 * tendencia reciente (ritmo de los últimos ~10 min contra el ritmo previo del
 * día — ver `summarizeActivity` para el detalle del salto repentino).
 */
export async function fetchContractActivitySummaries(
  occSymbols: string[],
  opts: { period?: string; concurrency?: number } = {},
): Promise<Map<string, ActivitySummary>> {
  const unique = [...new Set(occSymbols)];
  const concurrency = opts.concurrency ?? 8;
  const out = new Map<string, ActivitySummary>();

  for (let i = 0; i < unique.length; i += concurrency) {
    const chunk = unique.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (symbol) => {
        const buckets = await fetchContractTradeSummary(symbol, { period: opts.period });
        return [symbol, summarizeActivity(buckets)] as const;
      }),
    );
    for (const [symbol, summary] of results) out.set(symbol, summary);
  }

  return out;
}

/**
 * Igual que `fetchContractActivitySummaries`, pero agrupando VARIOS símbolos
 * OCC bajo una misma clave antes de resumir — pedido explícito
 * (2026-08-20, "Grandes empresas"): con varios vencimientos semanales en
 * juego a la vez (ver `selectWeeklyExpirations`, lib/grandesEmpresas.ts), el
 * mismo strike de $230 call puede existir el miércoles Y el viernes, y hay
 * que tratarlos como UNA sola actividad combinada en ese nivel de precio, no
 * dos strikes separados. Concatena los buckets crudos de todos los símbolos
 * de un grupo ANTES de `summarizeActivity` (no suma resúmenes ya hechos) para
 * que la tendencia (`trend`) también salga bien calculada sobre la serie de
 * tiempo real combinada, no solo los totales.
 */
export async function fetchContractActivitySummariesGrouped(
  groups: Map<string, string[]>,
  opts: { period?: string; concurrency?: number } = {},
): Promise<Map<string, ActivitySummary>> {
  const allSymbols = [...new Set([...groups.values()].flat())];
  const concurrency = opts.concurrency ?? 8;
  const bucketsBySymbol = new Map<string, TradeSummaryBucket[]>();

  for (let i = 0; i < allSymbols.length; i += concurrency) {
    const chunk = allSymbols.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (symbol) => {
        const buckets = await fetchContractTradeSummary(symbol, { period: opts.period });
        return [symbol, buckets] as const;
      }),
    );
    for (const [symbol, buckets] of results) bucketsBySymbol.set(symbol, buckets);
  }

  const out = new Map<string, ActivitySummary>();
  for (const [key, symbols] of groups) {
    const merged = symbols.flatMap((s) => bucketsBySymbol.get(s) ?? []);
    out.set(key, summarizeActivity(merged));
  }
  return out;
}
