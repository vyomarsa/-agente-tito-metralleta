// Favoritos de "Búsqueda de contratos" — PURO. Mismo patrón que
// lib/unusualSwingWatchlist.ts: el escaneo agrega candidatos nuevos solo
// (el usuario los revisa y decide), "👎 No me gusta" los saca, "📌 Mantener" los
// blinda de una futura limpieza automática. La foto (targets/convicción al
// momento de detectarlo) nunca se pisa, aunque un rescaneo la vuelva a traer.

import type { ContradictionFlag } from "./news";

export interface ContractSearchFavoriteEntry {
  symbol: string;
  ticker: string;
  companyName: string | null;
  type: "call" | "put";
  strike: number;
  expiration: string;
  dte: number | null;
  addedAt: string;
  assetPrice: number;
  premium: number;
  size: number;
  volume: number;
  openInterest: number;
  target1: number | null;
  convictionPct1: number | null;
  changePctToTarget1: number | null;
  estUsdGain1: number | null;
  target2: number | null;
  convictionPct2: number | null;
  changePctToTarget2: number | null;
  estUsdGain2: number | null;
  pinned: boolean;
  /** Best-effort — null si el chequeo de noticias falló o no había dirección clara. */
  newsFlag: ContradictionFlag | null;
}

/** Lo mínimo que necesita `buildEntry` — evita acoplar este módulo al SSE completo. */
export interface EntrySource {
  symbol: string;
  ticker: string;
  companyName: string | null;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  assetPrice: number;
  premium: number;
  size: number;
  volume: number;
  openInterest: number;
  target1: number | null;
  convictionPct1: number | null;
  changePctToTarget1: number | null;
  estUsdGain1: number | null;
  target2: number | null;
  convictionPct2: number | null;
  changePctToTarget2: number | null;
  estUsdGain2: number | null;
  newsFlag?: ContradictionFlag | null;
}

export function buildEntry(source: EntrySource, now: Date): ContractSearchFavoriteEntry | null {
  if (source.strike == null || source.expiration == null) return null;
  return {
    symbol: source.symbol,
    ticker: source.ticker,
    companyName: source.companyName,
    type: source.type,
    strike: source.strike,
    expiration: source.expiration,
    dte: source.dte,
    addedAt: now.toISOString(),
    assetPrice: source.assetPrice,
    premium: source.premium,
    size: source.size,
    volume: source.volume,
    openInterest: source.openInterest,
    target1: source.target1,
    convictionPct1: source.convictionPct1,
    changePctToTarget1: source.changePctToTarget1,
    estUsdGain1: source.estUsdGain1,
    target2: source.target2,
    convictionPct2: source.convictionPct2,
    changePctToTarget2: source.changePctToTarget2,
    estUsdGain2: source.estUsdGain2,
    pinned: false,
    newsFlag: source.newsFlag ?? null,
  };
}

/** Añade por símbolo. Si ya existe, se deja la foto original — no se pisa. */
export function upsert(
  entries: ContractSearchFavoriteEntry[],
  entry: ContractSearchFavoriteEntry,
): ContractSearchFavoriteEntry[] {
  if (entries.some((e) => e.symbol === entry.symbol)) return entries;
  return [entry, ...entries];
}

export function remove(entries: ContractSearchFavoriteEntry[], symbol: string): ContractSearchFavoriteEntry[] {
  return entries.filter((e) => e.symbol !== symbol);
}

/** Prende/apaga el blindaje de limpieza automática para un contrato ya guardado. */
export function togglePinned(entries: ContractSearchFavoriteEntry[], symbol: string): ContractSearchFavoriteEntry[] {
  return entries.map((e) => (e.symbol === symbol ? { ...e, pinned: !e.pinned } : e));
}

/** Las más recientes primero. */
export function sortEntries(entries: ContractSearchFavoriteEntry[]): ContractSearchFavoriteEntry[] {
  return [...entries].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/**
 * Saca los favoritos ya VENCIDOS (expiration < hoy). Un contrato que vence
 * HOY se conserva hasta que pase el día de mercado — solo lo que ya quedó
 * atrás se saca. Los 📌 Mantenidos quedan blindados a propósito.
 * `todayStr` en el mismo formato YYYY-MM-DD que `expiration` (ver
 * lib/occ.ts `marketDateStr`).
 */
export function pruneExpired(
  entries: ContractSearchFavoriteEntry[],
  todayStr: string,
): ContractSearchFavoriteEntry[] {
  return entries.filter((e) => e.pinned || e.expiration >= todayStr);
}
