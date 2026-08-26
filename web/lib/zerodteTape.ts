// ============================================================================
// Cinta del 0DTE — volumen en vivo, CVD y bloques entrantes. TODO PURO.
//
// El agresor por prima (`aggressorReads` en zerodte.ts) contesta "¿dónde está el
// dinero?". Esto contesta las otras dos preguntas del intradía:
//
//   · CVD (Cumulative Volume Delta): contratos comprados AL ASK menos contratos
//     vendidos AL BID. Es el saldo neto del taker — quién está siendo agresivo.
//     A diferencia de la prima, cuenta CONTRATOS, así que un ticket caro lejos
//     del dinero no lo distorsiona.
//   · Velocidad: contratos por minuto de los últimos minutos contra la media de
//     la sesión. >1 = la cinta se está acelerando; <1 = se está apagando.
//   · Bloques entrantes: los tickets más grandes, SOLO takers (ask/bid), que es
//     donde hay intención real; los `mid` son cruces y no dicen dirección.
//
// Tests en zerodteTape.test.ts.
// ============================================================================

import type { FlowRow } from "./flow";

/** Ventana (min) para medir la velocidad instantánea de la cinta. */
export const VELOCITY_WINDOW_MIN = 5;
/** Cuántos bloques entrantes se publican. */
export const TOP_BLOCKS = 10;

export interface ZeroDteBlock {
  id: number;
  at: string;
  type: "call" | "put";
  strike: number;
  /** compra = agredió el ask; venta = agredió el bid. */
  side: "compra" | "venta";
  size: number;
  premium: number;
  price: number;
  /** Interpretación de dominio (comprar call = alcista, vender put = soporte…). */
  meaning: string;
  /** true si empuja el precio al alza según la tabla del Proceso Principal. */
  bullish: boolean;
}

export interface ZeroDteTape {
  /** Contratos negociados hoy en ese vencimiento (todas las agresiones). */
  contracts: number;
  /** Tickets contados. */
  trades: number;
  /** Volumen delta acumulado, en CONTRATOS (ask − bid). */
  cvd: number;
  /** Contratos agredidos al ask / al bid, para pintar la barra. */
  buy: number;
  sell: number;
  /** CVD normalizado a −1..+1 — es el peso que consume el sesgo alterno. */
  weight: number;
  pressure: "compradora" | "vendedora" | "neutral";
  /** Contratos/minuto en la ventana reciente. null si no hay suficientes datos. */
  velocity: number | null;
  /** Contratos/minuto de media desde el primer ticket del día. */
  avgVelocity: number | null;
  /** velocity / avgVelocity. >1.2 = acelerando; <0.8 = apagándose. */
  velocityRatio: number | null;
  velocityLabel: "acelerando" | "normal" | "apagándose" | null;
  blocks: ZeroDteBlock[];
}

function meaningOf(type: "call" | "put", side: "compra" | "venta"): string {
  if (type === "call") return side === "compra" ? "direccional alcista" : "resistencia / muro";
  return side === "compra" ? "cobertura o bajista" : "soporte";
}

/** Vacío canónico: fuera de sesión o sin cinta, para no romper la UI. */
export function emptyTape(): ZeroDteTape {
  return {
    contracts: 0, trades: 0, cvd: 0, buy: 0, sell: 0, weight: 0,
    pressure: "neutral", velocity: null, avgVelocity: null,
    velocityRatio: null, velocityLabel: null, blocks: [],
  };
}

/**
 * Construye la cinta del vencimiento indicado a partir del Time & Sales ya
 * clasificado. `now` fija el final de la ventana de velocidad.
 *
 * Solo entran filas con agresión `ask` o `bid`: los cruces en el `mid` no dicen
 * quién tenía prisa, y meterlos en el CVD lo único que hace es diluirlo.
 *
 * `sessionOpen` importa para la VELOCIDAD y solo para ella: con el mercado
 * cerrado la ventana de 5 min siempre sale vacía, así que el ratio daría 0 y la
 * cinta diría "apagándose" cuando lo cierto es que no hay sesión. Fuera de
 * horario la velocidad va null y la UI enseña "—". El CVD y los bloques sí
 * siguen valiendo cerrados: son el saldo de la última sesión.
 */
export function buildTape(
  rows: FlowRow[],
  expiration: string,
  now: Date,
  sessionOpen = true,
): ZeroDteTape {
  const mine = rows.filter(
    (r) =>
      r.expiration === expiration &&
      (r.type === "call" || r.type === "put") &&
      r.strike != null &&
      (r.aggression === "ask" || r.aggression === "bid"),
  );
  if (mine.length === 0) return emptyTape();

  let buy = 0, sell = 0, contracts = 0;
  let firstMs = Infinity;
  const nowMs = now.getTime();
  const windowMs = VELOCITY_WINDOW_MIN * 60_000;
  let recent = 0;

  for (const r of mine) {
    contracts += r.size;
    if (r.aggression === "ask") buy += r.size; else sell += r.size;
    const ts = Date.parse(r.timestamp);
    if (Number.isFinite(ts)) {
      if (ts < firstMs) firstMs = ts;
      if (nowMs - ts <= windowMs) recent += r.size;
    }
  }

  const cvd = buy - sell;
  const weight = contracts > 0 ? Math.max(-1, Math.min(1, cvd / contracts)) : 0;
  const pressure: ZeroDteTape["pressure"] =
    Math.abs(weight) < 0.08 ? "neutral" : weight > 0 ? "compradora" : "vendedora";

  const elapsedMin = Number.isFinite(firstMs) ? (nowMs - firstMs) / 60_000 : 0;
  const avgVelocity = elapsedMin >= 1 ? contracts / elapsedMin : null;
  // Sin al menos una ventana completa de historia la comparación no significa nada.
  const velocity =
    sessionOpen && elapsedMin >= VELOCITY_WINDOW_MIN ? recent / VELOCITY_WINDOW_MIN : null;
  const velocityRatio =
    velocity != null && avgVelocity != null && avgVelocity > 0 ? velocity / avgVelocity : null;
  const velocityLabel: ZeroDteTape["velocityLabel"] =
    velocityRatio == null ? null : velocityRatio >= 1.2 ? "acelerando" : velocityRatio <= 0.8 ? "apagándose" : "normal";

  const blocks: ZeroDteBlock[] = [...mine]
    .sort((a, b) => b.premium - a.premium)
    .slice(0, TOP_BLOCKS)
    .map((r) => {
      const type = r.type as "call" | "put";
      const side: ZeroDteBlock["side"] = r.aggression === "ask" ? "compra" : "venta";
      return {
        id: r.id,
        at: r.timestamp,
        type,
        strike: r.strike as number,
        side,
        size: r.size,
        premium: r.premium,
        price: r.price,
        meaning: meaningOf(type, side),
        bullish: (type === "call" && side === "compra") || (type === "put" && side === "venta"),
      };
    });

  return {
    contracts, trades: mine.length, cvd, buy, sell, weight, pressure,
    velocity, avgVelocity, velocityRatio, velocityLabel, blocks,
  };
}
