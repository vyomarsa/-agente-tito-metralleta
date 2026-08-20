// Almacén del análisis diario del master. Solo servidor. Vive bajo data/ (gitignored).
//
// Un archivo por día (data/master/YYYY-MM-DD.json) con las entradas ingeridas desde
// Telegram, más las imágenes en data/master/img/. Guardar por día permite comparar
// "qué dijo ayer vs. hoy" (el master se auto-referencia: "como dije ayer").

import { promises as fs } from "fs";
import path from "path";
import type { Bias } from "./masterRoster";

const DIR = path.join(process.cwd(), "data", "master");
const IMG_DIR = path.join(DIR, "img");

export interface MasterEntry {
  /** id estable = message_id de Telegram (permite deduplicar reenvíos repetidos). */
  id: number;
  /** ticker del roster, o null si es el mensaje de noticias generales. */
  ticker: string | null;
  kind: "ticker" | "news";
  text: string;
  levels: number[];
  bias: Bias;
  /** nombre del archivo de imagen en data/master/img (sin ruta), si trae chart. */
  image: string | null;
  receivedAt: number; // epoch ms
}

export interface MasterDay {
  date: string; // YYYY-MM-DD
  updatedAt: number;
  entries: MasterEntry[];
}

/** Fecha de mercado (ET) en formato YYYY-MM-DD para nombrar el archivo del día. */
export function todayKey(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // en-CA → YYYY-MM-DD
}

function dayFile(date: string): string {
  return path.join(DIR, `${date}.json`);
}

export async function loadDay(date: string): Promise<MasterDay | null> {
  try {
    const raw = await fs.readFile(dayFile(date), "utf8");
    return JSON.parse(raw) as MasterDay;
  } catch {
    return null;
  }
}

/**
 * Mezcla entradas nuevas en el día indicado, deduplicando por id (message_id). Si un
 * mismo ticker llega dos veces, la ÚLTIMA gana (el master corrige a lo largo de la
 * mañana). Devuelve el día resultante y cuántas entradas se añadieron/actualizaron.
 */
export async function mergeEntries(
  date: string,
  incoming: MasterEntry[],
): Promise<{ day: MasterDay; changed: number }> {
  const existing = (await loadDay(date)) ?? { date, updatedAt: Date.now(), entries: [] };
  const byId = new Map(existing.entries.map((e) => [e.id, e]));
  let changed = 0;
  for (const e of incoming) {
    byId.set(e.id, e);
    changed++;
  }
  const day: MasterDay = {
    date,
    updatedAt: Date.now(),
    entries: [...byId.values()].sort((a, b) => a.receivedAt - b.receivedAt),
  };
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(dayFile(date), JSON.stringify(day, null, 2), "utf8");
  return { day, changed };
}

/** Guarda los bytes de una imagen y devuelve su nombre de archivo (id.jpg). */
export async function saveImage(id: number, bytes: Buffer): Promise<string> {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const name = `${id}.jpg`;
  await fs.writeFile(path.join(IMG_DIR, name), bytes);
  return name;
}

/** Lee una imagen guardada (para servirla por la ruta de proxy). null si no existe. */
export async function readImage(name: string): Promise<Buffer | null> {
  const safe = path.basename(name); // evita traversal
  try {
    return await fs.readFile(path.join(IMG_DIR, safe));
  } catch {
    return null;
  }
}
