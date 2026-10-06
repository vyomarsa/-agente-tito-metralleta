// ============================================================================
// Simulador de PAPEL del Agente 0DTE — estrategia "pin al imán en γ+".
//
// NO ejecuta operaciones reales. Registra una operación EN PAPEL por sesión y,
// tras el cierre, la puntúa contra las barras intradía reales para medir si la
// señal del GEX (el anclaje al imán en gamma positiva) acierta. Mide en PUNTOS
// del subyacente (SPX), sin supuestos de precio de opción.
//
// Se acumula HACIA ADELANTE: no hay backtest (no hay data histórica de opciones
// ni historial del agente); cada día suma una operación y en semanas hay una
// estadística real. Lógica pura testeable; persistencia en fs (solo servidor).
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";
import {
  DEFAULT_PARAMS, evaluateEntry, type Direction, type EntryDecision, type SimParams,
} from "./zerodteStrategy";

// Reexporta la estrategia pura para que la ruta y los tests sigan importando
// todo desde aquí (el cliente la importa directo de ./zerodteStrategy, sin fs).
export { DEFAULT_PARAMS, evaluateEntry };
export type { Direction, EntryDecision, SimParams };

const DATA_DIR = path.join(process.cwd(), "data", "pdf", "odte-standalone", "sim");

/** Operaciones a conservar por ticker. */
export const JOURNAL_DAYS = 250;

export type ExitReason = "target" | "stop" | "close";
export type Outcome = "win" | "loss" | "flat";

export interface SimBar {
  time: number; // unix sec
  high: number;
  low: number;
  close: number;
}

export interface PaperTrade {
  date: string;
  openedAt: string;
  entrySec: number;
  direction: Direction;
  entry: number;
  target: number;
  stop: number;
  // Se rellena al puntuar tras el cierre:
  matured: boolean;
  exit: number | null;
  exitReason: ExitReason | null;
  pnlPts: number | null;
  outcome: Outcome | null;
}

export interface SimJournal {
  ticker: string;
  updatedAt: string;
  trades: PaperTrade[]; // más reciente primero
}

export interface SimSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;    // %
  totalPts: number;
  avgPts: number | null;
  maxDrawdownPts: number;    // peor caída acumulada (en puntos, valor negativo)
  byExit: { target: number; stop: number; close: number };
}

// -------------------------------------------------------------------- scoring

/**
 * Puntúa una operación abierta contra las barras intradía reales. PURA.
 *
 * Recorre las barras desde la entrada. Gana si toca el target antes que el stop;
 * pierde si toca el stop antes. Si en la misma barra toca ambos, se toma el STOP
 * (conservador: no inflar aciertos). Si no toca ninguno, cierra al último precio.
 */
export function scoreTrade(trade: PaperTrade, bars: SimBar[]): PaperTrade {
  const window = bars
    .filter((b) => b.time >= trade.entrySec)
    .sort((a, b) => a.time - b.time);
  if (window.length === 0) {
    return { ...trade, matured: false };
  }

  const long = trade.direction === "long";
  let exit: number | null = null;
  let reason: ExitReason = "close";

  for (const b of window) {
    const hitTarget = long ? b.high >= trade.target : b.low <= trade.target;
    const hitStop = long ? b.low <= trade.stop : b.high >= trade.stop;
    if (hitStop) { exit = trade.stop; reason = "stop"; break; } // conservador
    if (hitTarget) { exit = trade.target; reason = "target"; break; }
  }
  if (exit == null) {
    exit = window[window.length - 1].close;
    reason = "close";
  }

  const pnlPts = long ? exit - trade.entry : trade.entry - exit;
  const outcome: Outcome = pnlPts > 0.01 ? "win" : pnlPts < -0.01 ? "loss" : "flat";
  return { ...trade, matured: true, exit, exitReason: reason, pnlPts, outcome };
}

/** Estadística sobre las operaciones maduradas. PURA. */
export function summarize(trades: PaperTrade[]): SimSummary {
  const done = trades.filter((t) => t.matured && t.pnlPts != null);
  const n = done.length;
  const wins = done.filter((t) => t.outcome === "win").length;
  const losses = done.filter((t) => t.outcome === "loss").length;
  const totalPts = done.reduce((s, t) => s + (t.pnlPts ?? 0), 0);
  const byExit = { target: 0, stop: 0, close: 0 };
  for (const t of done) if (t.exitReason) byExit[t.exitReason] += 1;

  // Drawdown: peor caída de la curva de equity (orden cronológico).
  const chrono = [...done].sort((a, b) => a.date.localeCompare(b.date));
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of chrono) {
    equity += t.pnlPts ?? 0;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }

  return {
    trades: n,
    wins,
    losses,
    winRate: n ? (wins / n) * 100 : null,
    totalPts,
    avgPts: n ? totalPts / n : null,
    maxDrawdownPts: maxDd,
    byExit,
  };
}

// ------------------------------------------------------------------ persistencia

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

export async function loadSimJournal(ticker: string): Promise<SimJournal | null> {
  try {
    const raw = await fs.readFile(fileFor(ticker), "utf8");
    const parsed = JSON.parse(raw) as SimJournal;
    return Array.isArray(parsed.trades) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveSimJournal(journal: SimJournal): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(journal.ticker), JSON.stringify(journal), "utf8");
}

/** Abre la operación de HOY si aún no existe. Devuelve el journal actualizado. */
export function openTodayTrade(
  journal: SimJournal,
  decision: EntryDecision,
  now: Date = new Date(),
): SimJournal {
  const date = marketDateStr(now);
  if (journal.trades.some((t) => t.date === date)) return journal; // ya hay una
  const trade: PaperTrade = {
    date,
    openedAt: now.toISOString(),
    entrySec: Math.floor(now.getTime() / 1000),
    direction: decision.direction,
    entry: decision.entry,
    target: decision.target,
    stop: decision.stop,
    matured: false,
    exit: null,
    exitReason: null,
    pnlPts: null,
    outcome: null,
  };
  return {
    ...journal,
    updatedAt: now.toISOString(),
    trades: [trade, ...journal.trades].slice(0, JOURNAL_DAYS),
  };
}

export function emptyJournal(ticker: string): SimJournal {
  return { ticker: ticker.toUpperCase(), updatedAt: new Date(0).toISOString(), trades: [] };
}
