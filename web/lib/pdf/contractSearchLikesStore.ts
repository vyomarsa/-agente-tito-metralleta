// Copia en servidor de los "me gusta" de Búsqueda de contratos — solo servidor.
// Mismo motivo que lib/unusualSwingStore.ts: el agente no puede leer el
// localStorage del navegador, así que necesita esta copia para drenarla por MCP
// hacia Robinhood (ver CLAUDE.md — "la sincronización la conduce el agente").

import { promises as fs } from "fs";
import path from "path";
import type { LikedContract } from "./contractSearchLikes";

const FILE = path.join(process.cwd(), "data", "pdf", "contractSearchLikes.json");

export async function loadLikes(): Promise<LikedContract[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as LikedContract[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveLikes(entries: LikedContract[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(entries), "utf8");
}
