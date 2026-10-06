// "Grandes empresas" (Prueba de Fuego, ago 2026, pedido explícito):
// universo curado — las Magnificent Seven (AAPL, MSFT, GOOGL, AMZN, NVDA,
// META, TSLA) + PLTR, IREN, NFLX, SPCX, INTC, ORCL, HOOD. Reusa el motor de
// "Contratos vecinos 3.0" (lib/contratosVecinos3.ts) tal cual — solo cambia
// de dónde sale la cadena de opciones (Massive, vencimiento más cercano
// disponible, no 0DTE fijo de índice — ver lib/massive.ts `fetchNearTermChain`).

import { daysToExpiration, marketDateStr } from "./occ";

export interface GrandesEmpresaTicker {
  id: string;
  label: string;
}

export const GRANDES_EMPRESAS: GrandesEmpresaTicker[] = [
  { id: "AAPL", label: "AAPL" },
  { id: "MSFT", label: "MSFT" },
  { id: "GOOGL", label: "GOOGL" },
  { id: "AMZN", label: "AMZN" },
  { id: "NVDA", label: "NVDA" },
  { id: "META", label: "META" },
  { id: "TSLA", label: "TSLA" },
  { id: "PLTR", label: "PLTR" },
  { id: "IREN", label: "IREN" },
  { id: "NFLX", label: "NFLX" },
  { id: "SPCX", label: "SPCX" },
  { id: "INTC", label: "INTC" },
  { id: "ORCL", label: "ORCL" },
  { id: "HOOD", label: "HOOD" },
];

export const GRANDES_EMPRESAS_TICKERS = new Set(GRANDES_EMPRESAS.map((t) => t.id));
export const DEFAULT_GRANDES_EMPRESA = "AAPL";

/**
 * Ventana de vencimiento que se pide a Massive (`fetchNearTermChain`). 21
 * días de margen: la mayoría de esta lista tiene opciones semanales (el
 * próximo vencimiento cae dentro de 7 días), pero no todas tienen diarias —
 * de menos margen se corre el riesgo de no encontrar NINGÚN vencimiento para
 * un ticker de solo mensuales.
 */
export const NEAR_TERM_DTE_MAX = 21;

/**
 * Vencimientos para el motor de Contratos 3.0 en Grandes empresas —
 * **corregido 2026-08-27** (pedido explícito, reemplaza la regla
 * de "combinar todos los vencimientos hasta el viernes" del 2026-08-20): UN
 * SOLO vencimiento objetivo por día, nunca combinado con otros. Varias de
 * esta lista cotizan lunes/miércoles/viernes (3 veces por semana); el usuario dio
 * el mapeo exacto, día por día:
 *   lunes    → lunes (0DTE de hoy)
 *   martes   → miércoles (sin 0DTE propio ese día, el próximo real)
 *   miércoles→ miércoles (0DTE de hoy)
 *   jueves   → viernes (sin 0DTE propio ese día, el próximo real —
 *              "si opero hoy [jueves] analiza mañana [viernes]")
 *   viernes  → viernes (0DTE de hoy)
 * Si el ticker no tiene un vencimiento real justo en ese día objetivo (ej.
 * solo cotiza viernes, no lunes/miércoles), cae al próximo vencimiento real
 * disponible en o después de esa fecha — igual que antes, si NADA alcanza ni
 * eso, cae al único vencimiento real más próximo que exista.
 */
export function selectWeeklyExpirations(allExpirations: string[], now: Date): string[] {
  const all = [...new Set(allExpirations)]
    .filter((e) => daysToExpiration(e, now) >= 0)
    .sort((a, b) => daysToExpiration(a, now) - daysToExpiration(b, now));
  if (all.length === 0) return [];

  const todayStr = marketDateStr(now);
  const weekday = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0=dom..6=sáb
  // Offset en días hasta el vencimiento OBJETIVO de ese día (regla,
  // 2026-08-27): lunes/miércoles/viernes se analizan a sí mismos; martes cae
  // al miércoles; jueves cae al viernes. Domingo/sábado (mercado cerrado, no
  // debería usarse en la práctica) caen al lunes siguiente.
  const targetOffsetDays: Record<number, number> = { 0: 1, 1: 0, 2: 1, 3: 0, 4: 1, 5: 0, 6: 2 };
  const targetDate = new Date(`${todayStr}T00:00:00Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + targetOffsetDays[weekday]);
  // OJO: NO usar `marketDateStr` acá — reinterpretaría este instante
  // sintético (medianoche UTC) en horario de Nueva York y correría un día
  // hacia atrás (medianoche UTC es la tarde/noche del día anterior en ET).
  // Como `targetDate` es aritmética pura sobre `todayStr` (ya en ET), hay que
  // leer los campos UTC directo para quedarnos en el mismo día calendario.
  const targetStr = `${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, "0")}-${String(targetDate.getUTCDate()).padStart(2, "0")}`;

  const atOrAfterTarget = all.filter((e) => e >= targetStr);
  return atOrAfterTarget.length > 0 ? [atOrAfterTarget[0]] : [all[0]];
}
