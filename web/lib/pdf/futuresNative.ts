// ============================================================================
// Fuente NATIVA de futuros (Tastytrade). /ES y /NQ se analizan sobre sus
// PROPIAS opciones de futuro (CME) — porte fiel del motor del proyecto
// standalone Agente 0DTE, NO la infraestructura de Contratos vecinos 2.0
// (lib/futuresChain.ts, que es un motor REST distinto para otra pestaña).
//
// El streamer `streamer/tastytrade-futures-stream.mjs` escribe
// `data/tastytrade-fut/{ES,NQ}-<fecha>.json` en formato FlowAccumulator
// (mismos buckets con agresor + OI + griegos + volumen + quotes) más `spot`
// (precio del futuro) y `exp` (vencimiento diario). Acá se lee y se convierte
// en la cadena (ZRow[]) que consume el pipeline 0DTE.
//
// Solo servidor (usa fs).
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { bucketsToRows, type FlowAccumulator } from "./zerodteFlow";

const FUT_DIR = path.join(process.cwd(), "data", "pdf", "tastytrade-fut");

/** Futuros soportados. */
export const NATIVE_FUTURE_CODES = new Set(["ES", "NQ"]);

/** ¿Este ticker debe analizarse como futuro nativo? */
export function isNativeFuture(ticker: string): boolean {
  return NATIVE_FUTURE_CODES.has(ticker.trim().toUpperCase());
}

/**
 * Antigüedad máxima (ms) del archivo del streamer para considerarlo VIVO. El
 * streamer escribe cada ~10s; si el archivo tiene más de esto, se considera
 * caído. Sin fuente alterna a propósito (pedido explícito: no
 * reusar lib/futuresChain.ts como respaldo) — si el streamer está caído, el
 * panel degrada suave (cadena vacía) en vez de aproximar con otro motor.
 */
export const NATIVE_FUT_STALE_MS = 180_000;

export interface NativeFlow {
  acc: FlowAccumulator;
  /** Precio vivo del futuro. null si el archivo no lo trae aún. */
  spot: number | null;
  /** Vencimiento diario que está streameando. null si no consta. */
  exp: string | null;
  /** ms del trade/foto más reciente en la cadena (frescura). */
  newestTs: number;
}

/** ¿El archivo nativo está fresco (el streamer está vivo)? */
export function nativeFresh(nf: NativeFlow | null, now: number = Date.now()): boolean {
  if (!nf || nf.spot == null) return false;
  const ts = Date.parse(nf.acc?.updatedAt ?? "");
  return Number.isFinite(ts) && now - ts < NATIVE_FUT_STALE_MS;
}

/** Lee el archivo nativo del futuro para la fecha ET dada. null si no existe o es de otro día. */
export async function loadNativeFuture(future: string, date: string): Promise<NativeFlow | null> {
  const code = future.trim().toUpperCase();
  if (!NATIVE_FUTURE_CODES.has(code)) return null;
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

/** Construye la cadena (ZRow[]) desde los buckets nativos del futuro. PURA. */
export const rowsFromBuckets = bucketsToRows;
