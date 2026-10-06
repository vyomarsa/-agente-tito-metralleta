// Favoritos de "Búsqueda de contratos" en el navegador — mismo motivo que
// lib/unusualSwingWatchlistLocal.ts: se queda en el navegador, sin
// servidor de por medio (nadie más necesita leer esta lista).

import { sortEntries, type ContractSearchFavoriteEntry } from "./contractSearchFavorites";
import { migrateLegacyKey } from "./legacyStorage";

const KEY = "visionary.contractSearch.favorites";
const KEY_RESET_V2 = "visionary.contractSearch.favorites.resetV2";

export function loadEntries(): ContractSearchFavoriteEntry[] {
  if (typeof window === "undefined") return [];
  migrateLegacyKey("tito.contractSearch.favorites", KEY);
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ContractSearchFavoriteEntry[];
    return Array.isArray(parsed) ? sortEntries(parsed) : [];
  } catch {
    return []; // JSON corrupto: preferimos vacío a romper la página
  }
}

export function saveEntries(entries: ContractSearchFavoriteEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // cuota llena o modo privado: la lista sigue en memoria esta sesión
  }
}

/**
 * ¿Ya se limpiaron los favoritos de la versión vieja (día-trading 0-5 DTE,
 * un solo target, gexReference/neighborReference)? El criterio y la forma de
 * la entrada cambiaron de raíz (ago 2026, escáner S&P 500 con 2 targets) —
 * los favoritos viejos ya no calzan con el tipo nuevo, así que se limpian
 * UNA sola vez. Mismo patrón que KEY_MIGRATED en lib/watchlistLocal.ts.
 */
export function hasResetV2(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(KEY_RESET_V2) === "1";
}

export function markResetV2(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_RESET_V2, "1");
  } catch {
    // si no se puede marcar, se reintenta la próxima carga — clearEntries es idempotente
  }
}

export function clearEntries(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ver saveEntries
  }
}
