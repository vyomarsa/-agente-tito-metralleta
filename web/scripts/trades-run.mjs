// Disparador de la BITÁCORA de Tito (pestañas Todos/Swing de Mis Trades).
//
//   node scripts/trades-run.mjs
//
// Hermano de `prima-run.mjs` y `zerodte-run.mjs`. Cierra el último hueco de los
// tres simuladores: venta de prima y 0DTE ya corrían solos, pero la bitácora solo
// avanzaba cuando alguien pulsaba "Actualizar" en la pantalla.
//
// POR QUÉ existe: el 2026-08-24 se descubrió que el último refresco había sido el
// 18 de agosto. Seis días sin re-cotizar significan seis días sin ejecutar stops:
// planes que tocaron su stop el martes se cerraron el lunes siguiente muchísimo
// más abajo. Un stop que solo se aplica cuando hay alguien mirando no es un stop.
//
// CADENCIA: cada 10 minutos de sesión. El coste manda — cada corrida pide UNA
// cadena de opciones por (ticker, vencimiento) abierto, así que un tick por minuto
// como el del 0DTE serían cientos de cadenas al día. Diez minutos de holgura en un
// plan de varios días es ruido; seis días no lo era.
//
// La ventana de la tarea es LOCAL y generosa; el filtro fino (9:30-16:00 ET, solo
// días hábiles) se hace AQUÍ, en hora de Nueva York, por lo mismo que en los otros
// dos: esta laptop va en UTC−4 todo el año y Nueva York pasa a UTC−5 en noviembre.
//
// Fuera de sesión no se re-cotiza nada: "no tocaba" no es un fallo. Lo único que sí
// corre siempre —incluidos sábados y domingos— es la PASADA DE FECHAS: una llamada
// barata, sin red externa, que caduca los planes pendientes que cumplen 7 días sin
// cruzar su gatillo. Es aritmética de calendario y dejarla esperando a la sesión
// mantenía tickers reservados por planes ya muertos.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, ".."); // scripts/ → web/
const DATA = path.join(WEB, "data");
const LOG_FILE = path.join(DATA, "trades-run.log");
const STATE_FILE = path.join(DATA, "trades-run.state.json");
const LOG_MAX_LINES = 500;

const API = "http://127.0.0.1:3000/api/trades/refresh";
/** Misma ruta, modo barato: solo reglas de calendario, sin tocar la red. */
const API_FECHAS = `${API}?modo=fechas`;
/** Una cadena por vencimiento abierto; con 13 grupos tarda ~30 s. */
const TIMEOUT_MS = 5 * 60 * 1000;

/** Ventana de sesión en minutos desde medianoche ET. */
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

/** Bitácora corta con rotación, misma convención que `prima-run.log`. */
function log(line) {
  mkdirSync(DATA, { recursive: true });
  let lines = [];
  try {
    lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
  } catch {
    /* primera vez */
  }
  lines.push(`${new Date().toISOString()}  ${line}`);
  if (lines.length > LOG_MAX_LINES) lines = lines.slice(lines.length - LOG_MAX_LINES);
  writeFileSync(LOG_FILE, lines.join("\n") + "\n", "utf8");
}

/** Día de mercado (ET) en YYYY-MM-DD, para no repetir la pasada de fechas. */
function etDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(st) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(st), "utf8");
}

/**
 * Pasada de FECHAS, una vez al día y pase lo que pase con el mercado.
 *
 * La caducidad de un pendiente (7 días sin cruzar el gatillo) es aritmética de
 * calendario, no de precio, pero vivía dentro del refresco de sesión: un plan que
 * cumplía 7 días un sábado seguía **reservando su ticker** hasta el lunes, y el
 * piloto respeta "una entrada por ticker". Ese veto fantasma es lo que el
 * 2026-08-17 dejó 58 tickers bloqueados y un escaneo de 25 candidatos abriendo CERO.
 *
 * Una vez al día es la cadencia correcta para una regla que se mide en días, y evita
 * llamar cada 10 minutos todo el fin de semana para no hacer nada. Durante la sesión
 * el refresco completo también la aplica, así que no se pierde nada entre pasadas.
 */
async function pasadaDeFechas(hoy) {
  const st = loadState();
  if (st.fechas === hoy) return; // ya corrió hoy

  try {
    const res = await fetch(API_FECHAS, { method: "POST" });
    const body = await res.json();
    if (!res.ok || body?.ok === false) {
      log(`FAIL   fechas — ${body?.error ?? `HTTP ${res.status}`}`);
      return; // sin marcar: se reintenta en el tick siguiente
    }
    // La ruta ya registra las transiciones; aquí solo se marca el día como hecho.
    st.fechas = hoy;
    saveState(st);
  } catch (e) {
    log(`FAIL   fechas — sin respuesta de Tito: ${e?.message ?? e}`);
  }
}

/** Minutos desde medianoche y día de la semana, en Nueva York. */
function etNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: dias[get("weekday")] ?? -1,
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/**
 * `--forzar` salta la ventana de sesión. Es para dos cosas: comprobar la tarea
 * recién instalada sin esperar a la apertura, y refrescar a mano un día que el
 * equipo estuvo apagado. OJO — fuera de sesión las cotizaciones son el último
 * precio operado y la horquilla se abre, así que un plan justo en su stop puede
 * salir a un precio peor del que tendría en mercado. No lo pongas en la tarea.
 */
const FORZAR = process.argv.includes("--forzar");

async function main() {
  const { weekday, minutes } = etNow();

  // Va ANTES de la puerta de sesión a propósito: es justo lo que había que rescatar
  // de fuera de horario. En fin de semana esto es lo ÚNICO que corre.
  await pasadaDeFechas(etDate());

  if (!FORZAR) {
    if (weekday < 1 || weekday > 5) return 0;
    if (minutes < OPEN_MIN || minutes >= CLOSE_MIN) return 0;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(API, { method: "POST", signal: ctrl.signal });
    body = await res.json();
  } catch (e) {
    // En sesión y sin respuesta: eso SÍ es un fallo.
    log(`FAIL   sin respuesta de Tito: ${e?.message ?? e}`);
    return 1;
  } finally {
    clearTimeout(t);
  }

  if (!res.ok || body?.ok === false) {
    log(`FAIL   ${body?.error ?? `HTTP ${res.status}`}`);
    return 1;
  }

  const revisados = body.revisados ?? 0;
  if (revisados === 0) return 0; // nada abierto: ni una línea, no hay nada que contar

  const t2 = body.tally ?? {};
  const cambios = [];
  if (t2.activadas) cambios.push(`${t2.activadas} activada(s)`);
  if (t2.ganadas) cambios.push(`${t2.ganadas} ganada(s)`);
  if (t2.perdidas) cambios.push(`${t2.perdidas} perdida(s)`);
  if (t2.expiradas) cambios.push(`${t2.expiradas} expirada(s)`);
  if (t2.caducadas) cambios.push(`${t2.caducadas} caducada(s)`);

  const sinPrima = body.warnings?.noMark?.length ?? 0;

  /**
   * Guardia contra el fallo MUDO que motivó todo esto: si NINGÚN contrato abierto
   * consiguió prima, el refresco "funcionó" pero no midió nada — y así estuvo seis
   * días. Sale con código != 0 para que el Programador de tareas lo marque en rojo
   * en vez de dejarlo en verde.
   *
   * Ojo, `noMark` va recortado a 12 por la ruta, así que se compara contra el
   * mínimo: con menos abiertos que el tope, "todos sin prima" se detecta igual.
   */
  if (sinPrima > 0 && sinPrima >= Math.min(revisados, 12)) {
    log(`FAIL   ${revisados} abierto(s) y NINGUNO con prima — fuente de opciones caída. Sin prima no hay P&L.`);
    return 1;
  }

  const s = body.summary ?? {};
  const detalle = cambios.length ? cambios.join(" · ") : "sin cambios";
  const aviso = sinPrima ? ` · ${sinPrima} sin prima` : "";
  const fuente = body.source?.spot ? ` · spot ${body.source.spot}` : "";

  // Solo se registra cuando algo cambia de estado. A 39 corridas al día, una línea
  // por corrida enterraría lo que importa; el resumen de la pantalla ya da el resto.
  if (cambios.length > 0 || sinPrima > 0) {
    log(
      `OK     revisados ${revisados} · ${detalle}${aviso}${fuente} · ` +
        `${s.wins ?? 0}W/${s.losses ?? 0}L · cerrado ${Math.round(s.closedPnl ?? 0)}`,
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`FAIL   excepción: ${e?.message ?? e}`);
    process.exit(1);
  });
