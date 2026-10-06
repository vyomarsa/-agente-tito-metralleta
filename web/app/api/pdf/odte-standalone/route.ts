// GET /api/0dte?ticker=SPX — cadena del vencimiento de hoy, top 10 por volumen
// de cada lado. Ver Agente Principal/Proceso 0DTE.md.

import { asLang } from "@/lib/pdf/odteStandalone/i18n";
import { isNativeFuture, futureStoreKey } from "@/lib/pdf/odteStandalone/futuresNative";
import { TastytradeError } from "@/lib/pdf/odteStandalone/tastySource";
import { calibrationShiftPct, fetchZeroDte, resolveTicker } from "@/lib/pdf/odteStandalone/zerodte";
import {
  loadCalibration, loadLatestClosing, saveClosingPrediction, saveForecast,
} from "@/lib/pdf/odteStandalone/zerodteEval";

/** Minutos desde medianoche en hora de Nueva York. */
function etMinutes(now: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24;
  const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

const OPEN_MIN = 9 * 60 + 30;   // 9:30am ET
const CLOSE_MIN = 16 * 60;      // 4:00pm ET

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPX").trim().toUpperCase();
  const date = searchParams.get("date") ?? undefined; // YYYY-MM-DD; vacío = hoy
  const lang = asLang(searchParams.get("lang")); // inglés por defecto
  const es = lang === "es";
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  // La persistencia (calibración, pronósticos, cierre) se llavea por el
  // instrumento analizado. Con futuros nativos, /ES→ES y /NQ→NQ (historia propia,
  // ya no comparten con SPX/NDX). Si NATIVE_FUTURES=0, se llavea por el índice.
  const store = isNativeFuture(ticker) ? futureStoreKey(ticker) : resolveTicker(ticker).analysis;

  try {
    // Auto-corrección: el sesgo histórico medido (si hay suficientes sesiones)
    // desplaza el objetivo central del pronóstico. Para fechas futuras el
    // pronóstico es null, así que el shift no tiene efecto ahí.
    const calib = await loadCalibration(store);
    const shift = calibrationShiftPct(calib.biasPct, calib.samples);
    const result = await fetchZeroDte(ticker, new Date(), date, shift, lang);

    // Auto-evaluación: solo para el vencimiento de HOY (0DTE). Se guarda la
    // PRIMERA foto del día para revisarla al cierre (saveForecast no reemplaza
    // si ya hay una de hoy). No debe tumbar la respuesta si el disco falla.
    if (result.isToday && result.forecast && result.spot != null) {
      const { scenarios } = result.forecast;
      const t = (k: string) => scenarios.find((s) => s.kind === k)?.target ?? result.spot!;
      saveForecast(store, {
        spot: result.spot,
        bear: t("bear"),
        base: t("base"),
        bull: t("bull"),
        kingStrike: result.gex.kingStrike,
      }).catch(() => {});
    }

    // Pronóstico de cierre: el panel se muestra SIEMPRE (para hoy), con tres
    // fases. `closingForecast` solo devuelve la fase "live" (3-4pm); aquí se
    // rellenan "pending" (9:30-3pm) y "final" (tras las 4pm, valor fijado desde
    // el disco y mantenido hasta la próxima sesión).
    if (result.isToday) {
      if (result.closing && result.closing.strike != null) {
        // live: guarda la última estimación (la más convergida) para el historial.
        saveClosingPrediction(store, result.closing.strike).catch(() => {});
      } else {
        const min = etMinutes(new Date());
        const base = {
          spot: result.spot ?? 0,
          magnet: result.gex.kingStrike,
          maxPain: null,
          regime: result.gex.regime,
          estimate: 0, rangeLow: 0, rangeHigh: 0, sigma: 0, minutesLeft: 0,
        };
        if (min >= OPEN_MIN && min < CLOSE_MIN) {
          // pending: mercado abierto, antes de las 3pm.
          result.closing = {
            ...base, phase: "pending", strike: null, confidence: "baja",
            minutesLeft: CLOSE_MIN - min,
            note: es
              ? "El pronóstico de cierre se calcula a partir de las 3:00pm ET, cuando el jalón de gamma es más fuerte."
              : "The closing forecast is computed from 3:00pm ET, when the gamma pull is strongest.",
          };
        } else {
          // final: tras el cierre (o pre-market/fin de semana). Valor fijado.
          const last = await loadLatestClosing(store);
          result.closing = last
            ? {
                ...base, phase: "final", strike: last.strike, fromDate: last.date,
                confidence: "media",
                note: es
                  ? `Cierre estimado fijado a las 4:00pm de la sesión ${last.date}. Se mantiene hasta las 9:30am ET de la próxima sesión.`
                  : `Estimated close fixed at 4:00pm on the ${last.date} session. Held until 9:30am ET of the next session.`,
              }
            : {
                ...base, phase: "pending", strike: null, confidence: "baja",
                note: es
                  ? "Aún no hay pronóstico de cierre registrado; se calcula de 3 a 4pm ET."
                  : "No closing forecast recorded yet; it is computed from 3 to 4pm ET.",
              };
        }
      }
    }

    return Response.json(result);
  } catch (err) {
    const message =
      err instanceof TastytradeError ? err.message : "Error al cargar la cadena 0DTE.";
    return Response.json({ error: message }, { status: 502 });
  }
}
