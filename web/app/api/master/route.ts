// GET /api/master[?date=YYYY-MM-DD] → el análisis del master del día, con el cruce del
// agente por símbolo: precio actual + SMA 50 + SMA 200. Devuelve TODO el roster (con
// hueco donde el master aún no ha mandado) para que la sección pinte la rejilla completa.

import { loadDay, todayKey, type MasterEntry } from "@/lib/masterStore";
import { ROSTER } from "@/lib/masterRoster";
import { fetchQuotes } from "@/lib/massive";
import { cachedDailyBars } from "@/lib/barsStore";
import { sma } from "@/lib/sma";

export const runtime = "nodejs";

export interface CrossCheck {
  price: number | null;
  sma50: number | null;
  sma200: number | null;
}

export interface MasterTickerView {
  ticker: string;
  label: string;
  entry: MasterEntry | null;
  cross: CrossCheck;
}

export interface MasterView {
  date: string;
  updatedAt: number | null;
  news: MasterEntry | null;
  tickers: MasterTickerView[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || todayKey();
  const day = await loadDay(date);

  const byTicker = new Map<string, MasterEntry>();
  const newsEntries: MasterEntry[] = [];
  for (const e of day?.entries ?? []) {
    if (e.kind === "news") newsEntries.push(e);
    else if (e.ticker) byTicker.set(e.ticker, e);
  }
  // Puede haber VARIOS bloques de noticias en un día (p. ej. el brief matutino con el
  // calendario económico + earnings, y aparte una nota geopolítica). Los mostramos TODOS,
  // en orden de llegada, fundidos en una sola entrada con separador. Antes solo se veía el
  // último (last-wins) y el brief quedaba oculto.
  newsEntries.sort((a, b) => a.receivedAt - b.receivedAt);
  const news: MasterEntry | null = newsEntries.length
    ? {
        ...newsEntries[0],
        text: newsEntries.map((e) => e.text).join("\n\n———\n\n"),
        image: newsEntries.find((e) => e.image)?.image ?? null,
      }
    : null;

  // Precio en vivo de todo el roster en UNA llamada.
  const symbols = ROSTER.map((r) => r.ticker);
  const quotes = await fetchQuotes(symbols).catch(() => []);
  const priceBy = new Map(quotes.map((q) => [q.ticker, q.price]));

  // SMA 50/200 por símbolo (barras cacheadas por día → solo la 1ª carga es lenta).
  const tickers: MasterTickerView[] = await Promise.all(
    ROSTER.map(async (r) => {
      const bars = await cachedDailyBars(r.ticker, 365).catch(() => []);
      const closes = bars.map((b) => b.close);
      return {
        ticker: r.ticker,
        label: r.label,
        entry: byTicker.get(r.ticker) ?? null,
        cross: {
          price: priceBy.get(r.ticker) ?? null,
          sma50: sma(closes, 50),
          sma200: sma(closes, 200),
        },
      };
    }),
  );

  const view: MasterView = { date, updatedAt: day?.updatedAt ?? null, news, tickers };
  return Response.json(view);
}
