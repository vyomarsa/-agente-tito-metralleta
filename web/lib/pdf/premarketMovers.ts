// ============================================================================
// Movimientos del S&P 500 en la sesión extendida (pre-market / after-hours).
// Lo usan la alerta de Telegram (scripts/pdf-alerts/premarket-scan.ts) y la
// pestaña "Pre-market" de Prueba de Fuego (/api/pdf/premarket), con el MISMO
// cálculo. Solo servidor.
//
// Fuentes, medidas el 2026-10-07 a las 6:13 ET:
//   · MarketSnack PRIMERO — `/api/assets/{t}` ya trae el % de la sesión
//     extendida y qué sesión es; dio dato de 498/503.
//   · Tastytrade de RESPALDO si no hay cookie o venció — UNA conexión DXLink con
//     Quote + Summary (cierre de ayer). El `Trade` de dxFeed es solo de la sesión
//     regular, así que el precio es el MID de la horquilla, descartando las
//     anchas. A esa hora sus horquillas eran del 3-10%: perdía las 4 movers y el
//     mid de PPG daba −2% cuando MarketSnack daba +13%.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { SP500 } from "./sp500";

export type ExtendedSession = "Pre-market" | "After hours";

export interface ExtendedMove {
  ticker: string;
  name: string;
  /** % contra el cierre regular anterior. */
  pct: number;
  /** Precio de la sesión extendida (si la fuente lo da). */
  price: number | null;
}

export interface ExtendedScan {
  source: "MarketSnack" | "Tastytrade";
  /** Sesión que reporta la fuente (MarketSnack); Tastytrade no la distingue. */
  session: ExtendedSession | null;
  /** Todas las empresas con dato usable, ordenadas por |%| desc. */
  moves: ExtendedMove[];
  /** Empresas sin dato (o descartadas por horquilla ancha en Tastytrade). */
  skipped: number;
  asOf: string;
}

/** Horquilla máxima (% del mid) para fiarse del mid de Tastytrade. */
export const MAX_SPREAD_PCT = 2;

async function loadCookie(): Promise<string | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "marketsnack-cookie.json"), "utf8"));
    if (j && typeof j.cookie === "string" && j.cookie.trim()) return j.cookie.trim();
  } catch {
    // sin archivo: respaldo .env.local
  }
  return process.env.MARKETSNACK_COOKIE?.trim() || null;
}

async function scanMarketSnack(cookie: string, sessions: ExtendedSession[]): Promise<ExtendedScan> {
  let expired = false;
  let skipped = 0;
  const moves: ExtendedMove[] = [];
  const seen = new Map<ExtendedSession, number>();
  let next = 0;
  async function worker() {
    while (next < SP500.length && !expired) {
      const c = SP500[next++];
      try {
        const res = await fetch(`https://app.marketsnack.com/api/assets/${encodeURIComponent(c.ticker)}`, {
          headers: { Accept: "application/json", Cookie: cookie },
          redirect: "manual",
          cache: "no-store",
        });
        if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) { expired = true; return; }
        const j = res.ok
          ? ((await res.json().catch(() => null)) as {
              extended_price_type?: string;
              extended_price?: number;
              extended_price_change?: { percentage?: number };
            } | null)
          : null;
        const type = j?.extended_price_type as ExtendedSession | undefined;
        const pct = j?.extended_price_change?.percentage;
        if (!type || !sessions.includes(type) || typeof pct !== "number" || !Number.isFinite(pct)) { skipped++; continue; }
        seen.set(type, (seen.get(type) ?? 0) + 1);
        moves.push({ ticker: c.ticker, name: c.name, pct, price: typeof j?.extended_price === "number" ? j.extended_price : null });
      } catch {
        skipped++;
      }
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  if (expired) throw new Error("sesión de MarketSnack vencida — actualiza la cookie en Ajustes");
  const session = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { source: "MarketSnack", session, moves, skipped, asOf: new Date().toISOString() };
}

async function scanTastytrade(): Promise<ExtendedScan> {
  const { fetchQuoteToken } = await import("@/lib/tastytrade");
  const { dxlinkUnderlyings } = await import("@/lib/tastytradeStream");
  // El streamer usa "BRK/B" para las clases de acción.
  const byStreamer = new Map(SP500.map((c) => [c.ticker.replace(/[.]/g, "/"), c]));
  const tok = await fetchQuoteToken();
  const snap = await dxlinkUnderlyings({ url: tok.url, token: tok.token, symbols: [...byStreamer.keys()], timeoutMs: 30_000, quietMs: 2_000 });
  let skipped = SP500.length - snap.size;
  const moves: ExtendedMove[] = [];
  for (const [sym, f] of snap) {
    const c = byStreamer.get(sym);
    if (!c || f.bid == null || f.ask == null || !(f.bid > 0) || !(f.ask >= f.bid) || f.prevClose == null) { skipped++; continue; }
    const mid = (f.bid + f.ask) / 2;
    if (((f.ask - f.bid) / mid) * 100 > MAX_SPREAD_PCT) { skipped++; continue; }
    moves.push({ ticker: c.ticker, name: c.name, pct: ((mid - f.prevClose) / f.prevClose) * 100, price: mid });
  }
  return { source: "Tastytrade", session: null, moves, skipped, asOf: new Date().toISOString() };
}

/**
 * Escanea el S&P 500: MarketSnack primero, Tastytrade si no hay cookie, venció o
 * no devolvió nada. `sessions`: qué sesiones extendidas de MarketSnack aceptar (la
 * alerta solo quiere "Pre-market"; la pestaña acepta también "After hours").
 */
export async function scanExtendedMoves(opts: {
  sessions?: ExtendedSession[];
  log?: (line: string) => void;
} = {}): Promise<ExtendedScan> {
  const log = opts.log ?? (() => {});
  const sessions = opts.sessions ?? ["Pre-market"];
  let scan: ExtendedScan | null = null;
  const cookie = await loadCookie();
  if (cookie) {
    log(`Escaneando ${SP500.length} tickers del S&P 500 (MarketSnack)…`);
    scan = await scanMarketSnack(cookie, sessions).catch((err) => {
      log(`MarketSnack no sirvió (${err instanceof Error ? err.message : String(err)}) — paso a Tastytrade.`);
      return null;
    });
  } else {
    log("Sin cookie de MarketSnack — uso Tastytrade.");
  }
  // Solo si MarketSnack FALLÓ: si respondió sin moves es que no hay sesión
  // extendida ahora, y Tastytrade enseñaría el movimiento del día como si lo fuera.
  if (!scan) {
    log(`Escaneando ${SP500.length} tickers del S&P 500 (Tastytrade)…`);
    scan = await scanTastytrade();
  }
  scan.moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  return scan;
}
