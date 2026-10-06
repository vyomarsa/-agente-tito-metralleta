// Bitácora del Playbook del Rango — fase 1 (semanas 1–2, solo observar).
//
//   GET    /api/scalping                → la bitácora y el recuento
//   GET    /api/scalping?preview=MSFT   → además, cómo saldría la anotación AHORA
//   POST   /api/scalping                → paso de bitácora (lo llama la tarea)
//   POST   /api/scalping?ticker=MSFT    → anota solo ese ticker
//   DELETE /api/scalping?ticker=X&fecha=Y → deshace una anotación equivocada
//
// El ensamblaje vive en `lib/scalpingScan.ts` porque la tarea programada lo usa
// sin pasar por aquí; esta ruta solo traduce a HTTP.

import { MarketSnackError } from "@/lib/marketsnack";
import { faseDelDia, resumen } from "@/lib/scalping";
import {
  SEGUIDOS, anotarSesion, bitacora, observar, tickBitacora, ScalpingScanError,
} from "@/lib/scalpingScan";
import { borrar } from "@/lib/scalpingStore";
import { etMinutes } from "@/lib/zerodteScan";
import { marketDateStr } from "@/lib/occ";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorHttp(e: unknown): Response {
  if (e instanceof MarketSnackError) {
    return Response.json({ error: e.message, kind: "marketsnack" }, { status: 502 });
  }
  if (e instanceof ScalpingScanError) {
    return Response.json({ error: e.message, kind: "datos" }, { status: 502 });
  }
  return Response.json({ error: (e as Error)?.message ?? "Error inesperado." }, { status: 500 });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const preview = (searchParams.get("preview") ?? "").trim().toUpperCase();
  const now = new Date();

  try {
    const obs = await bitacora();
    const hoy = marketDateStr(now);
    const cuerpo: Record<string, unknown> = {
      hoy,
      fase: faseDelDia(etMinutes(now)),
      seguidos: SEGUIDOS,
      anotadosHoy: obs.filter((o) => o.fecha === hoy).map((o) => o.ticker),
      bitacora: obs,
      resumen: resumen(obs),
    };

    if (preview) {
      // El preview NO se guarda. Sirve para mirar el semáforo de un ticker que
      // todavía no está en la bitácora sin comprometer la fila del día.
      try {
        cuerpo.preview = await observar(preview, now);
      } catch (e) {
        cuerpo.previewError = (e as Error).message;
      }
    }

    return Response.json(cuerpo);
  } catch (e) {
    return errorHttp(e);
  }
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const now = new Date();

  try {
    if (ticker) {
      const r = await anotarSesion(ticker, now);
      return Response.json({ ok: true, guardada: r.guardada, nota: r.nota, observacion: r.observacion });
    }
    const r = await tickBitacora(SEGUIDOS, now);
    return Response.json({ ok: r.fallos.length === 0, ...r });
  } catch (e) {
    return errorHttp(e);
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  const fecha = (searchParams.get("fecha") ?? "").trim();
  if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return Response.json({ error: "Hacen falta ticker y fecha (YYYY-MM-DD)." }, { status: 400 });
  }
  const borrada = await borrar(ticker, fecha);
  return Response.json({ ok: borrada, nota: borrada ? "" : "No había esa fila." });
}
