// Memoria del 0DTE — diario propio de pronósticos de cierre para auto-evaluación.
//
// Vive en data/0dte/{TICKER}.json, SEPARADO del diario de la vista Pro
// (data/predictions), porque el 0DTE guarda un pronóstico de cierre del MISMO día
// (madura al cierre de hoy), mientras que Pro guarda horizontes de 10-30 días.
// Mezclarlos corrompería ambos (dedupe por fecha). La revisión es PURA.

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";

const DATA_DIR = path.join(process.cwd(), "data", "0dte");
export const JOURNAL_DAYS = 120;

export interface ZeroDteSnapshot {
  date: string;   // fecha de mercado (ET), YYYY-MM-DD
  savedAt: string;
  spot: number;
  base: number;   // pronóstico de cierre (imán)
  bull: number;
  bear: number;
  lean: "alcista" | "bajista" | "lateral";
  confidence: number;
}

export interface ZeroDteJournal {
  ticker: string;
  updatedAt: string;
  snapshots: ZeroDteSnapshot[]; // más reciente primero
}

export interface ZeroDteBar { time: string; high: number; low: number; close: number; }

export interface ZeroDteEval {
  date: string;
  matured: boolean;            // ya hay barra de cierre de ese día
  spot: number;
  base: number;
  bull: number;
  bear: number;
  lean: string;
  actualClose: number | null;
  baseErrorPct: number | null; // firmado: (real − base) / spot × 100
  baseAbsErrorPct: number | null;
  directionHit: boolean | null;
  best: "bear" | "base" | "bull" | null;
}

export interface ZeroDteReview {
  evals: ZeroDteEval[];
  maturedCount: number;
  meanAbsErrorPct: number | null;
  biasPct: number | null;
  directionHitRate: number | null; // 0-100
  bestCounts: { bear: number; base: number; bull: number };
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

export async function loadZeroDteJournal(ticker: string): Promise<ZeroDteJournal | null> {
  try {
    const raw = await fs.readFile(fileFor(ticker), "utf8");
    const parsed = JSON.parse(raw) as ZeroDteJournal;
    return Array.isArray(parsed.snapshots) ? parsed : null;
  } catch {
    return null;
  }
}

/** Guarda la foto del día (una por fecha de mercado; se reemplaza si ya existe). */
export async function saveZeroDtePrediction(
  ticker: string,
  snap: Omit<ZeroDteSnapshot, "date" | "savedAt">,
  now: Date = new Date(),
): Promise<ZeroDteJournal> {
  const clean = ticker.trim().toUpperCase();
  const date = marketDateStr(now);
  const snapshot: ZeroDteSnapshot = { ...snap, date, savedAt: now.toISOString() };

  const existing = await loadZeroDteJournal(clean);
  const byDate = new Map<string, ZeroDteSnapshot>();
  for (const s of existing?.snapshots ?? []) byDate.set(s.date, s);
  byDate.set(date, snapshot);

  const snapshots = [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, JOURNAL_DAYS);

  const payload: ZeroDteJournal = { ticker: clean, updatedAt: now.toISOString(), snapshots };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(clean), JSON.stringify(payload), "utf8");
  return payload;
}

/**
 * Revisa cada pronóstico contra la barra diaria de SU MISMO día (el 0DTE madura al
 * cierre de hoy). "Madura" cuando ya existe la barra de cierre de esa fecha. PURA.
 */
export function evalZeroDte(
  snapshots: ZeroDteSnapshot[],
  bars: ZeroDteBar[],
  now: Date = new Date(),
): ZeroDteReview {
  const barByDate = new Map<string, ZeroDteBar>();
  for (const b of bars) barByDate.set(b.time, b);
  const today = marketDateStr(now);

  const evals: ZeroDteEval[] = snapshots.map((s) => {
    const bar = barByDate.get(s.date);
    // Solo cuenta como madura si es un día anterior a hoy (o hoy con barra cerrada).
    const matured = !!bar && s.date < today;
    if (!matured || !bar) {
      return {
        date: s.date, matured: false, spot: s.spot, base: s.base, bull: s.bull, bear: s.bear,
        lean: s.lean, actualClose: null, baseErrorPct: null, baseAbsErrorPct: null,
        directionHit: null, best: null,
      };
    }
    const actualClose = bar.close;
    const baseErrorPct = s.spot > 0 ? ((actualClose - s.base) / s.spot) * 100 : null;
    const targets: [ZeroDteEval["best"], number][] = [
      ["bear", s.bear], ["base", s.base], ["bull", s.bull],
    ];
    const best = targets.slice().sort(
      (a, b) => Math.abs(a[1] - actualClose) - Math.abs(b[1] - actualClose),
    )[0][0];
    const moved = actualClose - s.spot;
    const flatBand = s.spot * 0.003;
    const directionHit =
      s.lean === "alcista" ? moved > 0
        : s.lean === "bajista" ? moved < 0
          : Math.abs(moved) <= flatBand;
    return {
      date: s.date, matured: true, spot: s.spot, base: s.base, bull: s.bull, bear: s.bear,
      lean: s.lean, actualClose,
      baseErrorPct, baseAbsErrorPct: baseErrorPct == null ? null : Math.abs(baseErrorPct),
      directionHit, best,
    };
  });

  evals.sort((a, b) => b.date.localeCompare(a.date));
  const mat = evals.filter((e) => e.matured && e.actualClose != null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const bestCounts = { bear: 0, base: 0, bull: 0 };
  for (const e of mat) if (e.best) bestCounts[e.best] += 1;

  return {
    evals,
    maturedCount: mat.length,
    meanAbsErrorPct: mean(mat.map((e) => e.baseAbsErrorPct!).filter((x) => x != null)),
    biasPct: mean(mat.map((e) => e.baseErrorPct!).filter((x) => x != null)),
    directionHitRate: mat.length ? (mat.filter((e) => e.directionHit).length / mat.length) * 100 : null,
    bestCounts,
  };
}
