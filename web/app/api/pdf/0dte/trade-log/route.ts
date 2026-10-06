// Registro comparativo de TRADES (Mejor trade ahora vs Trade alterno).
//   POST {ticker, sec, spot, o, a}  → agrega un snapshot del minuto.
//   GET  ?ticker=SPX                → devuelve la evaluación (win-rate de cada uno).
// o/a = {d:"long"|"short", tgt, stop, m?} o null (sin setup ese minuto). La
// página lo llama 1/min con el mercado abierto. Datos en
// data/trade-eval/<TICKER>-<fecha>.json.

import { promises as fs } from "node:fs";
import path from "node:path";
import { evalTrades, type TradeSig, type TradeSnap } from "@/lib/pdf/tradeEval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIR = path.join(process.cwd(), "data", "pdf", "trade-eval");
const MIN_GAP_SEC = 45;   // anti-dupe
const KEEP = 900;         // ~toda una sesión a 1/min
const etDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fileFor = (t: string) => path.join(DIR, `${t.replace(/[^A-Z0-9]/gi, "")}-${etDate()}.json`);

/** Valida y normaliza una señal (o null si no es un setup válido). */
function toSig(x: unknown): TradeSig | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const d = o.d, tgt = Number(o.tgt), stop = Number(o.stop);
  if ((d !== "long" && d !== "short") || !(tgt > 0) || !(stop > 0)) return null;
  return { d, tgt, stop, m: o.m === true };
}

async function load(file: string): Promise<TradeSnap[]> {
  try { const j = JSON.parse(await fs.readFile(file, "utf8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return Response.json({ error: "json inválido" }, { status: 400 }); }
  const ticker = String(b.ticker ?? "").trim().toUpperCase();
  const sec = Number(b.sec), spot = Number(b.spot);
  if (!ticker || !(sec > 0) || !(spot > 0)) return Response.json({ error: "faltan campos" }, { status: 400 });

  const file = fileFor(ticker);
  const snaps = await load(file);
  const last = snaps[snaps.length - 1];
  if (last && sec - last.sec < MIN_GAP_SEC) return Response.json({ ok: true, skipped: "throttle", n: snaps.length });
  snaps.push({ sec, spot, o: toSig(b.o), a: toSig(b.a) });
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
  return Response.json({ ticker, samples: snaps.length, ...evalTrades(snaps) });
}
