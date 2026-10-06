// Registro comparativo de leans (original vs alterna del "próximo tramo").
//   POST {ticker, sec, spot, ol, al, w}  → agrega un snapshot del día.
//   GET  ?ticker=SPX                      → devuelve la evaluación (hit-rate de cada uno).
// La página lo llama una vez por minuto con el mercado abierto. Los datos
// viven en data/alt-eval/<TICKER>-<fecha>.json.

import { promises as fs } from "node:fs";
import path from "node:path";
import { evalSnaps, type AltSnap, type L } from "@/lib/pdf/altEval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIR = path.join(process.cwd(), "data", "pdf", "alt-eval");
const MIN_GAP_SEC = 45;   // no guardar snapshots más seguido que esto (anti-dupe)
const KEEP = 900;         // ~toda una sesión a 1/min
const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fileFor = (t: string) => path.join(DIR, `${t.replace(/[^A-Z0-9]/gi, "")}-${etDate()}.json`);
const isLean = (x: unknown): x is L => x === "alcista" || x === "bajista" || x === "lateral";

async function load(file: string): Promise<AltSnap[]> {
  try { const j = JSON.parse(await fs.readFile(file, "utf8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return Response.json({ error: "json inválido" }, { status: 400 }); }
  const ticker = String(b.ticker ?? "").trim().toUpperCase();
  const sec = Number(b.sec), spot = Number(b.spot), w = Number(b.w);
  if (!ticker || !(sec > 0) || !(spot > 0) || !isLean(b.ol) || !isLean(b.al)) {
    return Response.json({ error: "faltan campos" }, { status: 400 });
  }
  const file = fileFor(ticker);
  const snaps = await load(file);
  const last = snaps[snaps.length - 1];
  if (last && sec - last.sec < MIN_GAP_SEC) return Response.json({ ok: true, skipped: "throttle", n: snaps.length });
  snaps.push({ sec, spot, ol: b.ol, al: b.al, w: Number.isFinite(w) ? w : undefined });
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
  const ticker = new URL(req.url).searchParams.get("ticker")?.trim().toUpperCase() || "SPX";
  const snaps = await load(fileFor(ticker));
  return Response.json({ ticker, samples: snaps.length, ...evalSnaps(snaps) });
}
