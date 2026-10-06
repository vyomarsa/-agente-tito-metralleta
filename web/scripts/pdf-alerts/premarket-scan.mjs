#!/usr/bin/env node
// Alerta diaria de pre-market por Telegram (ago 2026, pedido explícito de
// el usuario): todas las mañanas ~8:15am hora de Texas, avisa qué empresas del
// S&P 500 se movieron ±5% durante el pre-market. Standalone a propósito
// (no importa lib/marketsnack.ts ni lib/sp500.ts) — mismo patrón que
// scripts/marketsnack-keepalive/keepalive.mjs: corre con `node` puro desde
// el Programador de tareas de Windows, sin pasar por Next ni TypeScript.
// Sí LEE data/sp500.json directo (la misma fuente que usa lib/sp500.ts para
// el buscador) para no duplicar 503 líneas a mano y no desincronizar las dos
// listas.
//
// Fuente de datos: MarketSnack `GET /api/assets/{ticker}` — YA calcula el %
// movido en la sesión extendida actual (`extended_price_change.percentage`)
// junto con qué sesión es (`extended_price_type`: "Pre-market" | "After
// hours"). Un solo campo, un solo endpoint por ticker — no hace falta pedir
// el cierre previo aparte ni tocar Massive (probado en vivo, ago 2026: el
// plan actual de Massive devuelve NOT_AUTHORIZED en TODOS los endpoints de
// snapshot, incluso el de un solo ticker — ver también la limitación ya
// documentada de `fetchBars`/`fetchDailyBars` atrasados ~1 día. MarketSnack
// es la única fuente confiable de precio en vivo en este proyecto).
//
// Uso: node scan.mjs   (o instalado como tarea programada, ver Instalar.ps1)

import { readFile, appendFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..");
const COOKIE_FILE = path.join(WEB_DIR, "data", "marketsnack-cookie.json");
const ENV_FILE = path.join(WEB_DIR, ".env.local");
const SP500_FILE = path.join(WEB_DIR, "lib", "pdf", "sp500.json"); // fuente compartida con lib/sp500.ts — NO está en data/ (gitignored)
const LOG_FILE = path.join(WEB_DIR, "data", "pdf", "premarket-movers.log");
const STATE_FILE = path.join(WEB_DIR, "data", "pdf", "premarket-movers.state.json");
const TITO_TELEGRAM = path.join(WEB_DIR, "data", "telegram.json");
// Corridas en hora de NUEVA YORK (las originales eran 8:15 y 8:30 hora de Texas).
// La tarea se dispara cada 5 min en una ventana LOCAL amplia y aquí se decide en ET,
// porque esta PC va en UTC-4 todo el año y Nueva York pasa a UTC-5 en noviembre.
const SLOTS_ET = [
  { id: "0915", from: 9 * 60 + 15, to: 9 * 60 + 25 },
  { id: "0930", from: 9 * 60 + 28, to: 9 * 60 + 40 },
];
const MAX_LOG_LINES = 2000;

const MOVE_THRESHOLD_PCT = 5;
const CONCURRENCY = 10;
const MAX_LISTED = 40; // tope de líneas en el mensaje — un día de crash real podría mover a decenas a la vez

async function loadEnvVar(name) {
  try {
    const raw = await readFile(ENV_FILE, "utf8");
    const m = raw.match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    // sin .env.local
  }
  return null;
}

async function loadTitoTelegram() {
  try {
    const j = JSON.parse(await readFile(TITO_TELEGRAM, "utf8"));
    return { token: typeof j.token === "string" ? j.token : null, chatId: j.alertChatId != null ? String(j.alertChatId) : null };
  } catch {
    return { token: null, chatId: null };
  }
}

function etNow(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), weekday: parts.weekday };
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { return { sent: {} }; }
}

async function loadCookie() {
  try {
    const raw = await readFile(COOKIE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.cookie === "string" && parsed.cookie.trim()) return parsed.cookie.trim();
  } catch {
    // sin archivo (o corrupto) — cae al respaldo de .env.local
  }
  return loadEnvVar("MARKETSNACK_COOKIE");
}

async function log(line) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  await appendFile(LOG_FILE, stamped, "utf8").catch(() => {});
  try {
    const s = await stat(LOG_FILE);
    if (s.size > 400_000) {
      const raw = await readFile(LOG_FILE, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length > MAX_LOG_LINES) {
        await writeFile(LOG_FILE, lines.slice(-MAX_LOG_LINES).join("\n") + "\n", "utf8");
      }
    }
  } catch {
    // no crítico
  }
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams({ chat_id: chatId, text }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram sendMessage falló: ${JSON.stringify(json)}`);
}

/** Corre `tasks` con como mucho `limit` en vuelo a la vez — sin dependencias nuevas. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchPremarketMove(cookie, ticker) {
  const res = await fetch(`https://app.marketsnack.com/api/assets/${encodeURIComponent(ticker)}`, {
    headers: { Accept: "application/json", Cookie: cookie },
    redirect: "manual",
  });
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new Error("SESION_EXPIRADA");
  }
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json) return null;
  if (json.extended_price_type !== "Pre-market") return null; // solo pre-market — no after-hours ni regular
  const pct = json.extended_price_change?.percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return { ticker, name: json.name ?? ticker, pct };
}

function fmtPct(pct) {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

async function main() {
  const now = new Date();
  const et = etNow(now);
  if (et.weekday === "Sat" || et.weekday === "Sun") return;
  const forced = process.argv.includes("--forzar");
  const slot = SLOTS_ET.find((s) => et.minutes >= s.from && et.minutes < s.to);
  const state = await loadState();
  const slotKey = slot ? `${et.date}-${slot.id}` : null;
  if (!forced && (!slot || state.sent?.[slotKey])) return; // fuera de ventana o ya enviado
  await mkdir(path.dirname(LOG_FILE), { recursive: true }).catch(() => {});

  const [cookie, token, chatId] = await Promise.all([
    loadCookie(),
    loadEnvVar("TELEGRAM_BOT_TOKEN"),
    loadEnvVar("TELEGRAM_CHAT_ID"),
  ]).then(async ([c, t, id]) => {
    if (t && id) return [c, t, id];
    const tito = await loadTitoTelegram();
    return [c, t ?? tito.token, id ?? tito.chatId];
  });

  if (!token || !chatId) {
    await log("SIN TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID en .env.local — no hay a quién avisar.");
    return;
  }
  if (!cookie) {
    await log("SIN COOKIE de MarketSnack — no se puede escanear.");
    await sendTelegram(
      token,
      chatId,
      "⚠ No pude revisar el pre-market: falta la cookie de MarketSnack. Actualízala en /ajustes.",
    ).catch(() => {});
    return;
  }

  let sp500;
  try {
    sp500 = JSON.parse(await readFile(SP500_FILE, "utf8"));
  } catch (err) {
    await log(`SIN data/sp500.json (${err instanceof Error ? err.message : String(err)}) — no se puede escanear.`);
    return;
  }

  await log(`Escaneando ${sp500.length} tickers del S&P 500…`);

  let sessionExpired = false;
  let errors = 0;
  const results = await mapWithConcurrency(sp500, CONCURRENCY, async (c) => {
    if (sessionExpired) return null;
    try {
      return await fetchPremarketMove(cookie, c.ticker);
    } catch (err) {
      if (err instanceof Error && err.message === "SESION_EXPIRADA") sessionExpired = true;
      else errors++;
      return null;
    }
  });

  if (sessionExpired) {
    await log("SESION DE MARKETSNACK EXPIRADA a mitad del escaneo.");
    await sendTelegram(
      token,
      chatId,
      "⚠ La sesión de MarketSnack venció mientras revisaba el pre-market. Actualízala en /ajustes.",
    ).catch(() => {});
    return;
  }

  const movers = results
    .filter((r) => r != null && Math.abs(r.pct) >= MOVE_THRESHOLD_PCT)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  await log(`Listo — ${movers.length} movimiento(s) ≥${MOVE_THRESHOLD_PCT}% (${errors} tickers con error, ignorados).`);

  const dateLabel = now.toLocaleDateString("es-ES", { timeZone: "America/Chicago", day: "numeric", month: "long" });
  let text;
  if (movers.length === 0) {
    text = `☀️ Pre-market ${dateLabel}: ningún ticker del S&P 500 se movió ±${MOVE_THRESHOLD_PCT}% hoy.`;
  } else {
    const shown = movers.slice(0, MAX_LISTED);
    const lines = shown.map((m) => `La ${m.name} (${m.ticker}) se ha movido ${fmtPct(m.pct)}`);
    const extra = movers.length > MAX_LISTED ? `\n… y ${movers.length - MAX_LISTED} más.` : "";
    text = `☀️ Pre-market ${dateLabel} — movimientos ≥${MOVE_THRESHOLD_PCT}%:\n\n${lines.join("\n")}${extra}`;
  }

  await sendTelegram(token, chatId, text);
  await log("Mensaje enviado a Telegram.");
  if (slotKey) {
    state.sent = { ...(state.sent ?? {}), [slotKey]: true };
    await writeFile(STATE_FILE, JSON.stringify(state), "utf8");
  }
}

main().catch(async (err) => {
  await log(`ERROR FATAL — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
