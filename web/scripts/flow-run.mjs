// Barrido del FLUJO del universo, sin pantalla.
//
//   node scripts/flow-run.mjs
//
// Sustituye al "flujo de todo el mercado" de MarketSnack: el streamer de Tastytrade
// no tiene feed de mercado, así que hay que recorrer los símbolos uno a uno. Son
// minutos (102 símbolos ≈ 8 min a concurrencia 3), por eso corre como tarea y las
// pantallas leen la foto que deja (`data/flow/market.json`).
//
// Corre UNA vez por día de mercado, DESPUÉS del cierre: así la foto cubre la sesión
// entera. El filtro fino de día hábil y hora se hace aquí, en hora de Nueva York, y
// no en la ventana de la tarea, por el mismo motivo que en los otros workers: esta
// laptop va en UTC−4 todo el año y Nueva York pasa a UTC−5 en noviembre.
//
// El barrido alimenta además el almacén POR TICKER (`saveTrades`), que es lo que
// hace que el histórico de 30 días de Convicción exista: Tastytrade solo sirve ~5
// sesiones, así que la profundidad se construye barrido a barrido.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const DATA = path.join(WEB, "data");
const LOG_FILE = path.join(DATA, "flow-run.log");
const STATE_FILE = path.join(DATA, "flow-run.state.json");
const LOG_MAX_LINES = 500;

const API = "http://127.0.0.1:3000/api/flow-sweep";
/** 102 símbolos a concurrencia 3 ≈ 8 min; se deja margen de sobra. */
const TIMEOUT_MS = 20 * 60_000;

/** Desde esta hora ET se considera que la sesión ya cerró y la foto cubre el día. */
const TRAS_CIERRE_MIN = 16 * 60 + 15;

function etDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function etParts(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);
  const g = (k) => p.find((x) => x.type === k)?.value ?? "";
  return { minutos: (Number(g("hour")) % 24) * 60 + Number(g("minute")), dia: g("weekday") };
}

function log(nivel, texto) {
  mkdirSync(DATA, { recursive: true });
  const linea = `${new Date().toISOString()}  ${nivel.padEnd(6)} ${texto}`;
  appendFileSync(LOG_FILE, linea + "\n", "utf8");
  try {
    const lineas = readFileSync(LOG_FILE, "utf8").trimEnd().split("\n");
    if (lineas.length > LOG_MAX_LINES) {
      writeFileSync(LOG_FILE, lineas.slice(-LOG_MAX_LINES).join("\n") + "\n", "utf8");
    }
  } catch { /* la rotación no puede tumbar el barrido */ }
  console.log(linea);
}

function estado() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function guardarEstado(s) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s), "utf8");
}

const forzar = process.argv.includes("--forzar");
const hoy = etDate();
const { minutos, dia } = etParts();

if (!forzar) {
  if (dia === "Sat" || dia === "Sun") process.exit(0); // fin de semana: no tocaba
  if (minutos < TRAS_CIERRE_MIN) process.exit(0); // aún no cerró la sesión
  if (estado().date === hoy) process.exit(0); // ya se barrió hoy
}

const ctrl = new AbortController();
const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
try {
  const r = await fetch(`${API}?days=1&minPremium=100000&concurrency=3`, {
    method: "POST", signal: ctrl.signal,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) {
    log("FAIL", `barrido — ${d.error ?? `HTTP ${r.status}`}`);
    process.exit(1);
  }
  // Sin un solo símbolo leído la foto no vale: es el fallo que hay que ver en rojo.
  if (!d.escaneados) {
    log("FAIL", `barrido — 0 de ${d.universo} símbolos: revisa Tastytrade`);
    process.exit(1);
  }
  guardarEstado({ date: hoy, at: new Date().toISOString() });
  const fallidos = d.fallidos?.length ? ` · fallaron ${d.fallidos.length}: ${d.fallidos.slice(0, 8).join(", ")}` : "";
  log("OK", `barrido — ${d.escaneados}/${d.universo} símbolos · ${d.operaciones} operaciones · ${Math.round(d.ms / 1000)}s${fallidos}`);
} catch (e) {
  log("FAIL", `barrido — ${e?.name === "AbortError" ? `sin respuesta en ${TIMEOUT_MS / 60000} min` : String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  clearTimeout(reloj);
}
