// ============================================================================
// Fuente NATIVA de futuros (Tastytrade). /ES y /NQ se analizan sobre sus PROPIAS
// opciones de futuro (CME), NO vía el índice SPX/NDX + basis.
//
// El streamer `streamer/tastytrade-futures-stream.mjs` escribe
// `data/tastytrade-fut/{ES,NQ}-<fecha>.json` en formato FlowAccumulator (mismos
// buckets con agresor + OI + griegos + volumen + quotes) más `spot` (precio del
// futuro) y `exp` (vencimiento 0DTE). Aquí se lee y se convierte en la cadena
// (Row[]) que consume el pipeline 0DTE, con spot = futuro y basis = 0.
//
// Rollback: NATIVE_FUTURES=0 → el agente vuelve a analizar /ES vía SPX y /NQ vía
// NDX con el basis (la ruta antigua queda intacta).
//
// Solo servidor (usa fs).
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import type { Row } from "./types";
import type { AggBucket, FlowAccumulator } from "./zerodteFlow";

const FUT_DIR = path.join(process.cwd(), "data", "pdf", "tastytrade-fut");

/** Futuros soportados y su código de archivo. /ES → ES, /NQ → NQ. */
export const FUT_CODE: Record<string, string> = { "/ES": "ES", "/NQ": "NQ" };

/**
 * ¿La migración a futuros nativos está activa? Default ON.
 * NATIVE_FUTURES=0 en `.env.local` revierte a SPX/NDX + basis.
 */
export const NATIVE_FUTURES = (process.env.NATIVE_FUTURES ?? "1") !== "0";

/**
 * Antigüedad máxima (ms) del archivo del streamer para considerarlo VIVO. El
 * streamer escribe cada ~10 s; si el archivo tiene más de esto, Tastytrade se
 * considera caído y el agente cae a la fuente ALTERNA (Schwab, vía el índice).
 * Default 3 min.
 */
export const NATIVE_FUT_STALE_MS = Number(process.env.NATIVE_FUT_STALE_MS ?? 180_000);

/** ¿El archivo nativo está fresco (el streamer está vivo)? */
export function nativeFresh(nf: NativeFlow | null, now: number = Date.now()): boolean {
  if (!nf || nf.spot == null) return false;
  const ts = Date.parse(nf.acc?.updatedAt ?? "");
  return Number.isFinite(ts) && now - ts < NATIVE_FUT_STALE_MS;
}

/** ¿Este ticker debe analizarse como futuro nativo? */
export function isNativeFuture(ticker: string): boolean {
  return NATIVE_FUTURES && FUT_CODE[ticker.trim().toUpperCase()] != null;
}

/** Clave de persistencia (calibración/eval/flow) del futuro nativo: /ES → ES. */
export function futureStoreKey(future: string): string {
  return FUT_CODE[future.trim().toUpperCase()] ?? future.replace(/[^A-Z0-9]/gi, "");
}

export interface NativeFlow {
  acc: FlowAccumulator;
  /** Precio vivo del futuro (spot del análisis). null si el archivo no lo trae aún. */
  spot: number | null;
  /** Vencimiento 0DTE que está streameando. null si no consta. */
  exp: string | null;
  /** ms del trade/foto más reciente en la cadena (frescura). */
  newestTs: number;
}

/** Lee el archivo nativo del futuro para la fecha ET dada. null si no existe o es de otro día. */
export async function loadNativeFuture(future: string, date: string): Promise<NativeFlow | null> {
  const code = FUT_CODE[future.trim().toUpperCase()];
  if (!code) return null;
  try {
    const raw = await fs.readFile(path.join(FUT_DIR, `${code}-${date}.json`), "utf8");
    const j = JSON.parse(raw) as FlowAccumulator & { spot?: number | null; exp?: string | null };
    if (j.date !== date || typeof j.buckets !== "object") return null;
    let newestTs = 0;
    for (const b of Object.values(j.buckets)) if (b && b.ts > newestTs) newestTs = b.ts;
    return {
      acc: j,
      spot: typeof j.spot === "number" && j.spot > 0 ? j.spot : null,
      exp: j.exp ?? null,
      newestTs,
    };
  } catch {
    return null;
  }
}

/**
 * Construye la cadena (Row[]) desde los buckets nativos. Cada strike aporta su
 * OI, griegos (gamma/delta/iv), volumen y quotes reales — todo lo que el GEX, la
 * IV-ATM, los muros y el pronóstico necesitan. PURA.
 */
export function rowsFromBuckets(
  buckets: Record<string, AggBucket>,
  expiration: string,
  future: string,
): Row[] {
  const rows: Row[] = [];
  for (const b of Object.values(buckets)) {
    if (!b || !(b.strike > 0)) continue;
    const bid = b.bidPrice ?? null;
    const ask = b.askPrice ?? null;
    const price = bid != null && ask != null ? (bid + ask) / 2 : ask ?? bid ?? null;
    rows.push({
      optionTicker: `${future}-${expiration}-${b.strike}-${b.type[0].toUpperCase()}`,
      contractType: b.type,
      expiration,
      strike: b.strike,
      openInterest: b.oi ?? 0,
      volume: b.volume ?? 0,
      price,
      priceSource: price != null ? "bid" : "none",
      openPremium: null,
      notionalValue: 0,
      bid,
      ask,
      greeks: { delta: b.delta ?? null, gamma: b.gamma ?? null, theta: null, vega: null, rho: null, iv: b.iv ?? null },
      // agresor neto del día = compras (ask) − ventas (bid) agresivas
      intradayNet: (Number(b.ask) || 0) - (Number(b.bid) || 0),
    });
  }
  return rows;
}
