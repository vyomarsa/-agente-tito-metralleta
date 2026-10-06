// Horario de mercado (NYSE/Nasdaq), lun-vie 9:30-16:00 ET. Sin calendario de
// feriados (limitación documentada, igual que el resto del repo — nada más
// acá maneja feriados tampoco).

const ET = "America/New_York";

function partsET(now: Date): { weekday: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { weekday, hour, minute };
}

/** ¿Está el mercado abierto ahora mismo? Lun-vie, 9:30-16:00 ET. */
export function isMarketOpen(now: Date = new Date()): boolean {
  const { weekday, hour, minute } = partsET(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight < 16 * 60;
}

/** Texto corto para mostrar en la UI. */
export function marketStatusLabel(now: Date = new Date()): string {
  return isMarketOpen(now) ? "Mercado abierto" : "Mercado cerrado";
}

/**
 * ¿Faltan `minutesBefore` minutos o menos para el cierre (16:00 ET)? Para el
 * Registro de Operaciones (lib/registroOperaciones.ts, "eod"): day-trading no
 * carga entradas de un día para otro, así que se fuerza el cierre antes de
 * que cierre el mercado en vez de dejar el contrato abierto de la noche a la
 * mañana.
 */
export function isMarketCloseNear(now: Date = new Date(), minutesBefore = 15): boolean {
  const { weekday, hour, minute } = partsET(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesSinceMidnight = hour * 60 + minute;
  const closeMinutes = 16 * 60;
  return minutesSinceMidnight >= closeMinutes - minutesBefore && minutesSinceMidnight < closeMinutes;
}

/** ¿Es horario de pre-market (4:00–9:30 ET, lun-vie)? Sin calendario de feriados, misma limitación de arriba. */
export function isPreMarket(now: Date = new Date()): boolean {
  const { weekday, hour, minute } = partsET(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 4 * 60 && minutesSinceMidnight < 9 * 60 + 30;
}

/**
 * Recorta barras intradía (tiempo unix en segundos) a la ventana de
 * pre-market (4:00–9:30 ET) del día de mercado `targetDateStr` (YYYY-MM-DD,
 * ET — mismo formato que `marketDateStr`, lib/occ.ts) — para "Grandes
 * empresas" (Prueba de Fuego): el % movido y los puntos de rechazo del
 * pre-market se calculan SOLO sobre las velas de ese día antes de la
 * apertura, no sobre todo el histórico de 20 días que trae la gráfica.
 *
 * Recibe la fecha explícita (no `now`) a propósito: entre medianoche y las
 * 4:00 ET, "hoy" en el calendario todavía no tiene NINGÚN dato (el feed en
 * vivo de MarketSnack recién empieza a las 4:00 ET) — pedirle el pre-market
 * del día calendario de `now` en esa ventana siempre da `[]`. El caller
 * decide la fecha real a usar (normalmente la del último dato disponible,
 * que sigue siendo la sesión de ayer hasta que arranca la de hoy).
 */
export function filterPremarketBars<T extends { time: number }>(bars: T[], targetDateStr: string): T[] {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

  return bars.filter((b) => {
    const parts = fmt.formatToParts(new Date(b.time * 1000));
    const key = ["year", "month", "day"].map((t) => parts.find((p) => p.type === t)?.value).join("-");
    if (key !== targetDateStr) return false;
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const minutesSinceMidnight = hour * 60 + minute;
    return minutesSinceMidnight >= 4 * 60 && minutesSinceMidnight < 9 * 60 + 30;
  });
}

/**
 * ¿Está abierto el mercado de FUTUROS de CME (ES/NQ, sesión "Globex")? Casi
 * 24/5, a diferencia de las opciones de índice de arriba — pedido explícito
 *: poder operar /ES y /NQ mientras el mercado de acciones está
 * cerrado. Abierto de domingo 18:00 ET a viernes 17:00 ET, con una pausa de
 * mantenimiento diaria de 17:00 a 18:00 ET. Sin calendario de feriados
 * (misma limitación declarada que el resto de este archivo).
 */
export function isFuturesMarketOpen(now: Date = new Date()): boolean {
  const { weekday, hour, minute } = partsET(now);
  const minutesSinceMidnight = hour * 60 + minute;
  const maintenanceStart = 17 * 60;
  const maintenanceEnd = 18 * 60;
  if (weekday === "Sat") return false;
  if (weekday === "Sun" && minutesSinceMidnight < maintenanceEnd) return false;
  if (weekday === "Fri" && minutesSinceMidnight >= maintenanceStart) return false;
  if (minutesSinceMidnight >= maintenanceStart && minutesSinceMidnight < maintenanceEnd) return false;
  return true;
}

