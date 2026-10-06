// Rebrand a Visionary Trades (ago 2026): los prefijos de localStorage pasan
// de "tito.*" a "visionary.*". Sin esto, el navegador perdería en
// silencio todo lo que tenía guardado bajo el prefijo viejo (perfil de
// riesgo, watchlist, favoritos, posición del día, etc.) — así que la primera
// vez que se lee una key nueva y no existe, se copia desde la vieja y se
// borra la vieja. Idempotente: no hace nada si la key nueva ya existe.

export function migrateLegacyKey(oldKey: string, newKey: string): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(newKey) != null) return;
    const legacy = window.localStorage.getItem(oldKey);
    if (legacy != null) {
      window.localStorage.setItem(newKey, legacy);
      window.localStorage.removeItem(oldKey);
    }
  } catch {
    // cuota llena o modo privado: seguimos sin migrar, no rompemos la carga
  }
}

/** Igual que migrateLegacyKey pero para claves con sufijo variable (ej. "…position.SPX"). */
export function migrateLegacyPrefix(oldPrefix: string, newPrefix: string): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(oldPrefix)) keys.push(k);
    }
    for (const oldKey of keys) {
      migrateLegacyKey(oldKey, newPrefix + oldKey.slice(oldPrefix.length));
    }
  } catch {
    // ver migrateLegacyKey
  }
}
