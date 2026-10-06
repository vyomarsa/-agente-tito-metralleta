// Tarea 7 del Proceso Principal — monitoreo de noticias.
//
// Dos capas, porque ninguna sola alcanza:
//   1. MACRO  — los feeds RSS de RSS Feed.md (CNBC + Investing.com). Son feeds
//      generales de mercado: mueven a todos los tickers por igual (Fed, tarifas,
//      inflación). Se cachean porque el resultado es idéntico para cada búsqueda.
//   2. EMPRESA — noticias del ticker desde Massive, que además trae sentimiento
//      por ticker con su razonamiento.
//
// Puente entre ambas: si un titular de los feeds macro menciona a la empresa,
// se promueve a la capa de empresa. Así los feeds del documento sí aportan
// señal por ticker cuando la tienen.
//
// Las funciones de red viven al final; todo lo de arriba es puro y testeable.

export type Sentiment = "positive" | "negative" | "neutral";
export type Bias = "bullish" | "bearish" | "mixed" | "neutral";
export type FlagKind = "confirm" | "conflict" | "none";

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  publisher: string;
  publishedUtc: string;
  description: string | null;
  /** Sentimiento para ESTE ticker (solo lo da Massive). */
  sentiment: Sentiment | null;
  reasoning: string | null;
  layer: "company" | "macro";
  /** Qué término hizo match cuando la noticia viene de un feed macro. */
  matchedBy?: string;
}

/** Feeds de RSS Feed.md. `siteContentMetadata` queda fuera: devuelve 0 artículos. */
export const MACRO_FEEDS: { name: string; url: string }[] = [
  {
    name: "CNBC — Top News",
    url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
  },
  {
    name: "CNBC — Economía",
    url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258",
  },
  {
    name: "Investing.com — Earnings",
    url: "https://www.investing.com/rss/news_1062.rss",
  },
  {
    name: "Investing.com — Macro",
    url: "https://www.investing.com/rss/news_14.rss",
  },
];

// ---------- parseo de RSS ----------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (m, code: string) => {
    const named = ENTITIES[code.toLowerCase()];
    if (named) return named;
    if (code.startsWith("#")) {
      const n = Number(code.slice(1));
      if (Number.isFinite(n)) return String.fromCharCode(n);
    }
    return m;
  });
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return null;
  const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return raw ? decodeEntities(raw) : null;
}

/**
 * Fecha del feed a ISO. CNBC usa RFC-822 ("Fri, 24 Jul 2026 03:15:46 GMT");
 * Investing.com usa "2026-07-24 02:54:27" sin zona — se asume UTC.
 */
export function parseFeedDate(raw: string | null): string | null {
  if (!raw) return null;
  const naive = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  const d = new Date(naive ? `${naive[1]}T${naive[2]}Z` : raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extrae los <item> de un XML de RSS. Tolerante: los feeds vienen en una sola línea. */
export function parseRss(xml: string, publisher: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = tag(block, "title");
    const link = tag(block, "link");
    if (!title || !link) continue;
    const published = parseFeedDate(tag(block, "pubDate"));
    items.push({
      id: tag(block, "guid") ?? link,
      title,
      url: link,
      publisher,
      publishedUtc: published ?? new Date(0).toISOString(),
      description: tag(block, "description"),
      sentiment: null,
      reasoning: null,
      layer: "macro",
    });
  }
  return items;
}

// ---------- match empresa ----------

const NAME_NOISE =
  /\b(inc|inc\.|incorporated|corp|corp\.|corporation|company|co|co\.|plc|ltd|ltd\.|limited|holdings?|group|the|common|ordinary|class\s+[a-c]|shares?|stock|capital|nv|sa|ag)\b/gi;

/**
 * Nombres con los que buscar a la empresa en un titular.
 * "Tesla, Inc. Common Stock" → ["Tesla"]; "NVIDIA Corporation" → ["NVIDIA"].
 */
export function companyAliases(ticker: string, name: string | null): string[] {
  const out = new Set<string>();
  const t = ticker.trim().toUpperCase();
  // Tickers de 1-2 letras hacen match con cualquier cosa ("A", "IT", "ON").
  if (t.length >= 3) out.add(t);
  if (name) {
    const clean = name.replace(/[,.]/g, " ").replace(NAME_NOISE, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 3) out.add(clean);
    const first = clean.split(" ")[0];
    if (first && first.length >= 4) out.add(first);
  }
  return [...out];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Devuelve el alias que apareció en el texto, o null. El ticker exige mayúsculas. */
export function mentionsCompany(text: string, aliases: string[]): string | null {
  for (const a of aliases) {
    const isTicker = a === a.toUpperCase() && !a.includes(" ");
    const re = new RegExp(`(^|[^\\w])${escapeRe(a)}($|[^\\w])`, isTicker ? "" : "i");
    if (re.test(text)) return a;
  }
  return null;
}

// ---------- sesgo y bandera ----------

const HOUR = 3600_000;

/** Peso por frescura: una noticia de hoy pesa más que una de la semana pasada. */
export function recencyWeight(publishedUtc: string, now: Date): number {
  const age = (now.getTime() - new Date(publishedUtc).getTime()) / HOUR;
  if (!Number.isFinite(age) || age < 0) return 1;
  if (age <= 24) return 1;
  if (age <= 72) return 0.6;
  if (age <= 24 * 7) return 0.3;
  return 0.1;
}

export interface NewsBias {
  bias: Bias;
  /** −1 (muy negativo) … +1 (muy positivo), ponderado por frescura. */
  score: number;
  positive: number;
  negative: number;
  neutral: number;
}

export function newsBias(items: NewsItem[], now: Date): NewsBias {
  let num = 0, den = 0, positive = 0, negative = 0, neutral = 0;
  for (const it of items) {
    if (!it.sentiment) continue;
    if (it.sentiment === "positive") positive += 1;
    else if (it.sentiment === "negative") negative += 1;
    else neutral += 1;
    const w = recencyWeight(it.publishedUtc, now);
    den += w;
    if (it.sentiment === "positive") num += w;
    else if (it.sentiment === "negative") num -= w;
  }
  const score = den > 0 ? num / den : 0;
  let bias: Bias = "neutral";
  if (den === 0) bias = "neutral";
  else if (score >= 0.25) bias = "bullish";
  else if (score <= -0.25) bias = "bearish";
  else if (positive > 0 && negative > 0) bias = "mixed";
  return { bias, score, positive, negative, neutral };
}

/** Dirección del flujo a partir del % de premium en calls. */
export function flowBias(callPct: number): Bias {
  if (callPct >= 60) return "bullish";
  if (callPct <= 40) return "bearish";
  return "neutral";
}

export interface ContradictionFlag {
  kind: FlagKind;
  title: string;
  detail: string;
}

/**
 * Bandera de contradicción — NO toca los 100 pts del scorecard.
 * Solo confronta lo que apuesta el dinero contra lo que dicen las noticias.
 */
export function contradictionFlag(flow: Bias, news: NewsBias): ContradictionFlag {
  const f = flow === "bullish" || flow === "bearish" ? flow : null;
  const n = news.bias === "bullish" || news.bias === "bearish" ? news.bias : null;

  if (!f || !n) {
    return {
      kind: "none",
      title: "Sin contradicción clara",
      detail:
        !n
          ? "Las noticias no marcan una dirección definida, así que no hay nada que confrontar con el flujo."
          : "El flujo está repartido entre calls y puts: no hay una apuesta dominante que contrastar.",
    };
  }

  if (f === n) {
    return {
      kind: "confirm",
      title: f === "bullish" ? "Flujo alcista confirmado por las noticias" : "Flujo bajista confirmado por las noticias",
      detail:
        "El dinero apuesta en la misma dirección que las noticias. Ojo: cuando la noticia ya salió, " +
        "el flujo suele estar reaccionando y no anticipando.",
    };
  }

  return {
    kind: "conflict",
    title: f === "bullish" ? "Flujo alcista contra noticias negativas" : "Flujo bajista contra noticias positivas",
    detail:
      f === "bullish"
        ? "Alguien está comprando contra el pánico: la noticia es mala pero el dinero grande apuesta al alza."
        : "Alguien está vendiendo contra la euforia: la noticia es buena pero el dinero grande apuesta a la baja.",
  };
}

// ---------- red (solo servidor) ----------

interface CacheEntry<T> { at: number; value: T }
const macroCache: { entry: CacheEntry<NewsItem[]> | null } = { entry: null };
const tickerCache = new Map<string, CacheEntry<NewsItem[]>>();
const MACRO_TTL = 15 * 60_000;
const TICKER_TTL = 5 * 60_000;

interface MassiveNews {
  id?: string;
  title?: string;
  article_url?: string;
  published_utc?: string;
  description?: string;
  publisher?: { name?: string };
  insights?: { ticker?: string; sentiment?: string; sentiment_reasoning?: string }[];
}

/** Capa 2 — noticias del ticker, con el sentimiento que ya calcula Massive. */
export async function fetchTickerNews(ticker: string, limit = 12): Promise<NewsItem[]> {
  const clean = ticker.trim().toUpperCase();
  const hit = tickerCache.get(clean);
  if (hit && Date.now() - hit.at < TICKER_TTL) return hit.value;

  const key = process.env.MASSIVE_API_KEY;
  if (!key) return [];
  const url =
    `https://api.massive.com/v2/reference/news?ticker=${encodeURIComponent(clean)}` +
    `&order=desc&sort=published_utc&limit=${limit}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: MassiveNews[] };

  const items: NewsItem[] = (json.results ?? [])
    .filter((r) => r.title && r.article_url)
    .map((r) => {
      // Un artículo cubre varios tickers; solo interesa el insight del nuestro.
      const mine = r.insights?.find((i) => i.ticker?.toUpperCase() === clean);
      const s = mine?.sentiment?.toLowerCase();
      return {
        id: r.id ?? r.article_url!,
        title: r.title!,
        url: r.article_url!,
        publisher: r.publisher?.name ?? "—",
        publishedUtc: r.published_utc ?? new Date().toISOString(),
        description: r.description ?? null,
        sentiment: s === "positive" || s === "negative" || s === "neutral" ? s : null,
        reasoning: mine?.sentiment_reasoning ?? null,
        layer: "company" as const,
      };
    });

  tickerCache.set(clean, { at: Date.now(), value: items });
  return items;
}

/** Capa 1 — los feeds RSS del documento. Idénticos para todos los tickers → se cachean. */
export async function fetchMacroFeeds(): Promise<NewsItem[]> {
  if (macroCache.entry && Date.now() - macroCache.entry.at < MACRO_TTL) {
    return macroCache.entry.value;
  }

  const results = await Promise.all(
    MACRO_FEEDS.map(async (f) => {
      try {
        const res = await fetch(f.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; VisionaryTrades/1.0)" },
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [];
        return parseRss(await res.text(), f.name);
      } catch {
        return []; // un feed caído no puede tumbar el panel
      }
    }),
  );

  const seen = new Set<string>();
  const items = results
    .flat()
    .filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)))
    .sort((a, b) => b.publishedUtc.localeCompare(a.publishedUtc));

  macroCache.entry = { at: Date.now(), value: items };
  return items;
}

export interface NewsReport {
  ticker: string;
  company: NewsItem[];
  macro: NewsItem[];
  /** Titulares de los feeds RSS que sí nombran a la empresa. */
  promoted: NewsItem[];
  bias: NewsBias;
  feedsOk: number;
  feedsTotal: number;
}

/** Junta las dos capas y calcula el sesgo de noticias del ticker. */
export async function buildNewsReport(
  ticker: string,
  companyName: string | null,
  now: Date,
): Promise<NewsReport> {
  const [company, macroAll] = await Promise.all([
    fetchTickerNews(ticker).catch(() => []),
    fetchMacroFeeds().catch(() => []),
  ]);

  const aliases = companyAliases(ticker, companyName);
  const promoted: NewsItem[] = [];
  const macro: NewsItem[] = [];
  for (const it of macroAll) {
    const hit = mentionsCompany(`${it.title} ${it.description ?? ""}`, aliases);
    if (hit) promoted.push({ ...it, matchedBy: hit });
    else macro.push(it);
  }

  return {
    ticker,
    company,
    macro: macro.slice(0, 6),
    promoted: promoted.slice(0, 4),
    // El sesgo sale solo de la capa de empresa: es la única con sentimiento por ticker.
    bias: newsBias(company, now),
    feedsOk: new Set(macroAll.map((i) => i.publisher)).size,
    feedsTotal: MACRO_FEEDS.length,
  };
}
