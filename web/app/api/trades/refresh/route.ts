// POST /api/trades/refresh — re-cotiza los trades ABIERTOS (pendiente/activa) y avanza sus
// estados con la lógica pura de lib/paperTrade. Fuentes:
//  - precio del SUBYACENTE: Massive fetchQuotes (una llamada para todos).
//  - prima de la OPCIÓN: MarketSnack Option Chain 2.0 (mid) por (ticker, vencimiento).
//
// Sin cookie de MarketSnack no hay prima → no se puede fijar entrada ni P&L: se avisa claro
// (kind:"marketsnack") en vez de inventar precios. NADA de esto mueve dinero real.

import { loadPaperTrades, savePaperTrades } from "@/lib/paperTradeStore";
import { evaluate, isClosed, isOpen, summarize, type PaperTrade } from "@/lib/paperTrade";
import { promises as fs } from "fs";
import path from "path";
import { fetchQuotes } from "@/lib/massive";
import { marketsnackConfigured } from "@/lib/marketsnackCookie";
import { fetchOptionChain2, MarketSnackError } from "@/lib/marketsnack";
import { normalizeChain2 } from "@/lib/optionChain2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONCURRENCY = 4;

const LOG_FILE = path.join(process.cwd(), "data", "trades-refresh.log");
const LOG_MAX_LINES = 500;

/**
 * Bitácora de cada re-cotización, misma convención que `data/prima-run.log`.
 * Sirve para responder "¿cuántas caducaron hoy?" sin tener que diffear el JSON:
 * las transiciones se pierden en cuanto se sobrescribe `paper-trades.json`.
 * Nunca revienta la petición — un fallo de disco no debe tumbar el refresh.
 */
async function log(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    let lines: string[] = [];
    try {
      lines = (await fs.readFile(LOG_FILE, "utf8")).split("\n").filter(Boolean);
    } catch {
      /* primera vez */
    }
    lines.push(`${new Date().toISOString()}  ${line}`);
    if (lines.length > LOG_MAX_LINES) lines = lines.slice(lines.length - LOG_MAX_LINES);
    await fs.writeFile(LOG_FILE, lines.join("\n") + "\n", "utf8");
  } catch {
    /* la bitácora es un extra, no una dependencia */
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** Clave del contrato dentro de una cadena: tipo + strike (tolera flotantes). */
function contractKey(type: string, strike: number): string {
  return `${type}|${strike.toFixed(3)}`;
}

export async function POST() {
  const all = await loadPaperTrades();
  const open = all.filter(isOpen);
  if (open.length === 0) {
    return Response.json({ ok: true, changed: 0, trades: all, summary: summarize(all) });
  }

  if (!(await marketsnackConfigured())) {
    return Response.json(
      {
        ok: false,
        kind: "marketsnack",
        error: "Falta la cookie de MarketSnack (para la prima de la opción). Pégala en ⚙️ Ajustes.",
      },
      { status: 422 },
    );
  }

  // --- Precio del subyacente (una llamada) ---
  const tickers = [...new Set(open.map((t) => t.ticker))];
  const quotes = await fetchQuotes(tickers).catch(() => []);
  const underlyingBy = new Map(quotes.map((q) => [q.ticker, q.price]));

  // --- Prima de la opción: una cadena por (ticker, vencimiento) ---
  const groups = [...new Set(open.map((t) => `${t.ticker}|${t.expiration}`))].map((k) => {
    const [ticker, expiration] = k.split("|");
    return { ticker, expiration };
  });

  const markBy = new Map<string, number>(); // `${ticker}|${exp}|${type}|${strike}` → mid
  const failed: string[] = [];
  await mapLimit(groups, CONCURRENCY, async ({ ticker, expiration }) => {
    try {
      const contracts = normalizeChain2(await fetchOptionChain2(ticker, expiration));
      for (const c of contracts) {
        const mark = c.mid ?? c.lastPrice;
        if (mark != null) {
          markBy.set(`${ticker}|${expiration}|${contractKey(c.type, c.strike)}`, mark);
        }
      }
    } catch (e) {
      failed.push(`${ticker} ${expiration}${e instanceof MarketSnackError ? ` (${e.message})` : ""}`);
    }
  });

  // --- Avanza cada trade abierto con la lógica pura ---
  const now = new Date();
  let changed = 0;
  const revisados = all.filter(isOpen).length;
  const tally = { activadas: 0, caducadas: 0, expiradas: 0, ganadas: 0, perdidas: 0 };
  const caducadasTickers: string[] = [];

  const next: PaperTrade[] = all.map((t) => {
    if (!isOpen(t)) return t;
    const u = underlyingBy.get(t.ticker) ?? null;
    const mark = markBy.get(`${t.ticker}|${t.expiration}|${contractKey(t.optionType, t.strike)}`) ?? null;
    const updated = evaluate(t, u, mark, now);
    if (updated.status !== t.status || updated.updatedAt !== t.updatedAt) changed++;

    if (t.status === "pendiente" && updated.status === "activa") tally.activadas++;
    if (!isClosed(t) && isClosed(updated)) {
      if (updated.closeReason === "caducada") {
        tally.caducadas++;
        caducadasTickers.push(t.ticker);
      } else if (updated.closeReason === "expirada") tally.expiradas++;
      else if (updated.status === "ganada") tally.ganadas++;
      else if (updated.status === "perdida") tally.perdidas++;
    }
    return updated;
  });

  await savePaperTrades(next);

  const detalle = caducadasTickers.length ? ` [${caducadasTickers.join(", ")}]` : "";
  await log(
    `OK      refresh — revisados ${revisados} · activadas ${tally.activadas} · ` +
      `caducadas ${tally.caducadas}${detalle} · ganadas ${tally.ganadas} · ` +
      `perdidas ${tally.perdidas} · expiradas ${tally.expiradas}`,
  );

  return Response.json({
    ok: true,
    changed,
    revisados,
    tally,
    caducadasTickers,
    trades: next,
    summary: summarize(next),
    warnings: failed.length ? { unquoted: failed } : undefined,
  });
}
