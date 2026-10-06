// GET /api/0dte?date= — cadena del vencimiento de SPX (hoy por defecto), top 10
// por volumen de cada lado. Ver Agente Principal/Proceso 0DTE.md.

import { SchwabError } from "@/lib/pdf/schwab";
import { calibrationShiftPct, fetchZeroDte } from "@/lib/pdf/zerodte";
import { zeroDteTickerConfig } from "@/lib/pdf/zerodteTickers";
import {
  loadCalibration, loadLatestClosing, saveClosingPrediction, saveForecast,
} from "@/lib/pdf/zerodteEval";

/** Minutos desde medianoche en hora de Nueva York. */
function etMinutes(now: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24;
  const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") ?? undefined; // YYYY-MM-DD; vacío = hoy
  const TICKER = zeroDteTickerConfig(searchParams.get("ticker")).underlying;

  try {
    // Auto-corrección: el sesgo histórico medido (si hay suficientes sesiones)
    // desplaza el objetivo central del pronóstico.
    const calib = await loadCalibration(TICKER);
    const shift = calibrationShiftPct(calib.biasPct, calib.samples);
    const result = await fetchZeroDte(TICKER, new Date(), date, shift);

    // Auto-evaluación: solo para el vencimiento de HOY. Se guarda la PRIMERA
    // foto del día; no debe tumbar la respuesta si el disco falla.
    if (result.isToday && result.forecast && result.spot != null) {
      const { scenarios } = result.forecast;
      const t = (k: string) => scenarios.find((s) => s.kind === k)?.target ?? result.spot!;
      saveForecast(TICKER, {
        spot: result.spot, bear: t("bear"), base: t("base"), bull: t("bull"),
        kingStrike: result.gex.kingStrike,
      }).catch(() => {});
    }

    // Pronóstico de cierre: se muestra siempre (para hoy), con tres fases.
    // `closingForecast` solo devuelve la fase "live" (3-4pm); aquí se rellenan
    // "pending" (9:30-3pm) y "final" (tras las 4pm, valor fijado en disco).
    if (result.isToday) {
      if (result.closing && result.closing.strike != null) {
        saveClosingPrediction(TICKER, result.closing.strike).catch(() => {});
      } else {
        const min = etMinutes(new Date());
        const base = {
          spot: result.spot ?? 0, magnet: result.gex.kingStrike, maxPain: null, regime: result.gex.regime,
          estimate: 0, rangeLow: 0, rangeHigh: 0, sigma: 0, minutesLeft: 0,
        };
        if (min >= OPEN_MIN && min < CLOSE_MIN) {
          result.closing = {
            ...base, phase: "pending", strike: null, confidence: "baja",
            minutesLeft: CLOSE_MIN - min,
            note: "El pronóstico de cierre se calcula a partir de las 3:00pm ET, cuando el jalón de gamma es más fuerte.",
          };
        } else {
          const last = await loadLatestClosing(TICKER);
          result.closing = last
            ? {
                ...base, phase: "final", strike: last.strike, fromDate: last.date, confidence: "media",
                note: `Cierre estimado fijado a las 4:00pm de la sesión ${last.date}. Se mantiene hasta las 9:30am ET de la próxima sesión.`,
              }
            : {
                ...base, phase: "pending", strike: null, confidence: "baja",
                note: "Aún no hay pronóstico de cierre registrado; se calcula de 3 a 4pm ET.",
              };
        }
      }
    }

    return Response.json(result);
  } catch (err) {
    const message = err instanceof SchwabError ? err.message : "Error al cargar la cadena 0DTE.";
    return Response.json({ error: message }, { status: 502 });
  }
}
