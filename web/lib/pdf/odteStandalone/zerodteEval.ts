// ============================================================================
// Auto-evaluación del Agente 0DTE — mide si los escenarios aciertan.
//
// El pronóstico afirma cosas (base 7450, alcista 7470, X% de tocarlo). Sin
// medirlo contra lo que el precio hizo de verdad, es una impresión. Esto guarda
// UNA foto por día de mercado —la primera del día, la que tiene toda la sesión
// por delante— y, tras el cierre, la contrasta con las barras intradía reales:
// qué targets se tocaron, cuánto erró el base, y si el sesgo es sistemático.
//
// A diferencia de predictionStore (horizonte de días), aquí el horizonte es la
// misma sesión: una foto "madura" al cierre de su propio día. La lógica de
// revisión es PURA (tests en zerodteEval.test.ts). Solo servidor (fs).
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";
import type { ScenarioKind } from "./zerodte";

const DATA_DIR = path.join(process.cwd(), "data", "pdf", "odte-standalone", "eval");

/** Fotos a conservar por ticker. */
export const JOURNAL_DAYS = 120;

export interface ForecastSnapshot {
  date: string; // fecha de mercado (ET), YYYY-MM-DD
  savedAt: string;
  /** Segundos unix de la captura: el "desde" de la ventana de evaluación. */
  capturedAtSec: number;
  spot: number;
  bear: number;
  base: number;
  bull: number;
  /** Imán del GEX ese momento, para ver si ancló el precio. */
  kingStrike: number | null;
  /** Strike de cierre pronosticado (3-4pm); la última estimación del día. */
  closingStrike?: number | null;
}

/** Tolerancia en puntos para contar el pronóstico de cierre como acierto. */
export const CLOSING_HIT_TOLERANCE = 5;

export interface ForecastJournal {
  ticker: string;
  updatedAt: string;
  snapshots: ForecastSnapshot[]; // más reciente primero
  /** Sesgo histórico medido (para el lazo de auto-corrección). Se refresca en
   *  cada revisión. */
  calibration?: { biasPct: number | null; samples: number };
}

/** Barra intradía. time en segundos unix. */
export interface EvalBar {
  time: number;
  high: number;
  low: number;
  close: number;
}

export interface ForecastEval {
  date: string;
  matured: boolean; // la sesión ya cerró
  bars: number;     // barras de la ventana consideradas
  spot: number;
  bear: number;
  base: number;
  bull: number;
  kingStrike: number | null;
  actualClose: number | null;
  actualHigh: number | null;
  actualLow: number | null;
  /** Firmado: (cierre − base) / spot × 100. >0 = el precio quedó por encima del base. */
  baseErrorPct: number | null;
  baseAbsErrorPct: number | null;
  bearTouched: boolean;
  baseTouched: boolean;
  bullTouched: boolean;
  /** El target más cercano al cierre real. */
  best: ScenarioKind | null;
  /** Strike de cierre pronosticado (3-4pm), o null si no hubo. */
  closingStrike: number | null;
  /** Error del pronóstico de cierre en puntos: |cierre real − strike previsto|. */
  closingErrorPts: number | null;
}

export interface ForecastReview {
  evals: ForecastEval[]; // más reciente primero
  maturedCount: number;
  meanAbsErrorPct: number | null;
  /** Error medio FIRMADO del base: >0 = subestima (el precio cierra por encima). */
  biasPct: number | null;
  bullTouchRate: number | null;
  bearTouchRate: number | null;
  baseTouchRate: number | null;
  bestCounts: { bear: number; base: number; bull: number };
  /** Error medio en PUNTOS del pronóstico de cierre (solo días que lo tuvieron). */
  closingMeanAbsErrorPts: number | null;
  /** % de días en que el cierre real cayó a ≤ CLOSING_HIT_TOLERANCE del strike previsto. */
  closingHitRate: number | null;
  /** Días madurados que tuvieron pronóstico de cierre. */
  closingCount: number;
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

/**
 * El último strike de cierre guardado (el más reciente con `closingStrike`).
 * Sirve para "fijar" el pronóstico de cierre tras las 4pm y mantenerlo hasta la
 * próxima sesión. Los snapshots vienen ordenados del más reciente al más viejo.
 */
export async function loadLatestClosing(
  ticker: string,
): Promise<{ strike: number; date: string } | null> {
  const j = await loadEvalJournal(ticker);
  if (!j) return null;
  const snap = j.snapshots.find((s) => s.closingStrike != null);
  return snap ? { strike: snap.closingStrike!, date: snap.date } : null;
}

/**
 * Guarda el sesgo histórico medido en el journal (para la auto-corrección).
 * Se llama tras cada revisión; el pronóstico lo lee la próxima carga.
 */
export async function saveCalibration(
  ticker: string,
  biasPct: number | null,
  samples: number,
): Promise<void> {
  const clean = ticker.trim().toUpperCase();
  const existing = (await loadEvalJournal(clean)) ?? {
    ticker: clean, updatedAt: new Date().toISOString(), snapshots: [],
  };
  const payload: ForecastJournal = { ...existing, calibration: { biasPct, samples } };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(clean), JSON.stringify(payload), "utf8");
}

/** Lee el sesgo histórico guardado. Devuelve {biasPct:null, samples:0} si no hay. */
export async function loadCalibration(
  ticker: string,
): Promise<{ biasPct: number | null; samples: number }> {
  const j = await loadEvalJournal(ticker);
  return j?.calibration ?? { biasPct: null, samples: 0 };
}

export async function loadEvalJournal(ticker: string): Promise<ForecastJournal | null> {
  try {
    const raw = await fs.readFile(fileFor(ticker), "utf8");
    const parsed = JSON.parse(raw) as ForecastJournal;
    return Array.isArray(parsed.snapshots) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Guarda la foto del día. Se conserva la **primera** de cada día de mercado: es
 * la que tiene la sesión entera por delante para ponerse a prueba. Las llamadas
 * posteriores del mismo día no la reemplazan.
 */
export async function saveForecast(
  ticker: string,
  snap: Omit<ForecastSnapshot, "date" | "savedAt" | "capturedAtSec">,
  now: Date = new Date(),
): Promise<ForecastJournal> {
  const clean = ticker.trim().toUpperCase();
  const date = marketDateStr(now);
  const existing = await loadEvalJournal(clean);

  // Ya hay foto de hoy: no se toca (la primera manda).
  if (existing?.snapshots.some((s) => s.date === date)) return existing;

  const snapshot: ForecastSnapshot = {
    ...snap,
    date,
    savedAt: now.toISOString(),
    capturedAtSec: Math.floor(now.getTime() / 1000),
  };
  const snapshots = [snapshot, ...(existing?.snapshots ?? [])]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, JOURNAL_DAYS);

  const payload: ForecastJournal = { ticker: clean, updatedAt: now.toISOString(), snapshots };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(clean), JSON.stringify(payload), "utf8");
  return payload;
}

/**
 * Registra el strike de cierre pronosticado del día. A diferencia de la foto
 * diaria (la primera manda), aquí gana la **última** del día: el pronóstico de
 * cierre se afina de 3 a 4pm, y la lectura más reciente es la más convergida.
 * Actualiza la foto del día si existe; si no, crea una mínima.
 */
export async function saveClosingPrediction(
  ticker: string,
  strike: number,
  now: Date = new Date(),
): Promise<ForecastJournal> {
  const clean = ticker.trim().toUpperCase();
  const date = marketDateStr(now);
  const existing = await loadEvalJournal(clean);
  const snapshots = [...(existing?.snapshots ?? [])];

  const idx = snapshots.findIndex((s) => s.date === date);
  if (idx >= 0) {
    snapshots[idx] = { ...snapshots[idx], closingStrike: strike };
  } else {
    snapshots.unshift({
      date, savedAt: now.toISOString(), capturedAtSec: Math.floor(now.getTime() / 1000),
      spot: 0, bear: 0, base: 0, bull: 0, kingStrike: null, closingStrike: strike,
    });
  }
  const trimmed = snapshots.sort((a, b) => b.date.localeCompare(a.date)).slice(0, JOURNAL_DAYS);
  const payload: ForecastJournal = { ticker: clean, updatedAt: now.toISOString(), snapshots: trimmed };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(clean), JSON.stringify(payload), "utf8");
  return payload;
}

/** Cierre del mercado (16:00 ET) de una fecha, en segundos unix. */
export function closeSecFor(date: string): number {
  // 16:00 ET. En verano (EDT) son las 20:00 UTC; el desfase EST/EDT lo resuelve
  // el propio Date restando el offset de Nueva York para ese instante.
  const utcGuess = Date.parse(`${date}T20:00:00Z`);
  // Ajuste fino EST (invierno, 21:00 UTC): si el offset real difiere, se corrige.
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", hour12: false,
    }).format(utcGuess).replace("24", "0"),
  );
  // Si a las 20:00 UTC en ET no son las 16:00, corrige por la diferencia horaria.
  return Math.floor(utcGuess / 1000) + (16 - etHour) * 3600;
}

/** ¿El precio alcanzó el target dentro de la ventana? */
function touched(target: number, spot: number, high: number, low: number): boolean {
  return target >= spot ? high >= target : low <= target;
}

/**
 * Revisa cada foto contra las barras intradía reales. PURA.
 *
 * Ventana de evaluación: barras del mismo día, desde la captura hasta el cierre.
 * Una foto "madura" cuando la sesión de su día ya cerró.
 */
export function reviewForecasts(
  snapshots: ForecastSnapshot[],
  bars: EvalBar[],
  now: Date = new Date(),
): ForecastReview {
  const nowSec = Math.floor(now.getTime() / 1000);
  const evals: ForecastEval[] = [];

  for (const s of snapshots) {
    const closeSec = closeSecFor(s.date);
    const matured = nowSec >= closeSec;
    const window = bars.filter((b) => b.time >= s.capturedAtSec && b.time <= closeSec);

    const closingStrike = s.closingStrike ?? null;

    if (window.length === 0) {
      evals.push({
        date: s.date, matured, bars: 0,
        spot: s.spot, bear: s.bear, base: s.base, bull: s.bull, kingStrike: s.kingStrike,
        actualClose: null, actualHigh: null, actualLow: null,
        baseErrorPct: null, baseAbsErrorPct: null,
        bearTouched: false, baseTouched: false, bullTouched: false, best: null,
        closingStrike, closingErrorPts: null,
      });
      continue;
    }

    const actualClose = window[window.length - 1].close;
    const actualHigh = Math.max(...window.map((b) => b.high));
    const actualLow = Math.min(...window.map((b) => b.low));
    const baseErrorPct = s.spot > 0 ? ((actualClose - s.base) / s.spot) * 100 : null;

    const targets: [ScenarioKind, number][] = [["bear", s.bear], ["base", s.base], ["bull", s.bull]];
    const best = targets
      .slice()
      .sort((a, b) => Math.abs(a[1] - actualClose) - Math.abs(b[1] - actualClose))[0][0];

    evals.push({
      date: s.date, matured, bars: window.length,
      spot: s.spot, bear: s.bear, base: s.base, bull: s.bull, kingStrike: s.kingStrike,
      actualClose, actualHigh, actualLow,
      baseErrorPct, baseAbsErrorPct: baseErrorPct == null ? null : Math.abs(baseErrorPct),
      bearTouched: touched(s.bear, s.spot, actualHigh, actualLow),
      baseTouched: touched(s.base, s.spot, actualHigh, actualLow),
      bullTouched: touched(s.bull, s.spot, actualHigh, actualLow),
      best,
      closingStrike,
      closingErrorPts: closingStrike != null ? Math.abs(actualClose - closingStrike) : null,
    });
  }

  evals.sort((a, b) => b.date.localeCompare(a.date));

  const mat = evals.filter((e) => e.matured && e.actualClose != null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const rate = (pred: (e: ForecastEval) => boolean) =>
    mat.length ? (mat.filter(pred).length / mat.length) * 100 : null;

  const bestCounts = { bear: 0, base: 0, bull: 0 };
  for (const e of mat) if (e.best) bestCounts[e.best] += 1;

  // Pronóstico de cierre: solo días madurados que lo tuvieron.
  const closingMat = mat.filter((e) => e.closingErrorPts != null);
  const closingMeanAbsErrorPts = mean(closingMat.map((e) => e.closingErrorPts!));
  const closingHitRate = closingMat.length
    ? (closingMat.filter((e) => e.closingErrorPts! <= CLOSING_HIT_TOLERANCE).length / closingMat.length) * 100
    : null;

  return {
    evals,
    maturedCount: mat.length,
    meanAbsErrorPct: mean(mat.map((e) => e.baseAbsErrorPct!).filter((x) => x != null)),
    biasPct: mean(mat.map((e) => e.baseErrorPct!).filter((x) => x != null)),
    bullTouchRate: rate((e) => e.bullTouched),
    bearTouchRate: rate((e) => e.bearTouched),
    baseTouchRate: rate((e) => e.baseTouched),
    bestCounts,
    closingMeanAbsErrorPts,
    closingHitRate,
    closingCount: closingMat.length,
  };
}
