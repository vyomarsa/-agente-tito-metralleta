// Persistencia de la BITÁCORA del Playbook del Rango (fase 1).
//
// Un único fichero, `data/scalping/bitacora.json`, con escritura atómica. No es
// un JSONL append-only como los libros de paper porque estas filas SE COMPLETAN:
// se anotan por la mañana y se califican al cierre. Un append-only obligaría a
// releer y colapsar dos líneas por sesión para saber el estado de una, que es
// justo la ambigüedad que el libro de operaciones evita teniendo filas cerradas.
//
// Dos invariantes, y las dos vienen del manual:
//   · Una fila por (ticker, fecha). Los niveles se fijan ANTES de las 9:30 y no
//     se mueven: una segunda anotación el mismo día sería reescribir la hipótesis
//     después de ver el precio, que es la trampa que la fase 1 existe para evitar.
//   · La calificación tampoco se rehace. Si ya está, se queda.
//
// Solo servidor.

import { promises as fs } from "fs";
import path from "path";
import type { Calificacion, Observacion } from "./scalping";

// La ruta se resuelve EN CADA llamada, no al importar. Con una constante de
// módulo, los tests no pueden aislarse en un directorio propio —el store ya
// habría capturado el cwd real— y acabarían leyendo y escribiendo la bitácora
// de verdad del usuario. El coste es un `path.join` por operación.
const dir = () => path.join(process.cwd(), "data", "scalping");
const file = () => path.join(dir(), "bitacora.json");

export function claveDe(ticker: string, fecha: string): string {
  return `${ticker.trim().toUpperCase()}|${fecha}`;
}

export async function cargar(): Promise<Observacion[]> {
  try {
    const raw = await fs.readFile(file(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Observacion[]) : [];
  } catch {
    return [];
  }
}

async function escribir(obs: Observacion[]): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  const destino = file();
  const tmp = `${destino}.tmp`;
  const ordenadas = [...obs].sort(
    (a, b) => a.fecha.localeCompare(b.fecha) || a.ticker.localeCompare(b.ticker),
  );
  await fs.writeFile(tmp, JSON.stringify(ordenadas, null, 2), "utf8");
  await fs.rename(tmp, destino);
}

export interface ResultadoAnotar {
  guardada: boolean;
  /** Por qué no se guardó, si no se guardó. */
  nota: string;
  observacion: Observacion;
}

/**
 * Anota la sesión de un ticker. Si ya había una fila para ese (ticker, fecha) la
 * respeta y devuelve la existente: los niveles del día se fijan UNA vez.
 *
 * **La única excepción: una fila FUERA DE VENTANA cede el sitio a una en ventana.**
 * Sin esto, mirar el semáforo a las 6 de la mañana ocupaba el hueco del día con una
 * fila que no cuenta, y a las 8:00 la tarea ya no podía anotar la buena — o sea que
 * la curiosidad de un momento costaba una de las diez sesiones de la muestra. No es
 * reescribir una hipótesis viendo el precio: es sustituir una que nunca fue válida
 * por la que el manual pide. Al revés nunca ocurre, y una fila ya CALIFICADA tampoco
 * se toca.
 */
export async function anotar(nueva: Observacion): Promise<ResultadoAnotar> {
  const todas = await cargar();
  const clave = claveDe(nueva.ticker, nueva.fecha);
  const i = todas.findIndex((o) => claveDe(o.ticker, o.fecha) === clave);
  const ya = i >= 0 ? todas[i] : null;

  if (ya) {
    const mejora = ya.fueraVentana && !nueva.fueraVentana && ya.cierre == null;
    if (!mejora) {
      return {
        guardada: false,
        nota: `${nueva.ticker} ya estaba anotado el ${nueva.fecha}. Los niveles del día no se reescriben.`,
        observacion: ya,
      };
    }
    todas[i] = nueva;
    await escribir(todas);
    return {
      guardada: true,
      nota: `${nueva.ticker}: se sustituyó la anotación fuera de ventana por la de la apertura.`,
      observacion: nueva,
    };
  }

  todas.push(nueva);
  await escribir(todas);
  return { guardada: true, nota: "", observacion: nueva };
}

/** Sesiones anotadas que aún no tienen veredicto de cierre. */
export async function pendientes(hoy: string): Promise<Observacion[]> {
  const todas = await cargar();
  // La de HOY se excluye: no se califica una sesión que sigue abierta.
  return todas.filter((o) => o.cierre == null && o.fecha < hoy);
}

/** Escribe el veredicto del cierre. No sobrescribe uno ya existente. */
export async function calificarEnDisco(
  ticker: string,
  fecha: string,
  cierre: Calificacion,
): Promise<boolean> {
  const todas = await cargar();
  const clave = claveDe(ticker, fecha);
  const fila = todas.find((o) => claveDe(o.ticker, o.fecha) === clave);
  if (!fila || fila.cierre != null) return false;
  fila.cierre = cierre;
  await escribir(todas);
  return true;
}

/**
 * Borra una fila. Existe SOLO para deshacer una anotación de un ticker que no
 * tocaba (un dedazo en el selector); no para limpiar días que salieron mal, que
 * es exactamente lo que arruinaría la medición.
 */
export async function borrar(ticker: string, fecha: string): Promise<boolean> {
  const todas = await cargar();
  const clave = claveDe(ticker, fecha);
  const quedan = todas.filter((o) => claveDe(o.ticker, o.fecha) !== clave);
  if (quedan.length === todas.length) return false;
  await escribir(quedan);
  return true;
}
