// Almacén de la cookie de sesión de MarketSnack. Vive en data/marketsnack-cookie.json
// (gitignored, ver /data en .gitignore) y se LEE EN CADA PETICIÓN — no al arrancar — así
// que actualizarla desde /ajustes surte efecto sin reiniciar `next dev`. Si el archivo
// todavía no existe (instalación nueva), cae de vuelta a MARKETSNACK_COOKIE en .env.local.
// Solo servidor. La validación contra MarketSnack (red) vive en lib/marketsnack.ts —
// este módulo no hace fetch, solo lee/escribe/normaliza texto, para evitar un import
// circular con marketsnack.ts (que a su vez importa loadCookie de aquí).

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "marketsnack-cookie.json");

export interface StoredCookie {
  cookie: string;
  updatedAt: string;
  source: string; // "ajustes" | "extractor" | otro identificador libre
}

/** Quita comillas envolventes, saltos de línea y un prefijo "Cookie:" si se pegó la línea completa de DevTools. */
export function normalizeCookie(raw: string): string {
  let c = raw.replace(/\r?\n/g, " ").trim();
  if (/^cookie\s*:/i.test(c)) c = c.replace(/^cookie\s*:/i, "").trim();
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1).trim();
  }
  return c.replace(/[ \t]+/g, " ").trim();
}

/** Chequeo de forma (no de validez real — eso lo hace testMarketSnackCookie contra la red). */
export function looksLikeSessionCookie(cookie: string): boolean {
  return /(^|;\s*)_market_snack_session=/.test(cookie);
}

/** Huella parcial para mostrar en la UI sin exponer la cookie completa. */
export function fingerprint(cookie: string): string {
  const m = cookie.match(/_market_snack_session=([^;]+)/);
  const val = m ? m[1] : cookie;
  if (val.length <= 12) return `${val.slice(0, 3)}…`;
  return `${val.slice(0, 6)}…${val.slice(-6)} (${val.length} caract.)`;
}

async function readStoredFile(): Promise<StoredCookie | null> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredCookie;
    if (parsed && typeof parsed.cookie === "string" && parsed.cookie.trim()) return parsed;
    return null;
  } catch {
    return null; // no existe todavía, o está corrupto — se trata como "sin guardar"
  }
}

/** La cookie activa: archivo si existe, si no el respaldo de .env.local. `null` si no hay ninguna. */
export async function loadCookie(): Promise<string | null> {
  const stored = await readStoredFile();
  if (stored) return stored.cookie;
  const env = process.env.MARKETSNACK_COOKIE;
  return env && env.trim() ? env.trim() : null;
}

/** Igual que `loadCookie` pero con metadatos para la UI de /ajustes. */
export async function loadCookieMeta(): Promise<{
  cookie: string | null;
  updatedAt: string | null;
  source: "ajustes" | "extractor" | "env" | "none" | string;
}> {
  const stored = await readStoredFile();
  if (stored) return { cookie: stored.cookie, updatedAt: stored.updatedAt, source: stored.source };
  const env = process.env.MARKETSNACK_COOKIE;
  if (env && env.trim()) return { cookie: env.trim(), updatedAt: null, source: "env" };
  return { cookie: null, updatedAt: null, source: "none" };
}

/**
 * Guarda una cookie ya normalizada. NO valida contra la red (eso lo hace el caller —
 * la ruta /api/marketsnack-cookie — ANTES de llamar aquí, así una cookie que no sirve
 * nunca pisa la que sí funcionaba). Sí revalida la forma como último cinturón de seguridad.
 */
export async function saveCookie(raw: string, source: string): Promise<StoredCookie> {
  const cookieStr = normalizeCookie(raw);
  if (!cookieStr) throw new Error("Cookie vacía.");
  if (!looksLikeSessionCookie(cookieStr)) {
    throw new Error(
      'No encuentro "_market_snack_session" en lo que se pegó. Copia el header Cookie completo desde DevTools → Network → /api/flow_feed.',
    );
  }
  const payload: StoredCookie = { cookie: cookieStr, updatedAt: new Date().toISOString(), source };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}
