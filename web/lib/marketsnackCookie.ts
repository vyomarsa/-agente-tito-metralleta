// Almacén de la cookie de sesión de MarketSnack (app.marketsnack.com). Solo servidor.
//
// Problema que resuelve: la cookie de MarketSnack caduca cada 1–2 días. Antes vivía
// SOLO en process.env.MARKETSNACK_COOKIE, que Next lee UNA vez al arrancar — así que
// renovarla obligaba a editar .env.local y REINICIAR el servidor. Lento y molesto.
//
// Aquí la cookie vive en data/marketsnack-cookie.json y se LEE EN CADA PETICIÓN
// (getCookie), no al arrancar. El .env.local sigue sirviendo de RESPALDO si el
// archivo no existe, así nada se rompe al estrenarlo. Guardar una cookie nueva surte
// efecto sin reiniciar.
//
// Reglas de seguridad:
//  - La cookie se PRUEBA contra MarketSnack ANTES de guardarla (testCookie). Si no
//    sirve, se rechaza y NO se pisa la que ya funcionaba (solo escribimos en éxito).
//  - Nunca se devuelve la cookie completa al cliente: solo una huella parcial.
//  - El archivo vive bajo data/ (gitignored): la cookie no sale de este equipo.

import { promises as fs } from "fs";
import path from "path";

const BASE_URL = "https://app.marketsnack.com";
const COOKIE_FILE = path.join(process.cwd(), "data", "marketsnack-cookie.json");
/** El token de sesión que TIENE que estar presente para que la cookie valga. */
const SESSION_KEY = "_market_snack_session";

export interface StoredCookie {
  cookie: string;
  /** epoch ms de la última vez que se guardó una cookie válida. */
  updatedAt: number;
}

export type CookieSource = "file" | "env" | "none";

export interface CookieStatus {
  /** de dónde sale la cookie que se usaría AHORA mismo. */
  source: CookieSource;
  /** epoch ms de la última actualización guardada (solo si source === "file"). */
  updatedAt: number | null;
  /** huella parcial para reconocerla sin exponerla entera (nunca la cookie completa). */
  fingerprint: string | null;
  /** ¿la cookie activa responde OK contra MarketSnack ahora mismo? */
  live: boolean;
  /** código HTTP de la prueba en vivo (para diagnosticar; 0 = fallo de red). */
  liveStatus: number | null;
}

export interface CookieTest {
  ok: boolean;
  status: number;
}

export interface SaveResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** estado resultante tras guardar (solo en éxito). */
  saved?: CookieStatus;
}

// ---------------------------------------------------------------------------
// Normalización de lo pegado
// ---------------------------------------------------------------------------

/**
 * Normaliza lo pegado en la caja de texto: quita un prefijo "Cookie:" (por si se
 * copió la línea entera del header), comillas envolventes y saltos de línea que
 * romperían el header HTTP. No valida el contenido; de eso se encarga saveCookie.
 */
export function normalizeCookie(raw: string): string {
  let c = (raw ?? "").trim();
  c = c.replace(/^cookie:\s*/i, ""); // "Cookie: a=b; c=d" → "a=b; c=d"
  c = c.replace(/^["']+|["']+$/g, ""); // comillas envolventes
  c = c.replace(/[\r\n\t]+/g, " ").trim(); // saltos de línea/tabs → espacio
  c = c.replace(/\s{2,}/g, " "); // colapsa espacios múltiples
  return c;
}

/** ¿Contiene el token de sesión de MarketSnack? */
export function hasSessionToken(cookie: string): boolean {
  return new RegExp(`(?:^|;\\s*)${SESSION_KEY}=`).test(cookie);
}

/** Huella parcial: reconocible por el usuario, pero sin exponer la cookie. */
function fingerprint(cookie: string): string {
  const m = cookie.match(new RegExp(`${SESSION_KEY}=([^;]+)`));
  const val = m?.[1] ?? "";
  const size = `${cookie.length} chars`;
  if (val.length <= 10) return `${SESSION_KEY}=… (${size})`;
  return `${SESSION_KEY}=${val.slice(0, 4)}…${val.slice(-4)} (${size})`;
}

// ---------------------------------------------------------------------------
// Lectura/escritura del archivo (data/marketsnack-cookie.json, gitignored)
// ---------------------------------------------------------------------------

async function readStored(): Promise<StoredCookie | null> {
  try {
    const raw = await fs.readFile(COOKIE_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredCookie;
    if (parsed && typeof parsed.cookie === "string" && parsed.cookie.trim()) {
      return parsed;
    }
    return null;
  } catch {
    return null; // no existe / ilegible → caemos al respaldo del entorno
  }
}

async function writeStored(cookie: string): Promise<StoredCookie> {
  const rec: StoredCookie = { cookie, updatedAt: Date.now() };
  await fs.mkdir(path.dirname(COOKIE_FILE), { recursive: true });
  await fs.writeFile(COOKIE_FILE, JSON.stringify(rec, null, 2), "utf8");
  return rec;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Devuelve la cookie que debe usarse AHORA para hablar con MarketSnack.
 * Prioridad: data/marketsnack-cookie.json (renovable en caliente) → .env.local.
 * Lanza si no hay ninguna. La lee el cliente (lib/marketsnack.ts) en cada petición.
 */
export async function getCookie(): Promise<string> {
  const stored = await readStored();
  if (stored) return stored.cookie;
  const env = process.env.MARKETSNACK_COOKIE;
  if (env && env.trim()) return normalizeCookie(env);
  throw new Error(
    "Falta la cookie de MarketSnack. Pégala en /ajustes o define MARKETSNACK_COOKIE en .env.local.",
  );
}

/** ¿Hay ALGUNA cookie disponible (archivo o env)? Sin llamada de red (para hot paths). */
export async function marketsnackConfigured(): Promise<boolean> {
  const stored = await readStored();
  if (stored) return true;
  return Boolean(process.env.MARKETSNACK_COOKIE?.trim());
}

/**
 * Prueba mínima contra MarketSnack para saber si la cookie sigue viva. Pide los
 * vencimientos de SPY (payload chico: solo fechas). Sesión inválida → 401/403 o
 * redirect a /login; un 200 con HTML de login NO cuenta (exigimos JSON).
 */
export async function testCookie(cookieHeader: string): Promise<CookieTest> {
  const url = `${BASE_URL}/api/assets/SPY/expirations`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Cookie: cookieHeader },
      cache: "no-store",
      redirect: "manual",
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status };
    const text = await res.text();
    try {
      const j: unknown = JSON.parse(text);
      const ok = Array.isArray(j) || (typeof j === "object" && j !== null);
      return { ok, status: res.status };
    } catch {
      return { ok: false, status: res.status }; // 200 pero no era JSON → login camuflado
    }
  } catch {
    return { ok: false, status: 0 }; // fallo de red / sin internet
  }
}

/**
 * Normaliza, valida y (SOLO si sirve) guarda la cookie pegada. Si la prueba contra
 * MarketSnack falla, NO toca la que ya estaba guardada: devuelve el motivo y punto.
 */
export async function saveCookie(raw: string): Promise<SaveResult> {
  const cookie = normalizeCookie(raw);
  if (!cookie) return { ok: false, error: "No pegaste ninguna cookie." };
  if (!hasSessionToken(cookie)) {
    return {
      ok: false,
      error: `La cookie no contiene ${SESSION_KEY}. Copia el header Cookie completo de app.marketsnack.com.`,
    };
  }
  const test = await testCookie(cookie);
  if (!test.ok) {
    return {
      ok: false,
      status: test.status,
      error:
        test.status === 0
          ? "No se pudo contactar con MarketSnack (¿sin internet?). No se guardó nada."
          : `MarketSnack rechazó esa cookie (HTTP ${test.status}). Sigue activa la anterior: no se pisó nada.`,
    };
  }
  await writeStored(cookie);
  return { ok: true, status: test.status, saved: await cookieStatus() };
}

/** Estado para la página /ajustes. Nunca incluye la cookie completa, solo la huella. */
export async function cookieStatus(): Promise<CookieStatus> {
  const stored = await readStored();
  const env = process.env.MARKETSNACK_COOKIE;

  let source: CookieSource;
  let active: string | null;
  let updatedAt: number | null = null;
  if (stored) {
    source = "file";
    active = stored.cookie;
    updatedAt = stored.updatedAt;
  } else if (env && env.trim()) {
    source = "env";
    active = normalizeCookie(env);
  } else {
    source = "none";
    active = null;
  }

  if (!active) {
    return { source, updatedAt, fingerprint: null, live: false, liveStatus: null };
  }
  const test = await testCookie(active);
  return {
    source,
    updatedAt,
    fingerprint: fingerprint(active),
    live: test.ok,
    liveStatus: test.status,
  };
}
