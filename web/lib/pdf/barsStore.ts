// Cache en disco de barras diarias, por día de mercado.
//
// Las barras diarias solo cambian una vez al día, pero una sola carga de
// ticker en la página principal dispara hasta 5 rutas (history, prediction,
// flow, validation, ideas) pidiendo las mismas barras en paralelo — sin este
// cache eso son 5 llamadas idénticas a Massive por carga, y de ahí salían los
// 429 en ráfaga. Solo servidor.

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";
import { fetchDailyBars } from "./massive";
import type { DailyBar } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "pdf", "bars");

interface BarsFile {
  ticker: string;
  /** Día de mercado (ET) en que se guardó. */
  date: string;
  bars: DailyBar[];
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

export async function loadBars(ticker: string): Promise<BarsFile | null> {
  try {
    const raw = await fs.readFile(fileFor(ticker), "utf8");
    return JSON.parse(raw) as BarsFile;
  } catch {
    return null;
  }
}

export async function saveBars(ticker: string, bars: DailyBar[], now = new Date()): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload: BarsFile = { ticker: ticker.toUpperCase(), date: marketDateStr(now), bars };
  await fs.writeFile(fileFor(ticker), JSON.stringify(payload), "utf8");
}

// El cache en disco solo evita llamadas repetidas ENTRE cargas (una por día de
// mercado). Dentro de una misma carga, las rutas llegan casi al mismo tiempo y
// ninguna ve todavía el archivo que las demás están por escribir — por eso
// además se deduplican las solicitudes EN VUELO, por ticker+días, para que las
// 5 rutas que piden lo mismo en paralelo compartan una sola llamada real.
const inFlight = new Map<string, Promise<DailyBar[]>>();

/** Barras diarias con cache de un día de mercado. Propaga errores de red. */
export async function cachedDailyBarsOrThrow(
  ticker: string,
  days = 365,
  now = new Date(),
): Promise<DailyBar[]> {
  const key = ticker.trim().toUpperCase();
  const today = marketDateStr(now);
  const cached = await loadBars(key);
  if (cached && cached.date === today && cached.bars.length > 0) return cached.bars;

  const flightKey = `${key}:${days}`;
  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const bars = await fetchDailyBars(key, days);
      if (bars.length > 0) await saveBars(key, bars, now);
      return bars;
    } finally {
      inFlight.delete(flightKey);
    }
  })();
  inFlight.set(flightKey, promise);
  return promise;
}

/** Igual que `cachedDailyBarsOrThrow`, pero devuelve [] si falla la red. */
export async function cachedDailyBars(ticker: string, days = 365, now = new Date()): Promise<DailyBar[]> {
  return cachedDailyBarsOrThrow(ticker, days, now).catch(() => [] as DailyBar[]);
}
