// Cache de vida corta para la CADENA de opciones. Solo servidor.
//
// Bajar la cadena de Tastytrade no es una petición: es un REST grande
// (`/option-chains/nested`, hasta 2.500 contratos en SPX) más un snapshot por
// WebSocket que espera a que los contratos tickeen. Medido el 2026-08-26, tras
// sacar a Massive del camino, ESTE pasó a ser el término dominante de la Tarjeta
// de Decisión: 4–14 s, y es el mismo trabajo que repiten `/api/chain` y
// `/api/tarjeta` cuando el dueño mira un ticker en las dos pantallas.
//
// EN MEMORIA, no en disco, al revés que `barsStore`/`companyStore`. Dos razones:
// el TTL se mide en segundos (el disco no aporta nada que sobreviva a eso) y la
// foto de SPX pesa ~1,5 MB, que no compensa serializar cada 45 s. Todo lo que la
// consume vive en el proceso de Next; las tareas programadas piden ventanas de DTE
// distintas y no compartirían entrada igualmente.
//
// El estado cuelga de globalThis porque Next recarga módulos en dev (HMR) y si no
// cada recarga estrenaría cache. Mismo motivo que en `massiveLimiter`.

import { etMinutes, OPEN_MIN, CLOSE_MIN } from "./zerodteScan";

/**
 * Dentro de la sesión regular la cadena se mueve: 45 s es el tope de desfase que
 * se acepta para greeks y horquillas con los que NO se manda una orden (la Tarjeta
 * y el panel de Ticker son lectura; quien opera de verdad —spreads, 0DTE— pide su
 * propia ventana de DTE y no pasa por aquí).
 */
export const TTL_SESION_MS = 45_000;

/**
 * Fuera de sesión la cadena está congelada: los greeks son los del cierre y no
 * cambian hasta la apertura. Y es justo cuando el snapshot cuesta MÁS, porque sin
 * ticks no dispara el cierre por silencio y agota su tope duro de 9 s.
 */
export const TTL_CERRADO_MS = 10 * 60_000;

/**
 * Cuántas cadenas se guardan a la vez. La watchlist son 12 tickers; 16 deja margen
 * para pasear sin que la memoria crezca sin freno (SPX ~1,5 MB por entrada).
 */
export const MAX_ENTRADAS = 16;

/** TTL que toca según la hora de mercado (ET). */
export function chainTtlMs(now: Date): number {
  const min = etMinutes(now);
  if (min == null) return TTL_SESION_MS; // sin hora fiable, el TTL corto es el prudente
  return min >= OPEN_MIN && min < CLOSE_MIN ? TTL_SESION_MS : TTL_CERRADO_MS;
}

interface Entrada {
  /**
   * epoch ms en que se PIDIÓ la cadena, no en que llegó.
   *
   * Es lo correcto además de lo simple: la foto es del momento en que el snapshot
   * suscribe, no del momento en que se cierra. Y deja un solo reloj gobernando el
   * TTL — sellar al resolver obligaba a mezclar `Date.now()` con el `now` que
   * entra por parámetro, que es exactamente la clase de desfase que este módulo
   * existe para evitar.
   */
  at: number;
  promise: Promise<unknown>;
}

const g = globalThis as typeof globalThis & { __chainCache?: Map<string, Entrada> };
const cache: Map<string, Entrada> = (g.__chainCache ??= new Map());

/** Clave de cache. El nº de vencimientos cambia el contenido, así que entra. */
export function chainKey(ticker: string, expirations: number): string {
  return `${ticker.trim().toUpperCase()}|${expirations}`;
}

function podar(nowMs: number, ttlMs: number): void {
  for (const [k, e] of cache) {
    if (nowMs - e.at >= ttlMs) cache.delete(k);
  }
  // Si aun así sobran, cae la más antigua. Puede tocarle a una que siga en vuelo:
  // no rompe nada — quien la esté esperando ya tiene la promesa en la mano; solo
  // se pierde la plaza en el cache.
  while (cache.size > MAX_ENTRADAS) {
    let viejaK: string | null = null;
    let viejaAt = Infinity;
    for (const [k, e] of cache) {
      if (e.at < viejaAt) { viejaAt = e.at; viejaK = k; }
    }
    if (!viejaK) break;
    cache.delete(viejaK);
  }
}

/**
 * Sirve del cache si la foto sigue fresca; si no, llama a `fetcher` y la guarda.
 *
 * Dos llamadas a la vez sobre la misma clave comparten UNA sola bajada
 * (single-flight): sin esto, abrir el panel de Ticker y la Tarjeta del mismo
 * símbolo levantaba dos WebSockets en paralelo para pedir lo mismo.
 *
 * Si `fetcher` falla, la entrada se borra: el siguiente lo reintenta, y nunca se
 * sirve una cadena vieja haciéndola pasar por buena.
 */
export async function withChainCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  const nowMs = now.getTime();
  const ttl = chainTtlMs(now);

  // Una entrada fresca se devuelve tal cual, esté resuelta o todavía en vuelo:
  // de ahí sale el single-flight, sin bandera aparte.
  const previa = cache.get(key);
  if (previa && nowMs - previa.at < ttl) return previa.promise as Promise<T>;

  const entrada: Entrada = { at: nowMs, promise: Promise.resolve() };
  entrada.promise = (async () => {
    try {
      return await fetcher();
    } catch (err) {
      // Nada de servir una cadena vieja como si fuera buena. Se compara la
      // identidad porque para cuando esto falla puede haber entrado ya un
      // reintento: borrar por clave a ciegas se llevaría por delante el bueno.
      if (cache.get(key) === entrada) cache.delete(key);
      throw err;
    }
  })();
  cache.set(key, entrada);
  podar(nowMs, ttl);
  return entrada.promise as Promise<T>;
}

/** Vacía el cache. Para los tests y para un "refrescar" explícito. */
export function clearChainCache(): void {
  cache.clear();
}

/** Cuántas entradas hay guardadas ahora mismo (diagnóstico/tests). */
export function chainCacheSize(): number {
  return cache.size;
}
