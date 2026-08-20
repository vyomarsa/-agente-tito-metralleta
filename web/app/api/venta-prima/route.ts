// GET /api/venta-prima — cuenta simulada del bot Venta Prima, para la pestaña
// homónima de "Mis Trades".
//
// SOLO LECTURA. El dueño de estos datos es el bot Python de `Desktop/Venta Prima`,
// que corre aparte y escribe `state/closed-trades.jsonl` (append-only) y
// `state/positions.json`. Tito no ejecuta esa estrategia: la enseña.
//
// La ruta del bot se puede fijar con VENTA_PRIMA_DIR en .env.local; por defecto se
// busca como hermana del repo de Tito, que es como está instalado.

import { promises as fs } from "fs";
import path from "path";
import { parseVpLedger, summarizeVp, START_EQUITY } from "@/lib/ventaPrimaLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Carpeta del bot. `process.cwd()` es `agente-tito-metralleta/web`. */
function botDir(): string {
  const fromEnv = process.env.VENTA_PRIMA_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // web → agente-tito-metralleta → VyoBot → Desktop → Desktop/Venta Prima
  return path.resolve(process.cwd(), "..", "..", "..", "Venta Prima");
}

interface OpenPosition {
  underlying?: string;
  spread_type?: string;
  short_strike?: number;
  long_strike?: number;
  contracts?: number;
  entry_credit?: number;
  current_value?: number;
  expiration?: string;
}

export async function GET() {
  const dir = botDir();
  const ledgerPath = path.join(dir, "state", "closed-trades.jsonl");
  const positionsPath = path.join(dir, "state", "positions.json");

  // Que el bot no haya cerrado nada todavía NO es un error: es el estado normal
  // antes del primer ciclo. Se distingue de "no encuentro el bot", que sí lo es.
  let botFound = true;
  try {
    await fs.access(dir);
  } catch {
    botFound = false;
  }

  const text = await fs.readFile(ledgerPath, "utf8").catch(() => "");
  const trades = parseVpLedger(text);
  const summary = summarizeVp(trades, START_EQUITY);

  let open: OpenPosition[] = [];
  try {
    const raw = await fs.readFile(positionsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) open = parsed as OpenPosition[];
  } catch {
    open = []; // sin posiciones abiertas todavía
  }

  // No realizado de lo abierto: (crédito de entrada − coste de cerrar) × 100 × ctr.
  const unrealized = Math.round(
    open.reduce((s, p) => {
      const entry = Number(p.entry_credit ?? 0);
      const now = Number(p.current_value ?? 0);
      const ctr = Number(p.contracts ?? 0);
      return s + (entry - now) * 100 * ctr;
    }, 0) * 100,
  ) / 100;

  return Response.json({
    ok: true,
    botFound,
    botDir: dir,
    summary,
    trades: trades.slice(-60).reverse(), // lo más reciente primero
    open: open.map((p) => ({
      underlying: p.underlying ?? "?",
      spreadType: p.spread_type ?? "",
      shortStrike: p.short_strike ?? null,
      longStrike: p.long_strike ?? null,
      contracts: p.contracts ?? 0,
      entryCredit: p.entry_credit ?? 0,
      currentValue: p.current_value ?? 0,
      expiration: p.expiration ?? "",
    })),
    unrealized,
  });
}
