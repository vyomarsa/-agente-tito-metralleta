// ============================================================================
// Ventana de observación de VENTA DE PRIMA (10:30–11:30 ET).
//
// El plan del dueño siempre fue "mirar candidatos de 10:30 a 11:30 y disparar a
// las 11:45", pero la implementación se saltaba la primera mitad: el disparo de
// las 11:45 escaneaba y abría en un solo golpe. Esto añade las pasadas previas.
//
// Para qué sirve de verdad, más allá de poder mirar:
//   1. **Caza los fallos una hora antes.** Si la cookie de MarketSnack caducó, se
//      ve a las 10:30 y da tiempo a renovarla — en vez de descubrirlo a las 11:45
//      con la ventana semanal ya perdida, que es lo que pasó el 2026-08-17.
//   2. **Mide la PERSISTENCIA.** Un spread que aparece en las cinco pasadas es
//      otra cosa que uno que asoma en una sola: el segundo puede ser un tick de
//      cotización rancia. Cada posición abierta guarda en cuántas pasadas se
//      había visto, para poder contestar con datos si conviene exigirlo.
//
// La persistencia SÍ FILTRA desde el 2026-08-24: el dueño pidió exigir al menos
// 3 pasadas, y que SIN ventana no se abra nada. Ver `MIN_SEEN_IN_PASSES` y
// `requiredSeen`, donde está el matiz entre "la ventana corrió a medias" (se
// relaja) y "la ventana no corrió" (no se abre).
//
// Tests de la parte pura en `primaWatchStore.test.ts`.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import type { SpreadCandidate } from "./creditSpread";
import { marketDateStr } from "./occ";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "prima-watch.json");

/**
 * Pasadas mínimas en que hay que ver un spread para poder abrirlo.
 *
 * Con 5 pasadas (10:30, 10:45, 11:00, 11:15, 11:30), exigir 3 significa que el
 * candidato aguantó al menos media hora de la ventana. Filtra lo que asoma en un
 * solo escaneo, que suele ser una cotización rancia y no una oportunidad.
 */
export const MIN_SEEN_IN_PASSES = 3;

/**
 * Cuántas pasadas exigir DE VERDAD, dado cuántas hubo.
 *
 * Dos casos, y la diferencia entre ellos es deliberada:
 *
 * · **La ventana corrió a medias** (1-2 pasadas de 5): el umbral se topa a lo que
 *   se pudo observar. Nadie puede salir en 3 pasadas si solo hubo 2, y bloquear
 *   ahí sería castigar al spread por un problema del PC. Hay evidencia parcial y
 *   se usa.
 * · **La ventana NO corrió** (0 pasadas): NO se relaja nada — se mantiene la
 *   exigencia completa, que con cero observaciones es imposible de cumplir, así
 *   que no abre nada. Decisión del dueño (2026-08-24): sin ventana, sin
 *   operación. No hay evidencia ninguna, y abrir a ciegas es justo lo que la
 *   ventana viene a evitar.
 */
export function requiredSeen(passes: number): number {
  if (passes <= 0) return MIN_SEEN_IN_PASSES; // sin evidencia, nada la satisface
  return Math.min(MIN_SEEN_IN_PASSES, passes);
}

/** ¿La ventana de observación no llegó a correr? Entonces no se abre nada. */
export function noWindow(book: WatchBook): boolean {
  return book.passes.length === 0;
}

export interface WatchPass {
  at: string;             // ISO
  scanned: number;
  failed: number;
  /** Claves de los candidatos vistos en esta pasada. */
  keys: string[];
}

export interface WatchBook {
  date: string;           // fecha de mercado (ET)
  passes: WatchPass[];
}

/**
 * Identidad de un spread concreto. Incluye los DOS strikes y el vencimiento: el
 * mismo ticker con otro ancho es otra operación, y contarlos juntos inflaría la
 * persistencia.
 */
export function candidateKey(c: Pick<SpreadCandidate, "ticker" | "type" | "expiration"> & {
  shortLeg: { strike: number };
  longLeg: { strike: number };
}): string {
  return `${c.ticker}:${c.type}:${c.shortLeg.strike}/${c.longLeg.strike}:${c.expiration}`;
}

export function emptyBook(now: Date): WatchBook {
  return { date: marketDateStr(now), passes: [] };
}

/** En cuántas pasadas del día apareció esa clave. PURA. */
export function seenIn(book: WatchBook, key: string): number {
  return book.passes.filter((p) => p.keys.includes(key)).length;
}

/** Claves ordenadas por persistencia (más vistas primero). PURA. */
export function persistence(book: WatchBook): { key: string; seen: number }[] {
  const cuenta = new Map<string, number>();
  for (const p of book.passes) {
    for (const k of p.keys) cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  return [...cuenta.entries()]
    .map(([key, seen]) => ({ key, seen }))
    .sort((a, b) => b.seen - a.seen || a.key.localeCompare(b.key));
}

/**
 * Aplica la compuerta de persistencia a los candidatos del disparo. PURA.
 *
 * Se usa ANTES de rankear por POP, no después: filtrar al final dejaría huecos
 * —elegiría los 5 mejores, descartaría 3 por persistencia y abriría 2— en vez de
 * coger los 5 mejores DE ENTRE los que pasan el filtro.
 */
export function filterByPersistence<T extends Parameters<typeof candidateKey>[0]>(
  candidates: T[],
  book: WatchBook,
): { passing: T[]; dropped: number; required: number; seen: Map<string, number> } {
  const required = requiredSeen(book.passes.length);
  const seen = new Map<string, number>();
  for (const c of candidates) {
    const k = candidateKey(c);
    if (!seen.has(k)) seen.set(k, seenIn(book, k));
  }
  // Sin pasadas, `required` vale el máximo y ningún candidato lo cumple: la
  // ventana ausente bloquea la apertura por sí sola, sin caso especial.
  const passing = candidates.filter((c) => (seen.get(candidateKey(c)) ?? 0) >= required);
  return { passing, dropped: candidates.length - passing.length, required, seen };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Carga el libro del día. Si el guardado es de otra fecha, arranca uno nuevo. */
export async function loadWatch(now: Date = new Date()): Promise<WatchBook> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as WatchBook;
    if (parsed?.date !== marketDateStr(now) || !Array.isArray(parsed.passes)) return emptyBook(now);
    return parsed;
  } catch {
    return emptyBook(now);
  }
}

/** Apila una pasada. Escritura atómica (tmp + rename). */
export async function addPass(pass: WatchPass, now: Date = new Date()): Promise<WatchBook> {
  const book = await loadWatch(now);
  book.passes.push(pass);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(book, null, 2), "utf8");
  await fs.rename(tmp, FILE);
  return book;
}
