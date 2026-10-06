// La posición de day-trading sugerida, en el navegador — mismo motivo que
// lib/watchlistLocal.ts: es una foto del momento (precio de entrada), no algo
// que el servidor deba guardar por el usuario.

import { isSameTradingDay, type DayTradePosition } from "./dayTradePosition";
import { migrateLegacyPrefix } from "./legacyStorage";

const KEY_PREFIX = "visionary.pruebaDeFuego.position.";

/** null si no hay posición guardada, o si es de un día de mercado anterior (day-trading: caduca sola). */
export function loadPosition(ticker: string, now: Date): DayTradePosition | null {
  if (typeof window === "undefined") return null;
  migrateLegacyPrefix("tito.pruebaDeFuego.position.", KEY_PREFIX);
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + ticker);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DayTradePosition;
    if (!isSameTradingDay(parsed, now)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePosition(ticker: string, position: DayTradePosition | null): void {
  if (typeof window === "undefined") return;
  try {
    if (position == null) window.localStorage.removeItem(KEY_PREFIX + ticker);
    else window.localStorage.setItem(KEY_PREFIX + ticker, JSON.stringify(position));
  } catch {
    // cuota llena o modo privado: la posición sigue en memoria esta sesión
  }
}
