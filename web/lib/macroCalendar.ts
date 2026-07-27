// Calendario macro para el Filtro 4 (eliminatorio) del escáner de Credit Spreads.
//
// El prompt del operador prohíbe abrir un spread de 5–7 DTE cuando dentro de la
// ventana de vida del trade cae un evento macro de alto impacto (FOMC, CPI, PCE,
// NFP): esos días mueven el subyacente más allá de 1σ y rompen la estadística del
// spread. Aquí traemos esas fechas de FRED (Reserva Federal de St. Louis — fuente
// oficial, gratis, JSON), las cacheamos a diario y exponemos una función PURA
// `macroEventsInWindow` para el motor.
//
// Separación I/O vs. puro: `fetchMacroCalendar`/`cachedMacroCalendar` tocan red y
// disco; `macroEventsInWindow` es pura y testeable. Solo servidor (usa FRED_API_KEY).

import { promises as fs } from "fs";
import path from "path";
import { marketDateStr } from "./occ";

const BASE = "https://api.stlouisfed.org/fred";
const DATA_FILE = path.join(process.cwd(), "data", "macro-calendar.json");

/** Horizonte que cacheamos hacia adelante (suficiente para spreads de 5–7 DTE). */
export const HORIZON_DAYS = 120;

export type MacroEventKind = "CPI" | "NFP" | "PCE" | "FOMC";

export interface MacroEvent {
  kind: MacroEventKind;
  /** Fecha de publicación programada, YYYY-MM-DD (ET). */
  date: string;
  label: string;
}

export interface MacroCalendar {
  /** Día de mercado (ET) en que se refrescó el cache. */
  date: string;
  updatedAt: string;
  /** Si es un cache viejo servido porque FRED falló. */
  stale: boolean;
  events: MacroEvent[];
}

/**
 * Release IDs de FRED de los eventos MENSUALES que sí devuelve limpios:
 * CPI=10, Employment Situation/NFP=50, Personal Income & Outlays/PCE=54.
 * Verificados contra la API (jul 2026): con `include_release_dates_with_no_data=true`
 * dan las fechas futuras programadas, una por mes.
 *
 * OJO: el FOMC NO se saca de FRED. El release 101 ("FOMC Press Release") está
 * etiquetado a DIARIO en FRED (count ~3.7k, una fecha por día) y no expone las
 * fechas de reunión futuras. El calendario del FOMC lo publica la propia Fed con
 * años de antelación y casi nunca cambia, así que se cura como constante abajo.
 */
export const MACRO_RELEASES: { id: number; kind: MacroEventKind; label: string }[] = [
  { id: 10, kind: "CPI", label: "CPI (IPC)" },
  { id: 50, kind: "NFP", label: "Nóminas no agrícolas (NFP)" },
  { id: 54, kind: "PCE", label: "Ingresos y Gastos (PCE)" },
];

/**
 * Fechas de PUBLICACIÓN del comunicado FOMC (el día de alto impacto = último día
 * de la reunión de dos días). Fuente oficial:
 * https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (jul 2026).
 * Revisar/extender una vez al año cuando la Fed publique el calendario siguiente.
 */
export const FOMC_STATEMENT_DATES: string[] = [
  // 2026
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  // 2027
  "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09",
  "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
];

// ---------------------------------------------------------------------------
// PURO
// ---------------------------------------------------------------------------

/**
 * Eventos macro dentro de la ventana [from, to] inclusive. Como las fechas son
 * cadenas YYYY-MM-DD, la comparación lexicográfica equivale a la cronológica.
 * PURA: no toca red ni disco.
 */
export function macroEventsInWindow(
  events: MacroEvent[],
  from: string,
  to: string,
): MacroEvent[] {
  return events
    .filter((e) => e.date >= from && e.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/** Suma `days` días de calendario a una fecha YYYY-MM-DD y la devuelve igual. */
export function addDaysStr(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// I/O — FRED
// ---------------------------------------------------------------------------

interface FredReleaseDatesResponse {
  release_dates?: { release_id: number; date: string }[];
}

/**
 * Fechas FUTURAS programadas de un release. `include_release_dates_with_no_data=true`
 * hace que FRED devuelva las fechas ya calendarizadas aunque el dato aún no exista.
 */
export async function fetchReleaseDates(
  releaseId: number,
  apiKey: string,
  now: Date = new Date(),
): Promise<string[]> {
  const today = marketDateStr(now);
  const horizon = addDaysStr(today, HORIZON_DAYS);
  const url =
    `${BASE}/release/dates?release_id=${releaseId}` +
    `&api_key=${apiKey}&file_type=json` +
    `&include_release_dates_with_no_data=true&sort_order=asc`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED release ${releaseId} HTTP ${res.status}`);
  const json = (await res.json()) as FredReleaseDatesResponse;
  const dates = json.release_dates ?? [];
  return dates
    .map((d) => d.date)
    .filter((date) => date >= today && date <= horizon);
}

/** Eventos FOMC curados dentro del horizonte [hoy, hoy+HORIZON_DAYS]. PURA. */
export function fomcEventsInHorizon(now: Date = new Date()): MacroEvent[] {
  const today = marketDateStr(now);
  const horizon = addDaysStr(today, HORIZON_DAYS);
  return FOMC_STATEMENT_DATES.filter((date) => date >= today && date <= horizon).map(
    (date) => ({ kind: "FOMC" as const, date, label: "Comunicado FOMC" }),
  );
}

/**
 * Arma la lista de eventos del horizonte: CPI/NFP/PCE desde FRED + FOMC curado.
 * Si falla FRED, la excepción sube al cache que decide si sirve el cache viejo.
 */
export async function fetchMacroCalendar(now: Date = new Date()): Promise<MacroEvent[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY no configurada en .env.local");

  const perRelease = await Promise.all(
    MACRO_RELEASES.map(async (r) => {
      const dates = await fetchReleaseDates(r.id, apiKey, now);
      return dates.map<MacroEvent>((date) => ({ kind: r.kind, date, label: r.label }));
    }),
  );
  return [...perRelease.flat(), ...fomcEventsInHorizon(now)].sort(
    (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
  );
}

// ---------------------------------------------------------------------------
// I/O — cache en disco
// ---------------------------------------------------------------------------

export async function loadMacroCache(): Promise<MacroCalendar | null> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as MacroCalendar;
    return Array.isArray(parsed.events) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveMacroCache(cal: MacroCalendar): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(cal), "utf8");
}

/**
 * Calendario macro con cache de un día de mercado. Si FRED falla, sirve el último
 * cache marcado `stale: true`. Si no hay cache y FRED falla, devuelve null: el
 * motor debe BLOQUEAR (no operar a ciegas), igual que la salvaguarda de liquidez.
 */
export async function cachedMacroCalendar(now: Date = new Date()): Promise<MacroCalendar | null> {
  const today = marketDateStr(now);
  const cached = await loadMacroCache();
  if (cached && cached.date === today && !cached.stale) return cached;

  try {
    const events = await fetchMacroCalendar(now);
    const fresh: MacroCalendar = {
      date: today,
      updatedAt: now.toISOString(),
      stale: false,
      events,
    };
    await saveMacroCache(fresh);
    return fresh;
  } catch {
    // FRED no respondió: servir el cache viejo etiquetado, si existe.
    if (cached) return { ...cached, stale: true };
    return null;
  }
}
