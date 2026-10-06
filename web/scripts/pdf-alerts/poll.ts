// Alerta en vivo de las 3 señales GEX (0DTE, SPX) por Telegram — pedido
// explícito (2026-08-30): primero solo el "GEX Ticket", después
// ampliado a las 3: "de esos 3 enviame el mensaje, cualquiera que se active
// de los 3 o los 3". Mismo patrón que scripts/cv3-live-alert/poll.ts: corre
// cada minuto en horario de mercado, sin motor aparte — importa
// `fetchZeroDte` (lib/odteStandalone/zerodte.ts, el MISMO motor que arma la
// pestaña "0DTE") y replica la MISMA lógica de agregación que ya usa
// OdteStandaloneTab.tsx para las 3 tarjetas:
//
//   1. GEX Ticket             — result.ticket (contrato concreto sugerido)
//   2. GEX Trade               — result.entry (pin-al-imán, γ+)
//   3. GEX Trade · alternate   — altTradeState(altCtx, result.entry, momentumEntry)
//      (γ+ fade = igual al original; γ− momentum = objetivo el muro real).
//      El contexto de flujo (velocidad/CVD) que la UI acumula en el navegador
//      mientras la pestaña está abierta, acá se acumula en
//      data/odte-standalone/ticket-alert/{TICKER}.json entre corridas (mismo
//      cálculo que el `vol` useMemo de la página, una muestra por minuto).
//
// Cada una de las 3 manda su PROPIO mensaje, independiente de las otras —
// "cualquiera que se active" — y su propio aviso cuando la entrada
// desaparece ("esperando una nueva entrada"). Solo avisa cuando la
// IDENTIDAD del setup cambia de verdad (no en cada minuto por el precio
// moviéndose dentro del mismo contrato/target).

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import type { AltFlowCtx } from "../../lib/pdf/odteStandalone/zerodteAlt";

const WEB_DIR = process.cwd();
const envPath = join(WEB_DIR, ".env.local");
for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx === -1) continue;
  const key = line.slice(0, idx).trim();
  let val = line.slice(idx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  process.env[key] = val;
}

const TICKER = process.argv[2]?.toUpperCase() ?? "SPX";
const STATE_DIR = join(WEB_DIR, "data", "pdf", "odte-standalone", "ticket-alert");
const STATE_FILE = join(STATE_DIR, `${TICKER.replace(/[^A-Z0-9]/gi, "")}.json`);
const LOG_FILE = join(WEB_DIR, "data", "pdf", "odte-standalone", "ticket-alert.log");
const VOL_WINDOW = 24; // mismo tope que volSeries en la página (≈24 min de historia a 1 muestra/min)

function log(line: string) {
  const stamped = `${new Date().toISOString()} [${TICKER}] ${line}\n`;
  process.stdout.write(stamped);
  try {
    mkdirSync(join(WEB_DIR, "data", "pdf", "odte-standalone"), { recursive: true });
    appendFileSync(LOG_FILE, stamped, "utf8");
  } catch {
    // no crítico
  }
}

/** Credenciales de Telegram: .env.local (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) o, si no
 *  están, las que Tito ya guarda en data/telegram.json (token + alertChatId). */
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
  const json: any = await res.json().catch(() => ({}));
  if (!json.ok) log(`Telegram sendMessage falló: ${JSON.stringify(json)}`);
}

interface VolSample { t: number; tape: number; cvd: number }
interface State {
  lastTicketKey: string | null;
  lastTradeKey: string | null;
  lastAltKey: string | null;
  volSeries: VolSample[];
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { lastTicketKey: null, lastTradeKey: null, lastAltKey: null, volSeries: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { lastTicketKey: null, lastTradeKey: null, lastAltKey: null, volSeries: [], ...s };
  } catch {
    return { lastTicketKey: null, lastTradeKey: null, lastAltKey: null, volSeries: [] };
  }
}

function saveState(s: State) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  const { isMarketOpen, isFuturesMarketOpen } = await import("../../lib/pdf/marketHours");
  const { isNativeFuture, loadNativeFuture, nativeFresh, futureStoreKey } = await import("../../lib/pdf/odteStandalone/futuresNative");
  const now = new Date();
  // /ES y /NQ cotizan CME casi 24/5 (el motor intenta su cadena de futuro NATIVA
  // primero, con basis=0, antes de caer al respaldo SPX/NDX+basis) — usar
  // isMarketOpen (solo RTH) los dejaría sin avisar toda la sesión nocturna real.
  const marketOpen = isNativeFuture(TICKER) ? isFuturesMarketOpen(now) : isMarketOpen(now);
  if (!marketOpen) {
    log("Mercado cerrado — no se consulta.");
    return;
  }

  const { fetchZeroDte, resolveTicker } = await import("../../lib/pdf/odteStandalone/zerodte");
  const { marketDateStr } = await import("../../lib/pdf/odteStandalone/occ");
  const { loadFlow } = await import("../../lib/pdf/odteStandalone/zerodteFlow");
  const { gammaWalls, momentumEntry, altTradeState } = await import("../../lib/pdf/odteStandalone/zerodteAlt");
  const { riskReward } = await import("../../lib/pdf/odteStandalone/zerodteStrategy");

  const result = await fetchZeroDte(TICKER, now);
  const state = loadState();

  // -------------------------------------------------------- flow snapshot
  // MISMA lógica que app/api/odte-standalone/flow/route.ts (no un motor
  // aparte): agresor acumulado del día + "contratos entrantes" que ya
  // escribe el streamer. Necesario para el contexto de flujo de la #3.
  const date = marketDateStr(now);
  let buyAggr = 0, sellAggr = 0, midAggr = 0;
  let topTrades: any[] = [];
  try {
    const nativeFut = isNativeFuture(TICKER) ? TICKER : null;
    let acc: any;
    if (nativeFut) {
      const nf = await loadNativeFuture(nativeFut, date);
      acc = nativeFresh(nf) ? nf!.acc : await loadFlow(resolveTicker(nativeFut).analysis, date);
    } else {
      acc = await loadFlow(resolveTicker(TICKER).analysis, date);
    }
    for (const b of Object.values(acc.buckets) as any[]) {
      buyAggr += b.ask || 0; sellAggr += b.bid || 0; midAggr += b.mid || 0;
    }
    topTrades = Array.isArray(acc.topTrades) ? acc.topTrades : [];
  } catch {
    // sin flujo: la #3 queda sin confirmación de flujo (ctx con valores neutros)
  }

  // Sesgo direccional del premium agresivo (aperturas si hay, si no todos los
  // takers) — MISMA fórmula que ttBull/ttBear en OdteStandaloneTab.tsx.
  const takers = topTrades.filter((t) => t.side === "buy" || t.side === "sell");
  const opensAgg = takers.filter((t) => t.open);
  const sig = opensAgg.length ? opensAgg : takers;
  let ttBull = 0, ttBear = 0;
  for (const t of sig) {
    const isBull = (t.type === "call" && t.side === "buy") || (t.type === "put" && t.side === "sell");
    const isBear = (t.type === "put" && t.side === "buy") || (t.type === "call" && t.side === "sell");
    if (isBull) ttBull += t.premium; else if (isBear) ttBear += t.premium;
  }

  // Velocidad + CVD: rolling window persistida entre corridas (mismo cálculo
  // que el `vol` useMemo de la página, una muestra por corrida ≈ 1/min).
  const tape = buyAggr + sellAggr + midAggr;
  const cvdNow = buyAggr - sellAggr;
  const series = [...state.volSeries];
  const last = series[series.length - 1];
  if (!last || last.tape !== tape || last.cvd !== cvdNow) {
    series.push({ t: now.getTime(), tape, cvd: cvdNow });
    if (series.length > VOL_WINDOW) series.shift();
  }
  let velocity: number | null = null;
  if (series.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < series.length; i++) deltas.push(Math.max(0, series[i].tape - series[i - 1].tape));
    const cur = deltas[deltas.length - 1] ?? 0;
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length || 1;
    velocity = avg > 0 ? cur / avg : 0;
  }
  const cvdTot = buyAggr + sellAggr;
  const cvdDom = cvdTot > 0 ? Math.abs(buyAggr - sellAggr) / cvdTot : null;

  log(`spot=${result.spot ?? "-"} ticket=${result.ticket ? `${result.ticket.type}:${result.ticket.strike}` : "null"} entry=${result.entry ? `${result.entry.direction}:${result.entry.target}` : "null"} regime=${result.gex.regime}`);

  // ============================================================ 1. TICKET
  const ticket = result.ticket;
  const ticketKey = ticket ? `${ticket.type}:${ticket.strike}` : null;
  if (ticketKey !== state.lastTicketKey) {
    if (ticketKey == null) {
      const why = result.noSetup ? ` (${result.noSetup})` : "";
      await sendTelegram(`ℹ️ ${TICKER} — GEX Ticket: la entrada anterior ya no se sostiene${why}. Esperando una nueva entrada.`);
    } else if (ticket) {
      await sendTelegram([
        `${ticket.type === "call" ? "🟢" : "🔴"} ${TICKER} — GEX Ticket: nueva entrada`,
        `${ticket.type === "call" ? "CALL" : "PUT"} ${ticket.strike}`,
        `Entrada (mid): $${ticket.mid.toFixed(2)}  ·  Bid $${ticket.bid.toFixed(2)} / Ask $${ticket.ask.toFixed(2)}`,
        `Target: $${ticket.targetPx.toFixed(2)}  ·  Stop: $${ticket.stopPx.toFixed(2)}  ·  R:B ${ticket.rbOption.toFixed(2)}x`,
        `Costo: $${Math.round(ticket.cost).toLocaleString("en-US")} por contrato  ·  Riesgo: $${Math.round(ticket.risk).toLocaleString("en-US")}`,
        `Delta ${ticket.delta.toFixed(2)}  ·  Volumen ${ticket.volume.toLocaleString("en-US")}  ·  OI ${ticket.oi.toLocaleString("en-US")}`,
        `Spot: $${result.spot?.toFixed(2) ?? "-"}`,
      ].join("\n"));
    }
  }

  // ========================================================== 2. GEX TRADE
  const entry = result.entry;
  const tradeKey = entry ? `${entry.direction}:${round1(entry.target)}` : null;
  if (tradeKey !== state.lastTradeKey) {
    if (tradeKey == null) {
      await sendTelegram(`ℹ️ ${TICKER} — GEX Trade: la entrada anterior ya no se sostiene. Esperando una nueva entrada.`);
    } else if (entry) {
      await sendTelegram([
        `${entry.direction === "long" ? "🟢" : "🔴"} ${TICKER} — GEX Trade: nueva entrada`,
        entry.direction === "long" ? "LONG (vuelta al imán)" : "SHORT (vuelta al imán)",
        `Entrada: $${entry.entry.toFixed(2)}  ·  Target: $${entry.target.toFixed(2)}  ·  Stop: $${entry.stop.toFixed(2)}`,
        `R:B: ${riskReward(entry).toFixed(2)}x`,
        entry.reason,
      ].join("\n"));
    }
  }

  // ================================================ 3. GEX TRADE ALTERNATE
  const altCtx: AltFlowCtx = {
    regime: result.gex.regime,
    cvd: series.length ? cvdNow : null,
    cvdDom,
    velocity,
    burstBull: ttBull,
    burstBear: ttBear,
    netGex: result.gex.totalNetGex,
    spot: result.spot ?? 0,
    magnet: result.gex.kingStrike,
    sigma: result.forecast?.sigma ?? null,
  };
  const walls = result.spot != null ? gammaWalls(result.gex.nodes, result.spot) : { callWall: null, putWall: null };
  const altMomentum = result.isToday && result.gex.regime === "negative"
    ? momentumEntry(altCtx, walls.callWall, walls.putWall, result.gex.flipStrike, undefined, "es")
    : null;
  const altState = result.spot != null ? altTradeState(altCtx, entry, altMomentum) : null;
  const altTrade = altState?.trade ?? null;
  const altKey = altTrade ? `${altTrade.direction}:${round1(altTrade.target)}:${altState?.isMomentum ? "mom" : "fade"}` : null;
  if (altKey !== state.lastAltKey) {
    if (altKey == null) {
      await sendTelegram(`ℹ️ ${TICKER} — GEX Trade Alternate: la entrada anterior ya no se sostiene. Esperando una nueva entrada.`);
    } else if (altTrade) {
      const modeWord = altState?.isMomentum ? "momentum γ−" : "fade γ+";
      await sendTelegram([
        `${altTrade.direction === "long" ? "🟢" : "🔴"} ${TICKER} — GEX Trade Alternate (${modeWord}): nueva entrada`,
        altTrade.direction === "long" ? "LONG" : "SHORT",
        `Entrada: $${altTrade.entry.toFixed(2)}  ·  Target: $${altTrade.target.toFixed(2)}  ·  Stop: $${altTrade.stop.toFixed(2)}`,
        `R:B: ${riskReward(altTrade).toFixed(2)}x  ·  Nivel: ${altState?.tier ?? "-"}`,
        altTrade.reason,
      ].join("\n"));
    }
  }

  saveState({ lastTicketKey: ticketKey, lastTradeKey: tradeKey, lastAltKey: altKey, volSeries: series });
}

main().catch((err) => {
  const msg = `ERROR: ${err?.stack ?? err}`;
  process.stderr.write(msg + "\n");
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [${TICKER}] ${msg}\n`, "utf8"); } catch {}
  process.exit(1);
});
