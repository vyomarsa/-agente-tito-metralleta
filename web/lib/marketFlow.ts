// ============================================================================
// FLUJO DE MERCADO (varios tickers) — el que alimenta /ideas, el piloto swing y
// el componente put/call del Pulso.
//
// LA DIFERENCIA DE FONDO CON MARKETSNACK: su `flow_feed` devolvía el flujo de TODO
// el mercado en una sola llamada paginada. Tastytrade **no tiene un feed de
// mercado**: hay que suscribir contrato a contrato, así que "todo el mercado" pasa
// a ser un UNIVERSO FIJO — los mismos 102 símbolos de venta de prima (S&P 100 + 3
// ETFs de índice). Lo que opere fuera de esa lista ya no se ve, y por eso se dice
// en la respuesta en vez de dejar que parezca un escaneo del mercado entero.
//
// Y ES CARO: cada ticker cuesta una cadena + el Time & Sales de sus contratos
// (medido el 2026-09-17: SPY ~15 s, NVDA ~19 s). 102 símbolos no caben en una
// petición de pantalla, así que el barrido lo hace una TAREA (scripts/flow-run.mjs)
// y las rutas leen la foto guardada. `sweepMarketFlow` es lo que corre esa tarea.
//
// El barrido, además, alimenta el almacén por ticker (`saveTrades`), que es de donde
// sale el histórico de 30 días de Convicción y el hit-rate de /ideas.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { classifyFlow, type RawTrade } from "./flow";
import { SPREAD_UNIVERSE } from "./spreadUniverse";
import { fetchFlowFromTastytrade } from "./flowSources";
import { fetchQuoteToken, tastytradeConfigured } from "./tastytrade";
import { saveTrades } from "./store";

const FILE = path.join(process.cwd(), "data", "flow", "market.json");

/** Universo del barrido: el mismo que escanea venta de prima. */
export const MARKET_FLOW_UNIVERSE = SPREAD_UNIVERSE.map((s) => s.ticker);

/** Tope de operaciones guardadas, para que la foto no crezca sin control. */
const MAX_TRADES = 20_000;

/** Vencimientos por ticker que se escuchan. Cubre la banda swing (7–120 DTE). */
export const SWEEP_EXPIRATIONS = 8;

export interface MarketFlowSnapshot {
  updatedAt: string;
  /** Ventana en días que se pidió. */
  days: number;
  minPremium: number;
  /** Tickers que se pudieron leer y cuántos fallaron. */
  scanned: number;
  failed: string[];
  universe: number;
  trades: RawTrade[];
}

export async function loadMarketFlow(): Promise<MarketFlowSnapshot | null> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const p = JSON.parse(raw) as MarketFlowSnapshot;
    return Array.isArray(p.trades) ? p : null;
  } catch {
    return null; // todavía no se ha barrido nada
  }
}

/** Edad de la foto en horas. `null` si no hay foto. */
export function snapshotAgeHours(s: MarketFlowSnapshot | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.updatedAt);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
}

export interface SweepOptions {
  tickers?: string[];
  days?: number;
  minPremium?: number;
  /** Cuántos tickers a la vez. Cada uno abre 2 WebSockets al streamer. */
  concurrency?: number;
  onProgress?: (hechos: number, total: number, ticker: string) => void;
}

/**
 * Barre el universo y guarda la foto. Devuelve el resumen.
 *
 * Guarda TAMBIÉN por ticker (`saveTrades`), que es lo que hace que el histórico de
 * 30 días exista: Tastytrade solo sirve ~5 sesiones, así que la profundidad se
 * construye barrido a barrido.
 */
export async function sweepMarketFlow(opts: SweepOptions = {}): Promise<MarketFlowSnapshot> {
  if (!tastytradeConfigured()) throw new Error("Tastytrade no está configurado: no hay con qué barrer.");
  const tickers = opts.tickers ?? MARKET_FLOW_UNIVERSE;
  const days = opts.days ?? 1;
  const minPremium = opts.minPremium ?? 100_000;
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  // Un solo api-quote-token para todo el barrido: vale para muchas conexiones y
  // así no se piden 102 (misma lección que el escaneo de venta de prima).
  const quoteToken = await fetchQuoteToken();

  const trades: RawTrade[] = [];
  const failed: string[] = [];
  let hechos = 0;
  let i = 0;

  async function worker() {
    for (;;) {
      const idx = i++;
      if (idx >= tickers.length) return;
      const t = tickers[idx];
      try {
        const r = await fetchFlowFromTastytrade(t, {
          days, minPremium, expirations: SWEEP_EXPIRATIONS, quoteToken, timeoutMs: 45_000,
        });
        trades.push(...r.trades);
        // El análisis por ticker se persiste para Convicción e historial. Un fallo
        // de disco no puede tumbar el barrido entero.
        if (r.trades.length > 0) {
          const rows = classifyFlow(r.trades, new Date()).interesting;
          if (rows.length > 0) await saveTrades(t, rows).catch(() => null);
        }
      } catch {
        failed.push(t);
      } finally {
        hechos++;
        opts.onProgress?.(hechos, tickers.length, t);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const recortadas = trades
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_TRADES);

  const snap: MarketFlowSnapshot = {
    updatedAt: new Date().toISOString(),
    days,
    minPremium,
    scanned: tickers.length - failed.length,
    failed,
    universe: tickers.length,
    trades: recortadas,
  };
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(snap), "utf8");
  return snap;
}

/**
 * Lo que consumen las rutas: la foto del barrido si está fresca y, si no,
 * MarketSnack en vivo.
 *
 * EL ORDEN ES AL REVÉS QUE EN EL RESTO DE LA APP (donde Tastytrade se pide en
 * vivo y MarketSnack es el respaldo) y tiene su motivo: barrer 102 símbolos son
 * minutos, no una petición de pantalla. Lo "vivo" de Tastytrade aquí es la foto que
 * dejó la tarea; si esa foto es vieja y MarketSnack sigue contratado, una llamada
 * suya es más fresca que un barrido de ayer. Sin ninguna de las dos, se sirve la
 * foto vieja MARCADA como vieja — nunca en silencio.
 */
export async function fetchMarketFlowCascade(opts: {
  days?: number;
  minPremium?: number;
  maxPages?: number;
  period?: string;
  /** Hasta cuántas horas se considera fresca la foto del barrido. */
  maxAgeHours?: number;
} = {}): Promise<{
  trades: RawTrade[];
  source: "tastytrade" | "marketsnack";
  updatedAt: string | null;
  stale: boolean;
  universe: number | null;
}> {
  const minPremium = opts.minPremium ?? 100_000;
  const days = opts.days ?? 1;
  const maxAge = opts.maxAgeHours ?? 24;

  const snap = await loadMarketFlow();
  const edad = snapshotAgeHours(snap);
  // La foto solo sirve si se guardó con un piso de prima igual o MÁS BAJO: con uno
  // más alto faltarían operaciones que el llamador sí quiere ver.
  const sirve = snap != null && snap.minPremium <= minPremium;
  const desde = Date.now() - days * 86_400_000;
  const recorta = (s: MarketFlowSnapshot) =>
    s.trades.filter((t) => t.premium >= minPremium && Date.parse(t.timestamp) >= desde);

  if (snap && sirve && edad != null && edad <= maxAge) {
    return { trades: recorta(snap), source: "tastytrade", updatedAt: snap.updatedAt, stale: false, universe: snap.universe };
  }

  try {
    const { fetchMarketFlow } = await import("./marketsnack");
    const r = await fetchMarketFlow({
      period: opts.period ?? `${days}d`,
      minPremium,
      maxPages: opts.maxPages,
    });
    return { trades: r.trades, source: "marketsnack", updatedAt: null, stale: false, universe: null };
  } catch (e) {
    if (snap && sirve) {
      return { trades: recorta(snap), source: "tastytrade", updatedAt: snap.updatedAt, stale: true, universe: snap.universe };
    }
    throw e;
  }
}
