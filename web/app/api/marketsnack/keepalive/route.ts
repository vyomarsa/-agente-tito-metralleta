// GET /api/marketsnack/keepalive → estado del keep-alive (Fase 2): últimas líneas de
// data/keepalive.log, cuándo corrió por última vez y con qué resultado. Solo lectura;
// la escritura la hace el worker scripts/keepalive-marketsnack.mjs (tarea programada).

import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

const LOG_FILE = path.join(process.cwd(), "data", "keepalive.log");
const TAIL = 15;

export interface KeepAliveStatus {
  /** ¿existe el log? (si no, la tarea nunca ha corrido). */
  everRan: boolean;
  /** epoch ms de la última ejecución (del timestamp ISO de la última línea). */
  lastRunAt: number | null;
  /** etiqueta del último resultado: OK / EXPIRED / ERROR / WARN / SKIP. */
  lastOutcome: string | null;
  /** últimas líneas de la bitácora, más recientes al final. */
  lines: string[];
}

export async function GET() {
  let raw: string;
  try {
    raw = await fs.readFile(LOG_FILE, "utf8");
  } catch {
    const empty: KeepAliveStatus = {
      everRan: false,
      lastRunAt: null,
      lastOutcome: null,
      lines: [],
    };
    return Response.json(empty);
  }

  const all = raw.split("\n").filter((l) => l.trim());
  const lines = all.slice(-TAIL);
  const last = all[all.length - 1] ?? "";
  // Formato de línea: "<ISO>  <OUTCOME> <resto>"
  const m = last.match(/^(\S+)\s+(\S+)/);
  const lastRunAt = m ? Date.parse(m[1]) || null : null;
  const lastOutcome = m ? m[2] : null;

  const status: KeepAliveStatus = {
    everRan: true,
    lastRunAt,
    lastOutcome,
    lines,
  };
  return Response.json(status);
}
