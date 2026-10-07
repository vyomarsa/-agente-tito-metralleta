// Alerta diaria de pre-market por Telegram: qué empresas del S&P 500 se mueven
// ±5% en el pre-market. Corre a las 9:15 y 9:30 hora de Nueva York (una vez cada
// una por día); la tarea se dispara cada 5 min en una ventana LOCAL amplia y aquí
// se decide en ET, porque esta PC va en UTC-4 todo el año y Nueva York pasa a
// UTC-5 en noviembre.
//
// Fuentes: MarketSnack PRIMERO — su /api/assets ya trae el % de pre-market de las
// ~500 (medido 2026-10-07 6:13 ET: 498/503). Tastytrade solo de RESPALDO si no
// hay cookie o venció: medido a la misma hora, sus horquillas de pre-market eran
// del 3-10% (las 4 movers quedaban fuera, y el mid de PPG daba −2% cuando
// MarketSnack daba +13%). Tastytrade usa UNA conexión DXLink con Quote + Summary
// (cierre de ayer); el `Trade` de dxFeed es solo de la sesión regular, así que el
// precio es el MID, descartando horquillas > MAX_SPREAD_PCT.
//
// Uso:
//   tsx scripts/pdf-alerts/premarket-scan.ts            → solo dentro de su ventana
//   tsx scripts/pdf-alerts/premarket-scan.ts --forzar   → manda ya
//   tsx scripts/pdf-alerts/premarket-scan.ts --prueba   → escanea ya e IMPRIME, no manda

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";

const WEB_DIR = process.cwd();
for (const rawLine of readFileSync(join(WEB_DIR, ".env.local"), "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx === -1) continue;
  let val = line.slice(idx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  process.env[line.slice(0, idx).trim()] = val;
}

const DATA_DIR = join(WEB_DIR, "data", "pdf");
const LOG_FILE = join(DATA_DIR, "premarket-movers.log");
const STATE_FILE = join(DATA_DIR, "premarket-movers.state.json");
const SLOTS_ET = [
  { id: "0915", from: 9 * 60 + 15, to: 9 * 60 + 25 },
  { id: "0930", from: 9 * 60 + 28, to: 9 * 60 + 40 },
];
const MOVE_THRESHOLD_PCT = 5;
/** Horquilla máxima (% del mid) para fiarse del precio de pre-market: con 2% el
 *  mid yerra como mucho ±1%, suficiente para un umbral de ±5%. */
const MAX_SPREAD_PCT = 2;
const MAX_LISTED = 40; // un día de crash real podría mover a decenas a la vez

const forced = process.argv.includes("--forzar");
const dryRun = process.argv.includes("--prueba");

function log(line: string) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(stamped);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_FILE, stamped, "utf8");
  } catch {
    // no crítico
  }
}

function telegramCreds(): { token: string | null; chatId: string | null } {
  let token = process.env.TELEGRAM_BOT_TOKEN || null;
  let chatId = process.env.TELEGRAM_CHAT_ID || null;
  if (!token || !chatId) {
    try {
      const j = JSON.parse(readFileSync(join(WEB_DIR, "data", "telegram.json"), "utf8"));
      token = token ?? (typeof j.token === "string" ? j.token : null);
      chatId = chatId ?? (j.alertChatId != null ? String(j.alertChatId) : null);
    } catch {
      // sin archivo de Tito
    }
  }
  return { token, chatId };
}

async function sendTelegram(text: string) {
  if (dryRun) {
    log(`[--prueba] NO se envía. Mensaje:\n${text}`);
    return;
  }
  const { token, chatId } = telegramCreds();
  if (!token || !chatId) {
    log("SIN credenciales de Telegram (.env.local ni data/telegram.json de Tito) — no se avisa.");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams({ chat_id: chatId, text }),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean };
  if (!json.ok) throw new Error(`Telegram sendMessage falló: ${JSON.stringify(json)}`);
}

function etNow(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    weekday: parts.weekday,
  };
}

function loadState(): { sent: Record<string, boolean> } {
  if (!existsSync(STATE_FILE)) return { sent: {} };
  try {
    return { sent: {}, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return { sent: {} };
  }
}

type Company = { ticker: string; name: string };
type Mover = { ticker: string; name: string; pct: number };
type Scan = { movers: Mover[]; quoted: number; skipped: number; source: "MarketSnack" | "Tastytrade" };

function loadCookie(): string | null {
  try {
    const j = JSON.parse(readFileSync(join(WEB_DIR, "data", "marketsnack-cookie.json"), "utf8"));
    if (j && typeof j.cookie === "string" && j.cookie.trim()) return j.cookie.trim();
  } catch {
    // sin archivo: respaldo .env.local
  }
  return process.env.MARKETSNACK_COOKIE?.trim() || null;
}

/** MarketSnack `/api/assets/{t}`: ya trae el % de la sesión extendida y qué sesión es. */
async function scanMarketSnack(companies: Company[], cookie: string): Promise<Scan> {
  log(`Escaneando ${companies.length} tickers del S&P 500 (MarketSnack)…`);
  let expired = false;
  let quoted = 0;
  let skipped = 0;
  const movers: Mover[] = [];
  let next = 0;
  async function worker() {
    while (next < companies.length && !expired) {
      const c = companies[next++];
      try {
        const res = await fetch(`https://app.marketsnack.com/api/assets/${encodeURIComponent(c.ticker)}`, {
          headers: { Accept: "application/json", Cookie: cookie },
          redirect: "manual",
        });
        if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) { expired = true; return; }
        const j = res.ok ? ((await res.json().catch(() => null)) as { extended_price_type?: string; extended_price_change?: { percentage?: number } } | null) : null;
        const pct = j?.extended_price_type === "Pre-market" ? j.extended_price_change?.percentage : undefined;
        if (typeof pct !== "number" || !Number.isFinite(pct)) { skipped++; continue; }
        quoted++;
        if (Math.abs(pct) >= MOVE_THRESHOLD_PCT) movers.push({ ticker: c.ticker, name: c.name, pct });
      } catch {
        skipped++;
      }
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  if (expired) throw new Error("sesión de MarketSnack vencida — actualiza la cookie en Ajustes");
  return { movers, quoted, skipped, source: "MarketSnack" };
}

/**
 * Tastytrade: UNA conexión DXLink. Precio de pre-market = MID del bid/ask (el
 * Trade de dxFeed es solo de la sesión regular), descartando horquillas anchas.
 */
async function scanTastytrade(companies: Company[]): Promise<Scan> {
  const { fetchQuoteToken } = await import("../../lib/tastytrade");
  const { dxlinkUnderlyings } = await import("../../lib/tastytradeStream");
  const toStreamer = (t: string) => t.replace(/[.]/g, "/");
  const byStreamer = new Map(companies.map((c) => [toStreamer(c.ticker), c]));
  log(`Escaneando ${companies.length} tickers del S&P 500 (Tastytrade)…`);
  const tok = await fetchQuoteToken();
  const snap = await dxlinkUnderlyings({ url: tok.url, token: tok.token, symbols: [...byStreamer.keys()], timeoutMs: 30_000, quietMs: 2_000 });
  let quoted = 0;
  let skipped = 0;
  const movers: Mover[] = [];
  for (const [sym, f] of snap) {
    const c = byStreamer.get(sym);
    if (!c || f.bid == null || f.ask == null || !(f.bid > 0) || !(f.ask >= f.bid) || f.prevClose == null) { skipped++; continue; }
    const mid = (f.bid + f.ask) / 2;
    if (((f.ask - f.bid) / mid) * 100 > MAX_SPREAD_PCT) { skipped++; continue; }
    quoted++;
    const pct = ((mid - f.prevClose) / f.prevClose) * 100;
    if (Math.abs(pct) >= MOVE_THRESHOLD_PCT) movers.push({ ticker: c.ticker, name: c.name, pct });
  }
  return { movers, quoted, skipped, source: "Tastytrade" };
}

async function main() {
  const now = new Date();
  const et = etNow(now);
  const slot = SLOTS_ET.find((s) => et.minutes >= s.from && et.minutes < s.to);
  const state = loadState();
  const slotKey = slot ? `${et.date}-${slot.id}` : null;
  if (!forced && !dryRun) {
    if (et.weekday === "Sat" || et.weekday === "Sun") return;
    if (!slot || (slotKey && state.sent[slotKey])) return; // fuera de ventana o ya enviado
  }

  const { SP500 } = await import("../../lib/pdf/sp500");

  // FUENTE PRIMARIA = MarketSnack (cubre las ~500 aunque coticen con horquilla
  // ancha); si no hay cookie o venció, RESPALDO automático = Tastytrade.
  let scan: Scan | null = null;
  const cookie = loadCookie();
  if (cookie) {
    scan = await scanMarketSnack(SP500, cookie).catch((err) => {
      log(`MarketSnack no sirvió (${err instanceof Error ? err.message : String(err)}) — paso a Tastytrade.`);
      return null;
    });
  } else {
    log("Sin cookie de MarketSnack — uso Tastytrade.");
  }
  if (!scan || scan.quoted === 0) {
    try {
      scan = await scanTastytrade(SP500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR de Tastytrade — ${msg}`);
      await sendTelegram(`⚠ No pude revisar el pre-market: ni MarketSnack ni Tastytrade respondieron (${msg.slice(0, 120)}).`).catch(() => {});
      return;
    }
  }
  const { movers, quoted, source } = scan;
  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  log(`Listo (${source}) — ${quoted} con dato de pre-market, ${scan.skipped} sin dato/ignorados, ${movers.length} movimiento(s) ≥${MOVE_THRESHOLD_PCT}%.`);

  if (quoted === 0) {
    await sendTelegram("⚠ No pude revisar el pre-market: ninguna fuente devolvió datos usables.").catch(() => {});
    return;
  }

  const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
  const dateLabel = now.toLocaleDateString("es-ES", { timeZone: "America/New_York", day: "numeric", month: "long" });
  let text: string;
  if (movers.length === 0) {
    text = `☀️ Pre-market ${dateLabel}: ningún ticker del S&P 500 se movió ±${MOVE_THRESHOLD_PCT}% hoy.`;
  } else {
    const shown = movers.slice(0, MAX_LISTED);
    const lines = shown.map((m) => `La ${m.name} (${m.ticker}) se ha movido ${fmtPct(m.pct)}`);
    const extra = movers.length > MAX_LISTED ? `\n… y ${movers.length - MAX_LISTED} más.` : "";
    text = `☀️ Pre-market ${dateLabel} — movimientos ≥${MOVE_THRESHOLD_PCT}%:\n\n${lines.join("\n")}${extra}`;
  }

  await sendTelegram(text);
  if (!dryRun) {
    log("Mensaje enviado a Telegram.");
    if (slotKey) {
      state.sent = { ...state.sent, [slotKey]: true };
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
    }
  }
}

main().catch((err) => {
  log(`ERROR FATAL — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
