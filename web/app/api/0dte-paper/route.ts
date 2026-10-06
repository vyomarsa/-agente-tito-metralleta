// /api/0dte-paper — la cuenta simulada del agente 0DTE.
//
//   GET   → estado (resumen, abiertas, cerradas). Lo lee `/trades` sin mover nada.
//   POST  → un TICK: re-cotiza, aplica reglas y abre si toca. Lo dispara la tarea
//           programada cada minuto de sesión, SIN que la página esté abierta.
//
// El tick también corre dentro de `/api/0dte` cuando la página está abierta. No
// hay dos motores decidiendo: los dos llaman al MISMO `tickZeroPaper` con el
// MISMO `scanZeroDte`, y el tick es idempotente por minuto — si los dos caen en
// el mismo minuto, el segundo se encuentra el trabajo hecho.

import {
  MAX_PERDIDAS_DIA, perdidasDelDia, pnlDelDia, summarize, type ZeroPaperPosition,
} from "@/lib/zerodtePaper";
import { loadClosed, loadOpen, tickZeroPaper } from "@/lib/zerodtePaperStore";
import { ALLOWED, scanZeroDte, ZeroDteScanError } from "@/lib/zerodteScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Las cerradas se sirven de más reciente a más antigua. */
function byClosedDesc(a: ZeroPaperPosition, b: ZeroPaperPosition): number {
  return (b.closedAt ?? "").localeCompare(a.closedAt ?? "");
}

export async function GET() {
  try {
    const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);
    const now = new Date();
    const perdidas = perdidasDelDia(closed, now);
    return Response.json({
      summary: summarize(closed, open),
      // Estado del límite diario de HOY, para que la pantalla diga si todavía abre.
      limiteDiario: {
        perdidas,
        tope: MAX_PERDIDAS_DIA,
        alcanzado: perdidas >= MAX_PERDIDAS_DIA,
        pnlHoy: pnlDelDia(closed, now),
      },
      open,
      closed: [...closed].sort(byClosedDesc).slice(0, 100),
    });
  } catch {
    return Response.json({ error: "No se pudo leer la cuenta de paper del 0DTE." }, { status: 500 });
  }
}

/**
 * POST /api/0dte-paper — un tick de la cuenta, SIN pantalla.
 *
 * Lo dispara la tarea programada cada minuto durante la sesión. Usa el MISMO
 * `scanZeroDte` que la vista, así que el contrato que compra es exactamente el
 * que la página habría enseñado en ese minuto.
 *
 * NO pide el Time & Sales: son 6 páginas por llamada y solo alimentan la cinta y
 * el sesgo alterno, que son cosas de pantalla. Corriendo cada minuto durante 6,5
 * horas eso multiplicaría la carga contra MarketSnack sin cambiar una sola
 * decisión de la cuenta.
 *
 * Devuelve 200 con `ok:false` cuando no hay nada que hacer (fuera de sesión,
 * ticker sin vencimiento de hoy) para que el worker distinga "no tocaba" de
 * "falló", que es el modo de fallo silencioso que ya costó una ventana de
 * apertura en venta de prima.
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPY").trim().toUpperCase();
  if (!ALLOWED.has(ticker)) {
    return Response.json({ ok: false, error: `0DTE soportado solo para: ${[...ALLOWED].join(", ")}.` }, { status: 400 });
  }

  const now = new Date();
  try {
    const scan = await scanZeroDte(ticker, "", now);

    if (!scan.isToday) {
      return Response.json({
        ok: false, ticker, skipped: true,
        note: `Hoy no hay vencimiento 0DTE de ${ticker} (el más cercano es ${scan.expiration}).`,
      });
    }

    const r = await tickZeroPaper({
      ticker,
      expiration: scan.expiration,
      spot: scan.spot,
      minutesLeft: scan.minutesLeft,
      sessionOpen: scan.sessionOpen,
      now,
      ticket: scan.ticket,
      trade: scan.activeTrade,
      priceOf: scan.priceOf,
    });

    return Response.json({
      ok: true,
      ticker,
      spot: scan.spot,
      sessionOpen: scan.sessionOpen,
      minutesLeft: scan.minutesLeft,
      opened: r.open.length,
      justClosed: r.justClosed.map((p) => ({
        ticker: p.ticker, type: p.type, strike: p.strike,
        reason: p.closeReason, pnl: p.realizedPnl,
      })),
      blocked: r.blocked,
      notes: r.notes,
      summary: r.summary,
    });
  } catch (err) {
    const message = err instanceof ZeroDteScanError
      ? err.message
      : err instanceof Error ? err.message : "Error inesperado en el tick del 0DTE.";
    return Response.json({ ok: false, ticker, error: message }, { status: 502 });
  }
}
