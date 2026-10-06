// Bitácora del Playbook del Rango (fase 1), sin pantalla.
//
//   node scripts/scalping-run.mjs
//
// El manual manda anotar los tres niveles CADA mañana durante dos semanas. Una
// bitácora que solo avanza cuando alguien se acuerda de abrir la pestaña mide la
// constancia del usuario, no la estrategia — y con diez sesiones de muestra, dos
// días perdidos son el 20% del experimento.
//
// La tarea se dispara cada 10 min en una ventana LOCAL generosa y el filtro fino
// de sesión se hace aquí en HORA DE NUEVA YORK, igual que en los otros tres
// workers: esta laptop va en UTC−4 todo el año pero Nueva York pasa a UTC−5 en
// noviembre, así que una ventana atada al reloj local se desplazaría media sesión
// medio año.
//
// El paso es idempotente (la ruta no reescribe una fila ya anotada), así que
// repetirlo dentro de la ventana no cuesta nada. Diez minutos y no uno: la
// ventana de anotación dura 95 min y la de calificación no tiene prisa.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const DATA = path.join(WEB, "data");
const LOG_FILE = path.join(DATA, "scalping-run.log");
const STATE_FILE = path.join(DATA, "scalping-run.state.json");
const LOG_MAX_LINES = 500;

const API = "http://127.0.0.1:3000/api/scalping";
/** Un paso anota hasta 5 tickers, y cada uno pide varias cadenas. Va holgado. */
const TIMEOUT_MS = 180_000;

/** Ventana en minutos ET: se anota de 8:00 a 9:35 y se califica tras el cierre. */
const ANOTAR_DESDE = 8 * 60;
const ANOTAR_HASTA = 9 * 60 + 35;
const CALIFICAR_DESDE = 16 * 60 + 5;

function etDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

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

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { date: "" }; }
}
function saveState(st) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(st), "utf8");
}

function log(line) {
  mkdirSync(DATA, { recursive: true });
  let lines = [];
  try { lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean); } catch { /* primera vez */ }
  lines.push(`${new Date().toISOString()}  ${line}`);
  if (lines.length > LOG_MAX_LINES) lines = lines.slice(lines.length - LOG_MAX_LINES);
  writeFileSync(LOG_FILE, lines.join("\n") + "\n", "utf8");
}

async function main() {
  const { weekday, minutes } = etNow();

  // Fin de semana: no hay sesión que anotar ni que calificar.
  if (weekday < 1 || weekday > 5) return 0;

  const enVentanaAnotar = minutes >= ANOTAR_DESDE && minutes < ANOTAR_HASTA;
  const enVentanaCalificar = minutes >= CALIFICAR_DESDE;
  if (!enVentanaAnotar && !enVentanaCalificar) return 0;

  // Latido: sin él, un fichero sin líneas no distingue "no había nada que hacer"
  // de "la tarea nunca se disparó" — el fallo mudo que ya costó una ventana de
  // apertura en venta de prima.
  const hoy = etDate();
  const st = loadState();
  if (st.date !== hoy) {
    log(`SESION ${hoy} — la tarea arrancó (primer paso a las ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} ET)`);
    st.date = hoy;
    saveState(st);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(API, { method: "POST", signal: ctrl.signal });
    body = await res.json();
  } catch (e) {
    log(`FAIL   sin respuesta de Tito: ${e?.message ?? e}`);
    return 1;
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    log(`FAIL   ${body?.error ?? `HTTP ${res.status}`}`);
    return 1;
  }

  const partes = [];
  if (body.anotadas?.length) partes.push(`anotadas: ${body.anotadas.join(", ")}`);
  if (body.calificadas?.length) partes.push(`calificadas: ${body.calificadas.join(", ")}`);
  if (body.fallos?.length) partes.push(`FALLOS: ${body.fallos.join(" · ")}`);

  // Solo se registra lo que CAMBIA algo. En la ventana de anotación el paso corre
  // 10 veces y las 9 últimas dicen "ya estaban": una línea por paso enterraría lo
  // que importa. Un fallo sí se registra siempre.
  if (partes.length > 0) log(`OK     ${body.fase} — ${partes.join(" · ")}`);

  // Que la ventana de anotación acabe sin NINGUNA fila del día sí es un fallo:
  // significa que la cadena no llegó, y no hay segunda oportunidad hasta mañana.
  if (enVentanaAnotar && minutes >= ANOTAR_HASTA - 10 && (body.anotadas?.length ?? 0) === 0 && (body.yaEstaban?.length ?? 0) === 0) {
    log(`FAIL   ${hoy} — se cierra la ventana de anotación SIN una sola fila. La sesión de hoy se pierde.`);
    return 1;
  }

  return body.fallos?.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`FAIL   excepción: ${e?.message ?? e}`);
    process.exit(1);
  });
