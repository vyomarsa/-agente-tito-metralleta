// ============================================================================
// Marcador en vivo del 0DTE — alterno vs original.
//
// El agente publica DOS modelos a la vez (sesgo original vs alterno con flujo,
// trade de vuelta al imán vs momentum γ−). Sin un marcador, tener dos modelos es
// tener dos opiniones; con marcador es un experimento: cada llamada se apunta con
// su hora de vencimiento y se corrige sola.
//
//   · Sesgo (5 min): se apunta el cono [low, high] y la dirección. A los 5 minutos
//     se compara con el spot de ese momento → acierto de rango y de dirección.
//   · Trade: se apunta entrada/objetivo/stop. En cada refresco se mira si el spot
//     tocó el objetivo (win) o el stop (loss); al cerrar la sesión queda "flat".
//
// El libro vive en data/0dte/live/{TICKER}.json y se reinicia cada día de mercado.
// La calificación es PURA (`gradeBook`); el fichero solo entra y sale.
//
// Precisión honesta: el spot solo se conoce cuando la página consulta (cada
// minuto), así que un objetivo tocado y devuelto ENTRE dos consultas no se ve.
// El marcador mide lo que el agente pudo ver en vivo, no el tick perfecto.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";
import type { BiasDir, TradeModel, ZeroDteBias, ZeroDteTrade } from "./zerodteSignals";

const DATA_DIR = path.join(process.cwd(), "data", "0dte", "live");
/** Horizonte del sesgo publicado, en minutos. */
export const BIAS_MINUTES = 5;
/** No se apunta otra llamada del mismo modelo antes de esto (evita duplicar por refrescos). */
export const MIN_CALL_GAP_MS = 55_000;
/** Tope de llamadas guardadas por día y modelo. */
export const MAX_CALLS = 400;

export type BiasModel = "original" | "alterno";

export interface BiasCall {
  id: string;
  model: BiasModel;
  at: string;
  dueAt: string;
  spot: number;
  center: number;
  low: number;
  high: number;
  dir: BiasDir;
  /** Spot observado al vencer la llamada (null mientras no vence). */
  actual: number | null;
  /** ¿Cayó dentro del cono de 1σ? */
  hitRange: boolean | null;
  /** ¿Acertó la dirección? (en "flat" acierta si se movió menos de 1σ) */
  hitDir: boolean | null;
}

export interface TradeCall {
  id: string;
  model: TradeModel;
  at: string;
  side: "LONG" | "SHORT";
  entry: number;
  target: number;
  stop: number;
  rr: number;
  status: "open" | "win" | "loss" | "flat";
  closedAt: string | null;
  closePrice: number | null;
}

export interface ZeroDteLiveBook {
  ticker: string;
  date: string;
  updatedAt: string;
  bias: BiasCall[];
  trades: TradeCall[];
}

export interface BiasScore {
  model: BiasModel;
  graded: number;
  open: number;
  rangeHits: number;
  dirHits: number;
  rangePct: number | null;
  dirPct: number | null;
}

export interface TradeScore {
  model: TradeModel;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
}

export interface ZeroDteScoreboard {
  date: string;
  bias: BiasScore[];
  trades: TradeScore[];
}

// ---------------------------------------------------------------------------
// Núcleo puro
// ---------------------------------------------------------------------------

export function emptyBook(ticker: string, now: Date): ZeroDteLiveBook {
  return {
    ticker: ticker.trim().toUpperCase(),
    date: marketDateStr(now),
    updatedAt: now.toISOString(),
    bias: [],
    trades: [],
  };
}

/**
 * Apunta una llamada de sesgo si toca. No se apunta si el mercado está cerrado ni
 * si la anterior del mismo modelo es más reciente que `MIN_CALL_GAP_MS` (la página
 * refresca cada minuto, pero un F5 del usuario no debe inflar el marcador).
 * Devuelve el libro (mutado) para encadenar.
 */
export function recordBias(
  book: ZeroDteLiveBook,
  bias: ZeroDteBias,
  now: Date,
  marketOpen: boolean,
): ZeroDteLiveBook {
  if (!marketOpen) return book;
  const last = [...book.bias].reverse().find((b) => b.model === bias.model);
  if (last && now.getTime() - Date.parse(last.at) < MIN_CALL_GAP_MS) return book;
  book.bias.push({
    id: `${bias.model}-${now.getTime()}`,
    model: bias.model,
    at: now.toISOString(),
    dueAt: new Date(now.getTime() + bias.minutes * 60_000).toISOString(),
    spot: bias.spot,
    center: bias.center,
    low: bias.low,
    high: bias.high,
    dir: bias.dir,
    actual: null,
    hitRange: null,
    hitDir: null,
  });
  if (book.bias.length > MAX_CALLS * 2) book.bias = book.bias.slice(-MAX_CALLS * 2);
  return book;
}

/**
 * Apunta un trade si ese modelo no tiene ya uno abierto. Un modelo sostiene UNA
 * idea a la vez: si el precio se mueve, la idea vieja se resuelve antes de abrir
 * otra, que es como se operaría de verdad.
 */
export function recordTrade(
  book: ZeroDteLiveBook,
  trade: ZeroDteTrade,
  now: Date,
  marketOpen: boolean,
): ZeroDteLiveBook {
  if (!marketOpen) return book;
  if (book.trades.some((t) => t.model === trade.model && t.status === "open")) return book;
  book.trades.push({
    id: `${trade.model}-${now.getTime()}`,
    model: trade.model,
    at: now.toISOString(),
    side: trade.side,
    entry: trade.entry,
    target: trade.target,
    stop: trade.stop,
    rr: trade.rr,
    status: "open",
    closedAt: null,
    closePrice: null,
  });
  if (book.trades.length > MAX_CALLS) book.trades = book.trades.slice(-MAX_CALLS);
  return book;
}

/**
 * Corrige todo lo que haya vencido con el spot actual. PURA sobre el libro
 * (lo muta y lo devuelve).
 *
 * · Sesgo: vence a los 5 min. Rango = el spot cayó dentro del cono; dirección =
 *   se movió hacia donde decía (o se quedó dentro del cono si dijo "lateral").
 * · Trade: gana si el spot alcanzó el objetivo, pierde si alcanzó el stop. Con el
 *   mercado cerrado, lo que siga abierto se marca "flat" (ni ganó ni perdió).
 */
export function gradeBook(
  book: ZeroDteLiveBook,
  spot: number,
  now: Date,
  marketOpen: boolean,
): ZeroDteLiveBook {
  const nowMs = now.getTime();

  for (const b of book.bias) {
    if (b.actual != null) continue;
    if (Date.parse(b.dueAt) > nowMs) continue;
    b.actual = spot;
    b.hitRange = spot >= b.low && spot <= b.high;
    const moved = spot - b.spot;
    const sigma = (b.high - b.low) / 2;
    b.hitDir =
      b.dir === "up" ? moved > 0 : b.dir === "down" ? moved < 0 : Math.abs(moved) <= sigma;
  }

  for (const t of book.trades) {
    if (t.status !== "open") continue;
    const hitTarget = t.side === "LONG" ? spot >= t.target : spot <= t.target;
    const hitStop = t.side === "LONG" ? spot <= t.stop : spot >= t.stop;
    if (hitTarget) {
      t.status = "win"; t.closedAt = now.toISOString(); t.closePrice = spot;
    } else if (hitStop) {
      t.status = "loss"; t.closedAt = now.toISOString(); t.closePrice = spot;
    } else if (!marketOpen) {
      t.status = "flat"; t.closedAt = now.toISOString(); t.closePrice = spot;
    }
  }

  book.updatedAt = now.toISOString();
  return book;
}

/** Marcador agregado por modelo. PURA. */
export function scoreboard(book: ZeroDteLiveBook): ZeroDteScoreboard {
  const biasModels: BiasModel[] = ["original", "alterno"];
  const bias: BiasScore[] = biasModels.map((model) => {
    const all = book.bias.filter((b) => b.model === model);
    const graded = all.filter((b) => b.actual != null);
    const rangeHits = graded.filter((b) => b.hitRange).length;
    const dirHits = graded.filter((b) => b.hitDir).length;
    return {
      model,
      graded: graded.length,
      open: all.length - graded.length,
      rangeHits,
      dirHits,
      rangePct: graded.length > 0 ? (rangeHits / graded.length) * 100 : null,
      dirPct: graded.length > 0 ? (dirHits / graded.length) * 100 : null,
    };
  });

  const tradeModels: TradeModel[] = ["magnet", "momentum"];
  const trades: TradeScore[] = tradeModels.map((model) => {
    const all = book.trades.filter((t) => t.model === model);
    const wins = all.filter((t) => t.status === "win").length;
    const losses = all.filter((t) => t.status === "loss").length;
    const flats = all.filter((t) => t.status === "flat").length;
    const closed = wins + losses + flats;
    const decided = wins + losses;
    return {
      model,
      closed,
      open: all.length - closed,
      wins,
      losses,
      flats,
      winRate: decided > 0 ? (wins / decided) * 100 : null,
    };
  });

  return { date: book.date, bias, trades };
}

// ---------------------------------------------------------------------------
// Entrada / salida
// ---------------------------------------------------------------------------

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

/** Carga el libro del día. Si el guardado es de otra fecha de mercado, arranca uno nuevo. */
export async function loadLiveBook(ticker: string, now: Date = new Date()): Promise<ZeroDteLiveBook> {
  const clean = ticker.trim().toUpperCase();
  try {
    const raw = await fs.readFile(fileFor(clean), "utf8");
    const parsed = JSON.parse(raw) as ZeroDteLiveBook;
    if (parsed?.date !== marketDateStr(now) || !Array.isArray(parsed.bias) || !Array.isArray(parsed.trades)) {
      return emptyBook(clean, now);
    }
    return parsed;
  } catch {
    return emptyBook(clean, now);
  }
}

export async function saveLiveBook(book: ZeroDteLiveBook): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(book.ticker), JSON.stringify(book), "utf8");
}
