// "Me gusta" de Búsqueda de contratos — PURO. Solo identidad del contrato, sin
// sizing ni saldo (mismo motivo que lib/unusualSwingWatchlist.ts). No hay API de
// Robinhood accesible desde el servidor web (el token vive en Claude, no acá) —
// por eso `syncedAt` queda en null hasta que el agente lo agrega por MCP y lo
// marca. El botón de la UI solo encola; el agente drena.

export interface LikedContract {
  symbol: string;
  ticker: string;
  type: "call" | "put";
  strike: number;
  expiration: string;
  likedAt: string;
  /** null = todavía no se agregó a Robinhood. Lo marca el agente, no la UI. */
  syncedAt: string | null;
}

export interface LikeSource {
  symbol: string;
  ticker: string;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
}

export function buildLike(source: LikeSource, now: Date): LikedContract | null {
  if (source.strike == null || source.expiration == null) return null;
  return {
    symbol: source.symbol,
    ticker: source.ticker,
    type: source.type,
    strike: source.strike,
    expiration: source.expiration,
    likedAt: now.toISOString(),
    syncedAt: null,
  };
}

/** Añade por símbolo. Si ya existe, no se pisa (conserva syncedAt si ya se sincronizó). */
export function upsertLike(entries: LikedContract[], entry: LikedContract): LikedContract[] {
  if (entries.some((e) => e.symbol === entry.symbol)) return entries;
  return [entry, ...entries];
}

export function removeLike(entries: LikedContract[], symbol: string): LikedContract[] {
  return entries.filter((e) => e.symbol !== symbol);
}

export function pendingLikes(entries: LikedContract[]): LikedContract[] {
  return entries.filter((e) => !e.syncedAt);
}

export function markLikeSynced(entries: LikedContract[], symbols: string[], now: Date): LikedContract[] {
  const done = new Set(symbols);
  return entries.map((e) => (done.has(e.symbol) && !e.syncedAt ? { ...e, syncedAt: now.toISOString() } : e));
}

/** Las más recientes primero. */
export function sortLikes(entries: LikedContract[]): LikedContract[] {
  return [...entries].sort((a, b) => b.likedAt.localeCompare(a.likedAt));
}

/**
 * Une dos listas por símbolo — necesario porque cada navegador (desktop, celular)
 * tiene su propio localStorage y manda su vista completa por PUT; un simple
 * "reemplazar todo" con la última que llega borra los "me gusta" hechos desde
 * el otro dispositivo. Por símbolo: gana la versión sincronizada si alguna lo
 * está (nunca se pierde que ya se agregó a Robinhood); si ninguna lo está, gana
 * la más reciente por likedAt.
 */
export function mergeLikes(a: LikedContract[], b: LikedContract[]): LikedContract[] {
  const bySymbol = new Map<string, LikedContract>();
  for (const entry of [...a, ...b]) {
    const existing = bySymbol.get(entry.symbol);
    if (!existing) {
      bySymbol.set(entry.symbol, entry);
    } else if (!existing.syncedAt && entry.syncedAt) {
      bySymbol.set(entry.symbol, entry);
    } else if (existing.syncedAt && !entry.syncedAt) {
      // ya sincronizada — se queda como está
    } else if (entry.likedAt > existing.likedAt) {
      bySymbol.set(entry.symbol, entry);
    }
  }
  return sortLikes([...bySymbol.values()]);
}
