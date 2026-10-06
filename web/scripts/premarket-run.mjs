// Sub-agente de pre-market, sin pantalla.
//
//   node scripts/premarket-run.mjs            → solo dentro de la ventana, una vez al día
//   node scripts/premarket-run.mjs --forzar   → manda ya (para probar)
//
// Manda por Telegram, ~30 min antes de la apertura, el análisis de SPY, QQQ, SPX y
// las 7 magníficas (medias 55/200 en 4H, nocional de opciones y noticias). La
// lógica vive en POST /api/premarket; esto solo decide CUÁNDO.
//
// La tarea se dispara cada 5 min en una ventana LOCAL generosa y aquí se filtra en
// HORA DE NUEVA YORK, como los otros workers: esta laptop va en UTC−4 todo el año
// y Nueva York pasa a UTC−5 en noviembre. Se arranca a las 8:55 ET porque armar el
// informe tarda ~3-4 min (las noticias van en cola por el límite de Massive) y así
// llega hacia las 9:00. Si falla, el tick siguiente reintenta hasta las 9:25.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const DATA = path.join(WEB, "data");
const LOG_FILE = path.join(DATA, "premarket-run.log");
const STATE_FILE = path.join(DATA, "premarket-run.state.json");
const LOG_MAX_LINES = 500;

const API = "http://127.0.0.1:3000/api/premarket";
const TIMEOUT_MS = 9 * 60_000;

/** Ventana en minutos ET. */
const DESDE = 8 * 60 + 55;
const HASTA = 9 * 60 + 25;

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
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { sentDate: "" }; }
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
  const forzar = process.argv.includes("--forzar");
  const { weekday, minutes } = etNow();
  const hoy = etDate();

  if (!forzar) {
    if (weekday < 1 || weekday > 5) return 0;
    if (minutes < DESDE || minutes >= HASTA) return 0;
    if (loadState().sentDate === hoy) return 0; // ya se mandó hoy
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

  if (!res.ok || !body.sent) {
    log(`FAIL   ${body?.error ?? body?.reason ?? `HTTP ${res.status}`}`);
    // Último intento de la ventana sin enviar: el informe de hoy se pierde.
    if (!forzar && minutes >= HASTA - 5) log(`FAIL   ${hoy} — se cierra la ventana sin mandar el pre-market.`);
    return 1;
  }

  // Una prueba forzada no cuenta como el envío del día: el de la ventana sale igual.
  if (!forzar) saveState({ sentDate: hoy });
  log(`OK     ${hoy} — enviado (${body.tickers} tickers, ${body.chars} caracteres)${forzar ? " [forzado]" : ""}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`FAIL   excepción: ${e?.message ?? e}`);
    process.exit(1);
  });
