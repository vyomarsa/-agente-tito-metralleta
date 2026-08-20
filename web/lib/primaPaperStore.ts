// Persistencia del paper trading de VENTA DE PRIMA. Solo servidor.
//
//   data/prima-positions.json  → las ABIERTAS (se reescribe entero, atómico)
//   data/prima-closed.jsonl    → el LIBRO de cerradas (APPEND-ONLY, nunca se reescribe)
//
// Por qué el libro es append-only y no un JSON más: de él se DERIVA el capital de la
// cuenta ($10.000 + suma del libro). Si se reescribiera entero, un fallo a media
// escritura podría llevarse el histórico y con él la única medida real del agente.
// Añadir una línea es una operación mucho más difícil de romper.
//
// OJO: NO confundir con paperTradeStore.ts (bitácora de opciones sueltas del piloto)
// ni con store.ts (histórico de cadenas). Son tres cosas distintas.

import { promises as fs } from "fs";
import path from "path";
import type { PrimaPosition } from "./primaPaper";

const DATA_DIR = path.join(process.cwd(), "data");
const OPEN_FILE = path.join(DATA_DIR, "prima-positions.json");
const LEDGER_FILE = path.join(DATA_DIR, "prima-closed.jsonl");

interface StoredOpen {
  updatedAt: string;
  positions: PrimaPosition[];
}

export async function loadOpen(): Promise<PrimaPosition[]> {
  try {
    const raw = await fs.readFile(OPEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredOpen;
    return Array.isArray(parsed.positions) ? parsed.positions : [];
  } catch {
    return []; // aún no se ha abierto nada: no es un error
  }
}

export async function saveOpen(positions: PrimaPosition[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload: StoredOpen = { updatedAt: new Date().toISOString(), positions };
  const tmp = `${OPEN_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, OPEN_FILE); // atómico en el mismo volumen
}

/** Lee el libro de cerradas, en el orden en que se cerraron. */
export async function loadClosed(): Promise<PrimaPosition[]> {
  let raw: string;
  try {
    raw = await fs.readFile(LEDGER_FILE, "utf8");
  } catch {
    return [];
  }
  const out: PrimaPosition[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as PrimaPosition);
    } catch {
      // una línea corrupta no invalida el resto del libro
    }
  }
  return out;
}

/** Añade una operación cerrada al libro. Append: nunca reescribe lo anterior. */
export async function appendClosed(p: PrimaPosition): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(LEDGER_FILE, JSON.stringify(p) + "\n", "utf8");
}

/** Sustituye la lista de abiertas y manda las cerradas al libro, en ese orden. */
export async function commit(open: PrimaPosition[], closed: PrimaPosition[]): Promise<void> {
  // El libro PRIMERO: si el proceso muere entre las dos escrituras, es preferible
  // una operación duplicada en el libro (visible y corregible) a una que se cerró
  // y desapareció sin dejar registro del resultado.
  for (const c of closed) await appendClosed(c);
  await saveOpen(open);
}
