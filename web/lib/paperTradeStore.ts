// Persistencia de la bitácora de paper trades. Solo servidor. Vive en
// data/paper-trades.json (gitignored vía /data). Escritura ATÓMICA (tmp + rename) para no
// corromper el archivo si dos peticiones coinciden.
//
// OJO: NO confundir con lib/store.ts (loadTrades/saveTrades), que guarda el HISTÓRICO de
// cadenas de opciones en data/trades/*.json. Esto es la bitácora de simulación, aparte.

import { promises as fs } from "fs";
import path from "path";
import type { PaperTrade } from "./paperTrade";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "paper-trades.json");

interface Stored {
  updatedAt: string;
  trades: PaperTrade[];
}

export async function loadPaperTrades(): Promise<PaperTrade[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Stored;
    return Array.isArray(parsed.trades) ? parsed.trades : [];
  } catch {
    return []; // aún no hay bitácora
  }
}

export async function savePaperTrades(trades: PaperTrade[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload: Stored = { updatedAt: new Date().toISOString(), trades };
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, FILE); // rename atómico en el mismo volumen
}

/** Inserta un trade nuevo al frente (el más reciente arriba). */
export async function addPaperTrade(t: PaperTrade): Promise<PaperTrade[]> {
  const trades = await loadPaperTrades();
  trades.unshift(t);
  await savePaperTrades(trades);
  return trades;
}

/** Aplica un cambio a un trade por id. Devuelve la lista nueva (sin cambios si no existe). */
export async function updatePaperTrade(
  id: string,
  patch: (t: PaperTrade) => PaperTrade,
): Promise<PaperTrade[]> {
  const trades = await loadPaperTrades();
  const next = trades.map((t) => (t.id === id ? patch(t) : t));
  await savePaperTrades(next);
  return next;
}

export async function removePaperTrade(id: string): Promise<PaperTrade[]> {
  const trades = await loadPaperTrades();
  const next = trades.filter((t) => t.id !== id);
  await savePaperTrades(next);
  return next;
}
