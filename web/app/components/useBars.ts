"use client";

// UNA sola petición de barras por (ticker, timeframe), compartida por todas las
// tarjetas que las piden a la vez.
//
// El dashboard monta SimpleChart y ProWallsCard juntos y los dos quieren el
// mismo `tf=1y`: eran dos peticiones idénticas contra un presupuesto de 5 por
// minuto. Aquí se comparte la promesa en vuelo y se guarda el resultado un rato,
// así cambiar de ticker y volver tampoco vuelve a gastar cuota.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TfBar } from "@/lib/types";

/** Lo que vale una respuesta en el navegador antes de volver a pedirla. */
const CLIENT_TTL_MS = 60_000;
/** Reintentos automáticos tras un fallo de cuota, antes de rendirse. */
const MAX_RETRIES = 5;
const MIN_RETRY_MS = 3_000;
const MAX_RETRY_MS = 90_000;

interface BarsResponse {
  bars: TfBar[];
  stale?: boolean;
  ageMs?: number | null;
  error?: string;
  warning?: string;
  retryAfterMs?: number | null;
}

const cache = new Map<string, { at: number; data: BarsResponse }>();
const inflight = new Map<string, Promise<BarsResponse>>();

function keyOf(ticker: string, tf: string): string {
  return `${ticker.toUpperCase()}|${tf}`;
}

async function load(ticker: string, tf: string): Promise<BarsResponse> {
  const url = `/api/bars?ticker=${encodeURIComponent(ticker)}&tf=${encodeURIComponent(tf)}`;
  try {
    const r = await fetch(url);
    const d = (await r.json()) as Partial<BarsResponse> & { error?: string };
    return {
      bars: Array.isArray(d.bars) ? d.bars : [],
      stale: Boolean(d.stale),
      ageMs: d.ageMs ?? null,
      // `error` solo cuando NO hay barras; con barras viejas la ruta manda `warning`.
      error: d.error,
      warning: d.warning,
      retryAfterMs: d.retryAfterMs ?? null,
    };
  } catch {
    return { bars: [], error: "No se pudo contactar con el servidor de barras." };
  }
}

function request(ticker: string, tf: string): Promise<BarsResponse> {
  const key = keyOf(ticker, tf);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return Promise.resolve(hit.data);

  const running = inflight.get(key);
  if (running) return running;

  const job = load(ticker, tf)
    .then((data) => {
      // Un fallo no se cachea: se reintenta en cuanto alguien vuelva a pedirlo.
      if (data.bars.length > 0) cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, job);
  return job;
}

export interface BarsState {
  bars: TfBar[] | null;
  /** Barras servidas de la reserva porque no hubo cuota para refrescarlas. */
  stale: boolean;
  /** Motivo por el que no hay barras (o por el que las que hay son viejas). */
  error: string | null;
  loading: boolean;
  /** `true` mientras quedan reintentos automáticos por delante. */
  retrying: boolean;
}

/** Barras de un ticker/timeframe, compartidas entre tarjetas y con reintento. */
export function useBars(ticker: string, tf: string): BarsState {
  const [state, setState] = useState<BarsState>({
    bars: null, stale: false, error: null, loading: true, retrying: false,
  });
  const [attempt, setAttempt] = useState(0);
  const retryMs = useRef<number | null>(null);

  // Cambiar de ticker o timeframe empieza de cero la cuenta de reintentos.
  const reset = useCallback(() => setAttempt(0), []);
  useEffect(() => { reset(); }, [ticker, tf, reset]);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    request(ticker, tf).then((d) => {
      if (cancelled) return;
      const failed = d.bars.length === 0 && Boolean(d.error);
      const wait = d.retryAfterMs ?? null;
      // Solo se reintenta lo que puede mejorar solo: falta de cuota sin barras.
      retryMs.current = failed && wait != null && attempt < MAX_RETRIES ? wait : null;
      setState({
        bars: d.bars,
        stale: Boolean(d.stale),
        error: d.error ?? d.warning ?? null,
        loading: false,
        retrying: retryMs.current != null,
      });
    });
    return () => { cancelled = true; };
  }, [ticker, tf, attempt]);

  useEffect(() => {
    const wait = retryMs.current;
    if (wait == null) return;
    const ms = Math.min(Math.max(wait, MIN_RETRY_MS), MAX_RETRY_MS);
    const t = setTimeout(() => setAttempt((n) => n + 1), ms);
    return () => clearTimeout(t);
  }, [state]);

  return state;
}
