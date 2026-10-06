// Registro CRUDO del contexto que ve `momentumEntry` cada minuto (mercado abierto),
// para poder rejugarlo después con distintos parámetros — ver momentumCalibration.ts.
// A diferencia de trade-log/alt-log (que guardan la señal YA calculada con los
// parámetros que estaban activos ese día), acá se guarda el INSUMO crudo: así un
// cambio de MOMENTUM_DEFAULTS no invalida el histórico ya acumulado.
//   POST {ticker, sec, spot, regime, cvd, cvdDom, velocity, burstBull, burstBear,
//         netGex, magnet, sigma, flip, callWall, putWall} → agrega un snapshot.
//   GET  ?ticker=SPX[&days=30]  → corre el barrido de calibración sobre todas las
//        sesiones guardadas de ese ticker (o las últimas `days`) y devuelve el
//        ranking + cómo le fue a MOMENTUM_DEFAULTS para comparar.
// Datos en data/odte-standalone/momentum-raw/<TICKER>-<fecha>.json (uno por sesión).

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  calibrateMomentum,
  evaluateParams,
  MIN_SAMPLES_FOR_TRUST,
  type MomentumRawSnap,
} from "@/lib/pdf/odteStandalone/momentumCalibration";
import { MOMENTUM_DEFAULTS, MOMENTUM_PERSISTENCE_REQUIRED } from "@/lib/pdf/odteStandalone/zerodteAlt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIR = path.join(process.cwd(), "data", "pdf", "odte-standalone", "momentum-raw");
const MIN_GAP_SEC = 45;  // anti-dupe, mismo patrón que trade-log/alt-log
const KEEP = 900;        // ~toda una sesión a 1/min
const DEFAULT_DAYS = 60; // sesiones más recientes a incluir en la calibración

const etDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function safeTicker(t: string): string {
  return t.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function fileFor(ticker: string, date: string): string {
  return path.join(DIR, `${safeTicker(ticker)}-${date}.json`);
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Valida y normaliza un snapshot crudo (o null si faltan los campos mínimos). */
function toSnap(b: Record<string, unknown>): MomentumRawSnap | null {
  const sec = Number(b.sec), spot = Number(b.spot);
  const regime = b.regime === "negative" ? "negative" : b.regime === "positive" ? "positive" : null;
  if (!(sec > 0) || !(spot > 0) || !regime) return null;
  return {
    sec, spot, regime,
    cvd: num(b.cvd), cvdDom: num(b.cvdDom), velocity: num(b.velocity),
    burstBull: num(b.burstBull) ?? 0, burstBear: num(b.burstBear) ?? 0,
    netGex: num(b.netGex), magnet: num(b.magnet), sigma: num(b.sigma),
    flip: num(b.flip), callWall: num(b.callWall), putWall: num(b.putWall),
  };
}

async function load(file: string): Promise<MomentumRawSnap[]> {
  try { const j = JSON.parse(await fs.readFile(file, "utf8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return Response.json({ error: "json inválido" }, { status: 400 }); }
  const ticker = String(b.ticker ?? "").trim();
  const snap = ticker ? toSnap(b) : null;
  if (!ticker || !snap) return Response.json({ error: "faltan campos" }, { status: 400 });

  const file = fileFor(ticker, etDate());
  const snaps = await load(file);
  const last = snaps[snaps.length - 1];
  if (last && snap.sec - last.sec < MIN_GAP_SEC) return Response.json({ ok: true, skipped: "throttle", n: snaps.length });
  snaps.push(snap);
  if (snaps.length > KEEP) snaps.splice(0, snaps.length - KEEP);
  try {
    await fs.mkdir(DIR, { recursive: true });
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(snaps));
    await fs.rename(tmp, file);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
  return Response.json({ ok: true, n: snaps.length });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ticker = safeTicker(url.searchParams.get("ticker")?.trim() || "SPX");
  const days = Math.max(1, Math.min(180, Number(url.searchParams.get("days")) || DEFAULT_DAYS));

  let files: string[];
  try { files = await fs.readdir(DIR); } catch { files = []; }
  const prefix = `${ticker}-`;
  const dayFiles = files
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort() // los nombres empiezan con la fecha YYYY-MM-DD → orden cronológico
    .slice(-days);

  const sessions: MomentumRawSnap[][] = [];
  for (const f of dayFiles) {
    const snaps = await load(path.join(DIR, f));
    if (snaps.length > 0) sessions.push(snaps);
  }

  const negativeMinutes = sessions.reduce(
    (s, day) => s + day.filter((x) => x.regime === "negative").length,
    0,
  );
  const defaultsPerf = evaluateParams(sessions, MOMENTUM_DEFAULTS);
  // Comparación "como estaba" (sin persistencia, comportamiento previo) vs. "con
  // persistencia" (confirmMomentum, MOMENTUM_PERSISTENCE_REQUIRED lecturas
  // seguidas antes de contar la señal) sobre el MISMO histórico real — misma
  // idea que experiment-persistence.ts de Contratos Vecinos 3.0. Con pocas
  // sesiones γ− esto no alcanza para concluir nada (ver `note`), pero queda
  // listo para leerlo en cuanto se acumulen más días reales de gamma negativa.
  const defaultsPerfPersisted = evaluateParams(sessions, MOMENTUM_DEFAULTS, MOMENTUM_PERSISTENCE_REQUIRED);
  const { trusted, all } = calibrateMomentum(sessions);

  return Response.json({
    ticker,
    sessions: sessions.length,
    sessionDates: dayFiles.map((f) => f.slice(prefix.length, -".json".length)),
    negativeMinutes,
    minSamplesForTrust: MIN_SAMPLES_FOR_TRUST,
    defaultsPerf,
    persistenceRequired: MOMENTUM_PERSISTENCE_REQUIRED,
    defaultsPerfPersisted,
    trusted: trusted.slice(0, 10),
    topByVolume: all.slice(0, 10),
    ready: trusted.length > 0,
    note: trusted.length > 0
      ? "Hay suficientes trades γ− resueltos para confiar en el ranking."
      : `Todavía no hay ${MIN_SAMPLES_FOR_TRUST} trades γ− resueltos con ningún set de parámetros — hacen falta más sesiones de gamma negativa reales antes de calibrar en serio.`,
  });
}
