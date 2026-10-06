// Disparador de la CUENTA DE PAPER DEL 0DTE, sin pantalla.
//
//   node scripts/zerodte-run.mjs [TICKER]   (por defecto SPY)
//
// La cuenta necesita un tick por minuto durante toda la sesión: re-cotiza lo
// abierto, cierra por objetivo/stop y compra el contrato del GEX Ticket cuando el
// agente tiene señal. Hasta ahora eso solo pasaba con la página `/0dte` abierta,
// así que la cuenta solo medía los ratos en que alguien estaba mirando — justo lo
// contrario de lo que sirve para evaluar un agente.
//
// La tarea programada lo llama cada minuto en una ventana LOCAL generosa, y el
// filtro fino de sesión se hace aquí en HORA DE NUEVA YORK. Ese reparto es a
// propósito: esta laptop va en UTC−4 todo el año, pero Nueva York pasa a UTC−5 en
// noviembre, así que una ventana atada al reloj local se desplazaría media sesión
// medio año. Es el mismo bug que ya se arregló en el paper de venta de prima.
//
// Fuera de sesión sale en verde y sin tocar la red: el modo de fallo que hay que
// evitar es el silencioso, pero "no tocaba" no es un fallo.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const DATA = path.join(WEB, "data");
const LOG_FILE = path.join(DATA, "zerodte-run.log");
const STATE_FILE = path.join(DATA, "zerodte-run.state.json");
const LOG_MAX_LINES = 500;

const TICKER = (process.argv[2] ?? "SPY").trim().toUpperCase();
const API = `http://127.0.0.1:3000/api/0dte-paper?ticker=${encodeURIComponent(TICKER)}`;
/** Una cadena de opciones; si tarda más de esto, algo va mal. */
const TIMEOUT_MS = 90_000;

/** Ventana de sesión en minutos desde medianoche ET. */
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

/** Fecha de mercado (ET) en YYYY-MM-DD. */
function etDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * Contador de ticks del día.
 *
 * Existe para que la AUSENCIA de líneas no sea ambigua. Registrar un renglón por
 * tick serían 390 al día y el fichero dejaría de leerse; no registrar nada
 * convierte "corrió toda la sesión sin oportunidades" y "la tarea no llegó a
 * dispararse" en la misma cosa, que es justo el fallo silencioso que ya costó
 * una ventana de apertura en venta de prima. Así que se marca el PRIMER tick de
 * cada sesión y se cierra con el recuento al final.
 */
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { date: "", ticks: 0 }; }
}
function saveState(st) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(st), "utf8");
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

async function main() {
  const { weekday, minutes } = etNow();

  // Fin de semana o fuera de horario: ni se toca la red. A un minuto por tick,
  // pedir la cadena fuera de sesión serían cientos de llamadas inútiles al día.
  if (weekday < 1 || weekday > 5) return 0;
  if (minutes < OPEN_MIN || minutes >= CLOSE_MIN) return 0;

  // Latido: primer tick del día → deja constancia de que la tarea SÍ arrancó.
  const hoy = etDate();
  const st = loadState();
  if (st.date !== hoy) {
    log(`SESION ${hoy} — la tarea arrancó (${TICKER}, primer tick a los ${minutes - OPEN_MIN} min de apertura)`);
    st.date = hoy;
    st.ticks = 0;
    st.closed = false;
  }
  st.ticks += 1;
  saveState(st);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(API, { method: "POST", signal: ctrl.signal });
    body = await res.json();
  } catch (e) {
    // Aquí SÍ es un fallo: estamos en sesión y el servidor no contestó.
    log(`FAIL   ${TICKER} — sin respuesta de Tito: ${e?.message ?? e}`);
    return 1;
  } finally {
    clearTimeout(t);
  }

  if (!res.ok || body?.ok === false) {
    if (body?.skipped) {
      log(`SKIP   ${TICKER} — ${body.note}`);
      return 0; // no tocaba: no es un fallo
    }
    log(`FAIL   ${TICKER} — ${body?.error ?? `HTTP ${res.status}`}`);
    return 1;
  }

  const s = body.summary ?? {};
  const cierres = (body.justClosed ?? [])
    .map((c) => `${c.type === "call" ? "C" : "P"}${c.strike} ${c.reason} ${c.pnl >= 0 ? "+" : ""}${c.pnl}`)
    .join(", ");

  // Una línea por tick sería ruido (390 al día). Solo se registra lo que cambia
  // el estado: un cierre o una cartera distinta de la del tick anterior.
  const resumen =
    `abiertas ${body.opened} · equity ${s.equity} · ${s.wins ?? 0}W/${s.losses ?? 0}L` +
    (cierres ? ` · CIERRES: ${cierres}` : "") +
    (body.blocked && body.opened === 0 ? ` · no abre: ${body.blocked}` : "");

  // Las notas del tick (p. ej. una vencida de OTRO ticker que se acaba de liquidar)
  // se registran SIEMPRE: son justo lo que nadie estaba viendo, porque el cron solo
  // escanea SPY y esas posiciones no salían en ningún sitio.
  for (const n of body.notes ?? []) log(`NOTA   ${n}`);

  if (cierres || body.opened > 0) log(`OK     ${TICKER} — ${resumen}`);

  // Cierre de sesión: recuento del día. Con esto, mirar la bitácora contesta
  // "¿corrió?" sin tener que abrir el Programador de tareas.
  // El flag evita repetirla: `minutesLeft <= 1` es cierto en más de un tick si la
  // tarea se dispara dos veces en el último minuto.
  if (body.minutesLeft <= 1 && !st.closed) {
    log(`SESION ${hoy} — fin: ${st.ticks} ticks · equity ${s.equity} · ${s.closedCount ?? 0} cerrada(s) hoy`);
    st.closed = true;
    saveState(st);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`FAIL   ${TICKER} — excepción: ${e?.message ?? e}`);
    process.exit(1);
  });
