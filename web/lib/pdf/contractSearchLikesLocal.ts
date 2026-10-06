// "Me gusta" de Búsqueda de contratos en el navegador — mismo motivo que
// lib/unusualSwingWatchlistLocal.ts: fuente de verdad para la UI, respuesta inmediata.

import { sortLikes, type LikedContract } from "./contractSearchLikes";
import { migrateLegacyKey } from "./legacyStorage";

const KEY = "visionary.contractSearch.likes";

export function loadLikes(): LikedContract[] {
  if (typeof window === "undefined") return [];
  migrateLegacyKey("tito.contractSearch.likes", KEY);
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LikedContract[];
    return Array.isArray(parsed) ? sortLikes(parsed) : [];
  } catch {
    return []; // JSON corrupto: preferimos vacío a romper la página
  }
}

export function saveLikes(entries: LikedContract[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // cuota llena o modo privado: la lista sigue en memoria esta sesión
  }
}
