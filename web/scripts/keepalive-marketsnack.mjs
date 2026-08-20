// Keep-alive de la sesión de MarketSnack (Fase 2).
//
// La sesión de MarketSnack es DESLIZANTE y ROTA la cookie en cada petición: cada
// respuesta trae un Set-Cookie con un _market_snack_session NUEVO. O sea que "tocar"
// la sesión solo la mantiene viva si CAPTURAMOS la cookie rotada y la guardamos —
// hacer ping con la cookie vieja y tirar la nueva no mueve su caducidad embebida.
//
// Este script (pensado para una tarea programada cada ~25 min) hace una petición
// mínima, y si sale bien, fusiona el _market_snack_session rotado en la cookie
// guardada (data/marketsnack-cookie.json, el mismo almacén de la Fase 1) y deja una
// línea en data/keepalive.log. Corre SOLO (no necesita el server de Next levantado).
//
// HONESTIDAD: esto ayuda si MarketSnack usa caducidad por INACTIVIDAD (deslizante).
// Si además hay un tope ABSOLUTO de sesión, llegado ese tope caducará igual y habrá
// que renovar la cookie a mano en /ajustes. Solo se sabrá observando unos días la
// bitácora (si aparecen EXPIRED aunque el keep-alive venía corriendo → tope absoluto).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, ".."); // scripts/ → web/
const DATA = path.join(WEB, "data");
const COOKIE_FILE = path.join(DATA, "marketsnack-cookie.json");
const ENV_FILE = path.join(WEB, ".env.local");
const LOG_FILE = path.join(DATA, "keepalive.log");
const LOG_MAX_LINES = 500;

const BASE_URL = "https://app.marketsnack.com";
const PING_URL = `${BASE_URL}/api/assets/SPY/expirations`; // payload chico: solo fechas
const SESSION_RE = /_market_snack_session=([^;]+)/;

function stamp() {
  return new Date().toISOString();
}

/** Lee la cookie activa: archivo (Fase 1) → respaldo .env.local. */
function loadCookie() {
  try {
    const j = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
    if (j && typeof j.cookie === "string" && j.cookie.trim()) {
      return { cookie: j.cookie, source: "file" };
    }
  } catch {
    /* no existe / ilegible → probamos el entorno */
  }
  try {
    const env = readFileSync(ENV_FILE, "utf8");
    const m = env.match(/^MARKETSNACK_COOKIE\s*=\s*(.*)$/m);
    if (m) {
      const cookie = m[1].trim().replace(/^["']+|["']+$/g, "");
      if (cookie) return { cookie, source: "env" };
    }
  } catch {
    /* sin .env.local */
  }
  return { cookie: null, source: "none" };
}

/** Reemplaza SOLO el _market_snack_session, conservando el resto de la cookie. */
function mergeSession(fullCookie, newSessionValue) {
  if (SESSION_RE.test(fullCookie)) {
    return fullCookie.replace(SESSION_RE, `_market_snack_session=${newSessionValue}`);
  }
  return `_market_snack_session=${newSessionValue}; ${fullCookie}`;
}

/** Escritura atómica (tmp + rename) para que el server nunca lea un archivo a medias. */
function saveCookie(cookie) {
  mkdirSync(DATA, { recursive: true });
  const tmp = COOKIE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify({ cookie, updatedAt: Date.now() }, null, 2), "utf8");
  renameSync(tmp, COOKIE_FILE);
}

/** Bitácora corta con rotación (últimas LOG_MAX_LINES líneas). */
function log(line) {
  mkdirSync(DATA, { recursive: true });
  let lines = [];
  try {
    lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
  } catch {
    /* primera vez */
  }
  lines.push(`${stamp()}  ${line}`);
  if (lines.length > LOG_MAX_LINES) lines = lines.slice(lines.length - LOG_MAX_LINES);
  writeFileSync(LOG_FILE, lines.join("\n") + "\n", "utf8");
}

async function main() {
  const { cookie, source } = loadCookie();
  if (!cookie) {
    log("SKIP    sin cookie (ni archivo ni .env.local) — renueva en /ajustes");
    console.log("keepalive: sin cookie");
    return;
  }

  let res;
  try {
    res = await fetch(PING_URL, {
      headers: { Accept: "application/json", Cookie: cookie },
      redirect: "manual",
    });
  } catch (e) {
    log(`ERROR   red/sin internet (${e?.message ?? "fetch falló"}) — no se tocó nada`);
    console.log("keepalive: error de red");
    return;
  }

  // Sesión inválida/expirada → 401/403 o redirect a /login.
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    log(`EXPIRED HTTP ${res.status} — sesión caducada; renueva la cookie en /ajustes`);
    console.log(`keepalive: sesión caducada (HTTP ${res.status})`);
    return;
  }
  if (res.status < 200 || res.status >= 300) {
    log(`WARN    HTTP ${res.status} inesperado — no se tocó la cookie`);
    console.log(`keepalive: HTTP ${res.status}`);
    return;
  }

  // Éxito: capturamos la cookie rotada (si vino) y la guardamos de vuelta.
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const rotated = setCookies.find((sc) => sc.startsWith("_market_snack_session="));
  if (rotated) {
    const newVal = (rotated.match(SESSION_RE) || [])[1];
    const oldVal = (cookie.match(SESSION_RE) || [])[1];
    if (newVal && newVal !== oldVal) {
      saveCookie(mergeSession(cookie, newVal));
      log(`OK      HTTP 200  viva · cookie rotada guardada (fuente previa: ${source})`);
      console.log("keepalive: viva, cookie rotada guardada");
      return;
    }
  }
  // 200 pero sin rotación (o mismo valor): la sesión respondió, no hay nada que guardar.
  log("OK      HTTP 200  viva · sin rotación (nada que guardar)");
  console.log("keepalive: viva, sin rotación");
}

main().catch((e) => {
  try {
    log(`ERROR   excepción no controlada: ${e?.message ?? e}`);
  } catch {}
  console.error(e);
  process.exit(1);
});
