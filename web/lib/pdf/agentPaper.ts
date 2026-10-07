// ============================================================================
// Cuenta PAPER del "Agente Prueba de Fuego" (pedido del dueño, 2026-10-07: en
// Mis Trades, la pestaña "Swing" pasa a ser esta cuenta).
//
// Usa las MISMAS reglas que la cuenta 0DTE de Tito (lib/zerodtePaper.ts, puras y
// con tests): 2% de riesgo por operación (la prima pagada), trailing de ganancia,
// cierre por reloj a las 15:30 ET, enfriamiento de 5 min, límite de 1 pérdida al
// día y comisiones. Lo único propio es:
//   · las SEÑALES: el GEX Ticket + GEX Trade (vuelta al imán) del motor de Prueba
//     de Fuego (lib/pdf/odteStandalone/zerodte.ts), traducidos aquí al formato
//     ZeroDteTicket/ZeroDteTrade que entiende `planOpen`;
//   · el LIBRO, aparte: data/pdf/agente-paper/ (abiertas JSON + cerradas JSONL);
//   · la re-cotización de lo abierto, con el streamer de Tastytrade.
//
// El tick lo dispara scripts/pdf-alerts/paper-tick.ts cada minuto de sesión (desde
// la tarea de alertas SPX). Es el ÚNICO que escribe; la página solo lee.
// Nada de esto mueve dinero real.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import {
  closePosition, managePosition, planOpen, reprice, summarize,
  MAX_PERDIDAS_DIA, perdidasDelDia, pnlDelDia,
  type ZeroPaperPosition, type ZeroPaperSummary,
} from "@/lib/zerodtePaper";
import type { ZeroDteTicket, ZeroDteTrade } from "@/lib/zerodteSignals";
import { occSymbol } from "@/lib/chainSources";
import { sendAlert } from "@/lib/telegram";
import { zeroClosedText, zeroLimiteDiarioText, zeroOpenedText } from "@/lib/alertText";
import { intrinsicValue } from "@/lib/paperTrade";
import { closeOnDate, loadTfBars } from "@/lib/barSources";
import { cachedTfBars } from "@/lib/barsStore";
import { marketDateStr } from "@/lib/occ";
import { fetchQuoteToken } from "@/lib/tastytrade";
import { streamerFromOcc } from "./grandesEmpresasTasty";
import type { ZeroDteResult } from "./odteStandalone/zerodte";
import { riskReward } from "./odteStandalone/zerodteStrategy";

/** Ticker de la cuenta. SPY y no SPX: un contrato de SPX cuesta $500-2.000 y con
 *  $10.000 al 2% de riesgo casi nunca cabría ni uno. Mismo criterio que la de Tito. */
export const AGENT_PAPER_TICKER = "SPY";

const DIR = path.join(process.cwd(), "data", "pdf", "agente-paper");
const OPEN_FILE = path.join(DIR, "positions.json");
const CLOSED_FILE = path.join(DIR, "closed.jsonl");

/** Cabecera de los avisos, para no confundirlos con los del 0DTE de Tito. */
const ALERT_HEAD = "🔥 <b>Agente Prueba de Fuego</b> (paper)\n";

// ---------------------------------------------------------------------------
// Persistencia (mismo patrón que lib/zerodtePaperStore.ts)
// ---------------------------------------------------------------------------

export async function loadOpen(): Promise<ZeroPaperPosition[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(OPEN_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as ZeroPaperPosition[]) : [];
  } catch {
    return [];
  }
}

export async function loadClosed(): Promise<ZeroPaperPosition[]> {
  try {
    const raw = await fs.readFile(CLOSED_FILE, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as ZeroPaperPosition; } catch { return null; } })
      .filter((p): p is ZeroPaperPosition => p != null);
  } catch {
    return [];
  }
}

/** El libro de cerradas ANTES que las abiertas: ante un corte, mejor duplicada y visible que un cierre perdido. */
async function commit(open: ZeroPaperPosition[], justClosed: ZeroPaperPosition[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  if (justClosed.length > 0) {
    await fs.appendFile(CLOSED_FILE, justClosed.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");
  }
  const tmp = `${OPEN_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(open, null, 2), "utf8");
  await fs.rename(tmp, OPEN_FILE);
}

// ---------------------------------------------------------------------------
// Señales de Prueba de Fuego → formato de `planOpen`
// ---------------------------------------------------------------------------

/** GEX Trade (vuelta al imán) de Prueba de Fuego → ZeroDteTrade. */
export function toTrade(r: ZeroDteResult): ZeroDteTrade | null {
  const e = r.entry;
  if (!e) return null;
  return {
    model: "magnet",
    side: e.direction === "long" ? "LONG" : "SHORT",
    entry: e.entry,
    target: e.target,
    stop: e.stop,
    reward: Math.abs(e.target - e.entry),
    risk: Math.abs(e.entry - e.stop),
    rr: riskReward(e),
    rationale: e.reason,
  };
}

/** GEX Ticket de Prueba de Fuego → ZeroDteTicket (con su símbolo OCC). */
export function toTicket(r: ZeroDteResult): ZeroDteTicket | null {
  const t = r.ticket;
  if (!t || !(t.mid > 0)) return null;
  return {
    optionSymbol: occSymbol(r.analysisTicker, r.expiration, t.type, t.strike),
    type: t.type,
    strike: t.strike,
    delta: t.delta,
    bid: t.bid,
    ask: t.ask,
    mid: t.mid,
    spreadPct: t.spreadPct,
    volume: t.volume,
    openInterest: t.oi,
    cost: t.cost,
    targetPrice: t.targetPx,
    targetGain: (t.targetPx - t.mid) * 100,
    stopLoss: (t.stopPx - t.mid) * 100,
    liquidity: t.spreadPct <= 5 ? "buena" : t.spreadPct <= 10 ? "justa" : "pobre",
    rationale: r.entry?.reason ?? "",
  };
}

/** Mid actual de los contratos abiertos, por el streamer de Tastytrade. */
async function quoteOpen(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pairs = symbols.map((s) => [s, streamerFromOcc(s)] as const).filter((p): p is readonly [string, string] => !!p[1]);
  if (pairs.length === 0) return out;
  const tok = await fetchQuoteToken();
  const { dxlinkSnapshot } = await import("@/lib/tastytradeStream");
  const snap = await dxlinkSnapshot({ url: tok.url, token: tok.token, symbols: pairs.map((p) => p[1]), timeoutMs: 8000 });
  for (const [occ, st] of pairs) {
    const f = snap.get(st);
    if (f?.bid != null && f?.ask != null && f.bid >= 0 && f.ask > 0) out.set(occ, (f.bid + f.ask) / 2);
    else if (f?.last != null && f.last > 0) out.set(occ, f.last);
  }
  return out;
}

async function cierreDelVencimiento(ticker: string, expiration: string): Promise<number | null> {
  try {
    const { bars } = await cachedTfBars(ticker, "1y", () => loadTfBars(ticker, "1y"));
    return closeOnDate(bars, expiration);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// El tick
// ---------------------------------------------------------------------------

export interface AgentTickResult {
  open: ZeroPaperPosition[];
  justClosed: ZeroPaperPosition[];
  summary: ZeroPaperSummary;
  blocked: string;
  notes: string[];
}

/**
 * Un ciclo: re-cotiza lo abierto, aplica las reglas y abre si toca. `result` es
 * el análisis de Prueba de Fuego de ESTE minuto para AGENT_PAPER_TICKER.
 */
export async function tickAgentPaper(input: {
  result: ZeroDteResult;
  minutesLeft: number;
  sessionOpen: boolean;
  now: Date;
}): Promise<AgentTickResult> {
  const { result, now } = input;
  const ticker = result.ticker;
  const prevOpen = await loadOpen();
  const closedBook = await loadClosed();
  const prices = await quoteOpen(prevOpen.map((p) => p.optionSymbol)).catch(() => new Map<string, number>());

  const stillOpen: ZeroPaperPosition[] = [];
  const justClosed: ZeroPaperPosition[] = [];
  const notes: string[] = [];
  const hoy = marketDateStr(now);

  for (const p0 of prevOpen) {
    const p = reprice(p0, prices.get(p0.optionSymbol) ?? null);
    // Ya vencida: se liquida a intrínseco contra el cierre del día del vencimiento.
    if (p.expiration < hoy) {
      const cierre = await cierreDelVencimiento(p.ticker, p.expiration);
      if (cierre == null) {
        notes.push(`${p.optionSymbol}: venció el ${p.expiration} y no hay cierre de ese día para liquidarla. Se mantiene.`);
        stillOpen.push(p);
        continue;
      }
      const valor = intrinsicValue(p.type, p.strike, cierre);
      justClosed.push(closePosition(reprice(p, valor), "cierre_de_sesion", now));
      notes.push(`${p.optionSymbol}: vencida, liquidada a intrínseco ${valor.toFixed(2)} (subyacente ${cierre.toFixed(2)}).`);
      continue;
    }
    if (p.ticker !== ticker || result.spot == null) { stillOpen.push(p); continue; }
    const d = managePosition(p, result.spot, input.minutesLeft, input.sessionOpen);
    if (d.action === "cerrar" && d.reason) justClosed.push(closePosition(p, d.reason, now));
    else stillOpen.push(p);
  }

  const cerradas = [...closedBook, ...justClosed];
  const ticket = result.isToday ? toTicket(result) : null;
  const trade = result.isToday ? toTrade(result) : null;
  const plan = planOpen({
    ticker,
    expiration: result.expiration,
    ticket,
    trade,
    spot: result.spot ?? 0,
    equity: summarize(cerradas, stillOpen).equity,
    open: stillOpen,
    closed: cerradas,
    minutesLeft: input.minutesLeft,
    sessionOpen: input.sessionOpen && result.isToday,
    now,
  });
  if (plan.position) stillOpen.push({ ...plan.position, id: `PDF-${now.getTime()}` });

  const changed =
    justClosed.length > 0 || plan.position != null || prevOpen.length !== stillOpen.length ||
    stillOpen.some((p, i) => p.currentPrice !== prevOpen[i]?.currentPrice);
  if (changed) await commit(stillOpen, justClosed);

  const resumen = summarize(cerradas, stillOpen);

  // Avisos best-effort, DESPUÉS de guardar.
  if (plan.position) {
    const abierta = stillOpen[stillOpen.length - 1];
    const suTicket = ticket && ticket.optionSymbol === abierta.optionSymbol ? ticket : null;
    void sendAlert(ALERT_HEAD + zeroOpenedText(abierta, resumen.equity, suTicket)).catch(() => null);
  }
  for (const c of justClosed) void sendAlert(ALERT_HEAD + zeroClosedText(c, resumen.equity)).catch(() => null);
  const perdidasAntes = perdidasDelDia(closedBook, now);
  const perdidasAhora = perdidasDelDia(cerradas, now);
  if (perdidasAntes < MAX_PERDIDAS_DIA && perdidasAhora >= MAX_PERDIDAS_DIA) {
    notes.push(`Límite diario alcanzado: ${perdidasAhora} pérdida(s) hoy.`);
    void sendAlert(ALERT_HEAD + zeroLimiteDiarioText(perdidasAhora, pnlDelDia(cerradas, now), resumen.equity)).catch(() => null);
  }

  return { open: stillOpen, justClosed, summary: resumen, blocked: plan.blocked, notes };
}
