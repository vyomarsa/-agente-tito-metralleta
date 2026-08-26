// Cache en disco de barras, con reserva para cuando Massive no da turno.
//
// Dos motivos, y el segundo llegó con el plan gratis (5 peticiones/minuto):
//   1. Ahorrar llamadas repetidas. Los escaneos (spreads, master, piloto) piden
//      las diarias de decenas de tickers en cada pasada.
//   2. Tener algo que servir cuando la cuota se agota. Antes, un 429 dejaba la
//      gráfica en blanco; ahora se sirven las últimas barras buenas marcadas
//      como `stale` y la UI lo dice, en vez de fingir que no hay datos.
//
// Solo servidor.

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";
import { fetchDailyBars } from "./massive";
import type { DailyBar, TfBar } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "bars");
const TF_DIR = path.join(DATA_DIR, "tf");

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

/**
 * Barras diarias con cache de un día de mercado. Si la red falla, sirve las
 * últimas guardadas (aunque sean de ayer) antes que devolver vacío: para un
 * escáner, una SMA de ayer es utilizable y una lista vacía no.
 */
export async function cachedDailyBars(ticker: string, days = 365, now = new Date()): Promise<DailyBar[]> {
  const today = marketDateStr(now);
  const cached = await loadBars(ticker);
  if (cached && cached.date === today && cached.bars.length > 0) return cached.bars;

  try {
    const bars = await fetchDailyBars(ticker, days);
    if (bars.length > 0) {
      await saveBars(ticker, bars, now);
      return bars;
    }
  } catch {
    // Cuota agotada o fallo de red → abajo se sirve lo último bueno.
  }
  return cached?.bars ?? [];
}

// ---- Barras por timeframe (las de las gráficas) ----

/**
 * Cuánto vale una foto antes de repedirla. El plan gratis sirve datos con 15
 * minutos de retraso, así que refrescar el diario cada minuto no traería nada
 * nuevo: solo gastaría cuota. Los intradía se refrescan más seguido porque su
 * última vela sí cambia dentro de la sesión.
 */
const TTL_MS: Record<string, number> = {
  "1y": 15 * 60_000,
  "15m10d": 5 * 60_000,
  "5m5d": 3 * 60_000,
};
const DEFAULT_TTL_MS = 5 * 60_000;

interface TfBarsFile {
  ticker: string;
  tf: string;
  /** epoch ms de cuando se guardó. */
  savedAt: number;
  bars: TfBar[];
}

export interface TfBarsResult {
  bars: TfBar[];
  /** `true` si son barras viejas servidas porque no hubo forma de refrescarlas. */
  stale: boolean;
  /** Antigüedad de lo servido, en ms. `null` si vienen recién de la red. */
  ageMs: number | null;
  /** Por qué no se pudo refrescar (si es que no se pudo). */
  error?: string;
  /** Solo si el fallo fue de cuota: cuándo tiene sentido reintentar. */
  retryAfterMs?: number;
}

function tfFileFor(ticker: string, tf: string): string {
  const safeT = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  const safeF = tf.replace(/[^a-zA-Z0-9]/g, "");
  return path.join(TF_DIR, `${safeT}__${safeF}.json`);
}

async function loadTfBars(ticker: string, tf: string): Promise<TfBarsFile | null> {
  try {
    const raw = await fs.readFile(tfFileFor(ticker, tf), "utf8");
    const parsed = JSON.parse(raw) as TfBarsFile;
    return Array.isArray(parsed.bars) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveTfBars(ticker: string, tf: string, bars: TfBar[], now: number): Promise<void> {
  await fs.mkdir(TF_DIR, { recursive: true });
  const payload: TfBarsFile = { ticker: ticker.toUpperCase(), tf, savedAt: now, bars };
  await fs.writeFile(tfFileFor(ticker, tf), JSON.stringify(payload), "utf8");
}

// Peticiones en vuelo por (ticker, tf): dos tarjetas que piden las MISMAS barras
// a la vez comparten una sola llamada. Sin esto, el dashboard abre tres tarjetas
// de golpe, las tres fallan la cache recién vencida y salen tres peticiones.
// En globalThis porque Next recarga módulos en dev y monta las rutas juntas.
const g = globalThis as typeof globalThis & { __tfBarsInflight?: Map<string, Promise<TfBarsResult>> };
const inflight: Map<string, Promise<TfBarsResult>> = (g.__tfBarsInflight ??= new Map());

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Error al cargar barras.";
}

function retryAfterOf(err: unknown): number | undefined {
  const r = (err as { retryAfterMs?: unknown })?.retryAfterMs;
  return typeof r === "number" ? r : undefined;
}

async function refresh(
  ticker: string,
  tf: string,
  fetcher: () => Promise<TfBar[]>,
  cached: TfBarsFile | null,
  now: number,
): Promise<TfBarsResult> {
  try {
    const bars = await fetcher();
    if (bars.length > 0) {
      await saveTfBars(ticker, tf, bars, now);
      return { bars, stale: false, ageMs: 0 };
    }
    // Respuesta buena pero vacía (ticker sin datos en ese timeframe): es una
    // respuesta legítima, no un fallo — no se sirve cache viejo por encima.
    return { bars: [], stale: false, ageMs: null };
  } catch (err) {
    if (cached && cached.bars.length > 0) {
      return {
        bars: cached.bars,
        stale: true,
        ageMs: now - cached.savedAt,
        error: messageOf(err),
        retryAfterMs: retryAfterOf(err),
      };
    }
    return {
      bars: [],
      stale: false,
      ageMs: null,
      error: messageOf(err),
      retryAfterMs: retryAfterOf(err),
    };
  }
}

/**
 * Barras de un timeframe con cache, deduplicación de peticiones simultáneas y
 * reserva en disco. `fetcher` lo pone quien llama (la ruta) para que la
 * triangulación de fuentes —Massive, y Schwab para índices— siga viviendo allí
 * y este módulo no tenga que saber de proveedores.
 */
export async function cachedTfBars(
  ticker: string,
  tf: string,
  fetcher: () => Promise<TfBar[]>,
  now = Date.now(),
): Promise<TfBarsResult> {
  const key = `${ticker.toUpperCase()}|${tf}`;
  const cached = await loadTfBars(ticker, tf);
  const ttl = TTL_MS[tf] ?? DEFAULT_TTL_MS;

  if (cached && cached.bars.length > 0 && now - cached.savedAt < ttl) {
    return { bars: cached.bars, stale: false, ageMs: now - cached.savedAt };
  }

  const running = inflight.get(key);
  if (running) return running;

  const job = refresh(ticker, tf, fetcher, cached, now).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}
