// GET /api/0dte?ticker=SPY — Cadena 0DTE (cero días al vencimiento) en JSON.
//
// El ensamblaje del análisis y las señales vive en `lib/zerodteScan.ts`, que es
// copia ÚNICA compartida con el disparador de la cuenta de paper. Aquí solo se le
// añade lo que es de PANTALLA y el cron no necesita: el Time & Sales (cinta,
// agresor y sesgo alterno) y el marcador alterno-vs-original.
//
// Es UNA sola llamada por refresco a propósito: cadena, flujo, señales, marcador
// y cuenta de paper se calculan juntos porque todos tienen que apuntar
// exactamente lo que la pantalla enseña.

import { MassiveError } from "@/lib/massive";
import { fetchTickerFlow } from "@/lib/flowSources";
import { MarketSnackError } from "@/lib/marketsnack";
import { classifyFlow } from "@/lib/flow";
import { aggressorReads } from "@/lib/zerodte";
import { buildTape, emptyTape } from "@/lib/zerodteTape";
import { gexBias } from "@/lib/zerodteSignals";
import { ALLOWED, scanZeroDte, ZeroDteScanError } from "@/lib/zerodteScan";
import {
  BIAS_MINUTES, gradeBook, loadLiveBook, recordBias, recordTrade, saveLiveBook, scoreboard,
} from "@/lib/zerodteLiveStore";
import { saveZeroDtePrediction } from "@/lib/zerodteStore";
import { tickZeroPaper } from "@/lib/zerodtePaperStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Piso de prima para la cinta: el 0DTE mueve tickets chicos, así que va bajo. */
const FLOW_MIN_PREMIUM = 25_000;
const FLOW_MAX_PAGES = 6;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  const requestedExp = (searchParams.get("exp") ?? "").trim(); // YYYY-MM-DD opcional

  if (!ALLOWED.has(ticker)) {
    return Response.json({ error: `0DTE soportado solo para: ${[...ALLOWED].join(", ")}.` }, { status: 400 });
  }

  const now = new Date();

  try {
    // El flujo va en paralelo con el análisis: es best-effort y no debe alargar
    // la respuesta si el Time & Sales tarda.
    const [scan, flowRaw] = await Promise.all([
      scanZeroDte(ticker, requestedExp, now),
      fetchTickerFlow(ticker, {
        period: "1d", days: 1, minPremium: FLOW_MIN_PREMIUM, maxPages: FLOW_MAX_PAGES,
        // La cinta del día solo mira el vencimiento de hoy y el siguiente: pedir los
        // 8 de siempre multiplicaría por cuatro los símbolos que escucha el streamer.
        expirations: 2,
      })
        .then((f) => f.trades)
        .catch(() => []),
    ]);

    const { analysis, expiration, isToday, sessionOpen, minutesLeft, spot } = scan;

    // ── Cinta del día (CVD, velocidad, bloques) + agresor por prima ──
    const flowRows = flowRaw.length > 0 ? classifyFlow(flowRaw, now).rows : [];
    const tape = flowRows.length > 0 ? buildTape(flowRows, expiration, now, sessionOpen) : emptyTape();
    const reads = flowRows.length > 0 ? aggressorReads(flowRows, expiration) : [];
    let bullish = 0, bearish = 0;
    for (const r of reads) {
      if (r.side === "mixto") continue;
      const isBull = (r.type === "call" && r.side === "compra") || (r.type === "put" && r.side === "venta");
      if (isBull) bullish += r.premium; else bearish += r.premium;
    }

    // Los sesgos necesitan el peso del flujo, así que se quedan aquí.
    const bias = gexBias(analysis, BIAS_MINUTES, { model: "original" });
    const biasAlt = gexBias(analysis, BIAS_MINUTES, { model: "alterno", flowWeight: tape.weight });

    // ── Marcador en vivo: apunta lo que se enseña y corrige lo vencido ──
    let score = null;
    try {
      const book = await loadLiveBook(ticker, now);
      gradeBook(book, spot, now, sessionOpen);
      if (isToday) {
        recordBias(book, bias, now, sessionOpen);
        recordBias(book, biasAlt, now, sessionOpen);
        if (scan.trade.trade) recordTrade(book, scan.trade.trade, now, sessionOpen);
        if (scan.tradeAlt.trade) recordTrade(book, scan.tradeAlt.trade, now, sessionOpen);
      }
      score = scoreboard(book);
      await saveLiveBook(book);
    } catch {
      score = null; // el marcador nunca debe tumbar la vista
    }

    // ── Cuenta de paper ──
    // También corre sola por tarea programada (POST /api/0dte-paper). Que se
    // dispare TAMBIÉN aquí no duplica nada: el tick es idempotente por minuto y
    // así la cuenta avanza igual con la página abierta que sin ella.
    let paper = null;
    if (isToday) {
      try {
        const r = await tickZeroPaper({
          ticker, expiration, spot, minutesLeft, sessionOpen, now,
          ticket: scan.ticket,
          trade: scan.activeTrade,
          priceOf: scan.priceOf,
        });
        paper = { summary: r.summary, open: r.open, blocked: r.blocked, justClosed: r.justClosed.length };
      } catch {
        paper = null;
      }
    }

    // Foto para la memoria (solo el vencimiento de HOY; best-effort).
    if (isToday) {
      void saveZeroDtePrediction(ticker, {
        spot,
        base: analysis.scenarios.base.target,
        bull: analysis.scenarios.bull.target,
        bear: analysis.scenarios.bear.target,
        lean: analysis.lean,
        confidence: analysis.confidence,
      }, now).catch(() => null);
    }

    return Response.json({
      ticker,
      expiration,
      isToday,
      selectedDte: scan.selectedDte,
      available: scan.available,
      minutesLeft,
      sessionOpen,
      etMinute: scan.etMinute,
      spot,
      spotSource: scan.spotSource,
      chainSource: scan.chainSource,
      change: scan.change,
      changePercent: scan.changePercent,
      contractCount: scan.contracts.length,
      analysis,
      signals: {
        trade: scan.trade,
        tradeAlt: scan.tradeAlt,
        ticket: scan.ticket,
        ticketNote: scan.ticketNote,
        spreads: scan.spreads,
        bias,
        biasAlt,
        pinning: scan.pinning,
        close: scan.close,
      },
      tape,
      flow: { reads: reads.slice(0, 40), summary: { bullish, bearish } },
      score,
      paper,
    });
  } catch (err) {
    if (err instanceof ZeroDteScanError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    const message =
      err instanceof MarketSnackError || err instanceof MassiveError
        ? err.message
        : "Error inesperado al construir la cadena 0DTE.";
    return Response.json({ error: message }, { status: 502 });
  }
}
