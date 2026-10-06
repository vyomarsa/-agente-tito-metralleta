// Sugerencias de estrategia (vertical de débito, credit call, iron condor)
// para la pestaña "0DTE" — pedido explícito (2026-08-30), a partir
// de "Sugerencias 0DTE - script (verticals + IC).docx". Ese documento describe
// un script que solo LEE sugerencias ya calculadas por OTRO agente (puerto
// 3002, proyecto "Ruta2030-0DTE") que no existe en esta máquina — no hay
// código que portar. Este archivo es el motor nuevo que las calcula de
// verdad, reusando lo que YA tiene este motor: el muro de calls/puts real
// (`gammaWalls`, mismo GEX real de Schwab/Tastytrade que pinta la cadena) y
// la entrada direccional (`evaluateEntry`) que ya alimenta "GEX Trade".
//
// PURA — no hace fetch ni fs. Precio conservador igual que `lib/creditSpreads.ts`
// (Venta de Primas): comprar al ASK, vender al BID — el peor llenado realista,
// nunca el mid optimista. Si falta un bid/ask real de alguna pata, la
// sugerencia sale `null` en vez de inventar un número.

import { gammaWalls } from "./zerodteAlt";
import type { EntryDecision } from "./zerodteStrategy";
import type { Row } from "./types";
import type { ZeroDteGex } from "./zerodte";
import type { Lang } from "./i18n";

export interface VerticalSuggestion {
  kind: "bull_call" | "bear_put";
  longStrike: number;
  shortStrike: number;
  /** Débito conservador (ask de la pata larga − bid de la pata corta). null si falta quote real. */
  debit: number | null;
  width: number;
  reason: string;
}

export interface CreditCallSuggestion {
  shortStrike: number;
  longStrike: number;
  /** Crédito conservador (bid de la pata corta − ask de la pata larga). null si falta quote real. */
  credit: number | null;
  width: number;
  reason: string;
}

export interface IronCondorSuggestion {
  shortPut: number;
  longPut: number;
  shortCall: number;
  longCall: number;
  /** Crédito TOTAL conservador (put spread + call spread). null si falta algún quote real. */
  credit: number | null;
  /** Breakeven inferior/superior del rango (shortPut − crédito / shortCall + crédito). */
  beLow: number | null;
  beHigh: number | null;
  reason: string;
}

export interface StrategySuggestions {
  vertical: VerticalSuggestion | null;
  creditCall: CreditCallSuggestion | null;
  ironCondor: IronCondorSuggestion | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Precio conservador de una pata: comprar al ASK, vender al BID. null si no hay quote real (>0). */
function legPrice(row: Row | undefined, side: "buy" | "sell"): number | null {
  if (!row) return null;
  const v = side === "buy" ? row.ask : row.bid;
  return typeof v === "number" && v > 0 ? v : null;
}

/** Strike más cercano a `target` dentro de la lista (ya ordenada, sin duplicados). */
function nearestStrike(strikes: number[], target: number): number | null {
  if (strikes.length === 0) return null;
  let best = strikes[0];
  let bestDiff = Math.abs(strikes[0] - target);
  for (const k of strikes) {
    const diff = Math.abs(k - target);
    if (diff < bestDiff) { best = k; bestDiff = diff; }
  }
  return best;
}

/**
 * Sugerencias de estrategia sobre la MISMA cadena 0DTE que ya arma el motor.
 * PURA — mismos `rows`/`spot`/`gex`/`entry` que ya calculan `zeroDteGex` y
 * `evaluateEntry` en `fetchZeroDte`, sin fetch adicional.
 */
export function buildStrategySuggestions(
  rows: Row[],
  spot: number,
  gex: ZeroDteGex,
  entry: EntryDecision | null,
  locale: Lang = "es",
): StrategySuggestions {
  const es = locale === "es";
  const callsByStrike = new Map<number, Row>();
  const putsByStrike = new Map<number, Row>();
  for (const r of rows) {
    if (r.contractType === "call") callsByStrike.set(r.strike, r);
    else if (r.contractType === "put") putsByStrike.set(r.strike, r);
  }
  const callStrikes = [...callsByStrike.keys()].sort((a, b) => a - b);
  const putStrikes = [...putsByStrike.keys()].sort((a, b) => a - b);

  // -------------------------------------------------------------- vertical
  // Misma dirección que "GEX Trade" (evaluateEntry): apuesta al MISMO target
  // (el imán), pero con riesgo definido y más barata que el contrato suelto —
  // se vende exactamente en el target propio, no más allá (no tiene sentido
  // pagar por upside que el propio motor no espera capturar).
  let vertical: VerticalSuggestion | null = null;
  if (entry) {
    const isBull = entry.direction === "long";
    const strikes = isBull ? callStrikes : putStrikes;
    const byStrike = isBull ? callsByStrike : putsByStrike;
    const longK = nearestStrike(strikes, entry.entry);
    const shortK = nearestStrike(strikes, entry.target);
    if (longK != null && shortK != null && longK !== shortK) {
      const longAsk = legPrice(byStrike.get(longK), "buy");
      const shortBid = legPrice(byStrike.get(shortK), "sell");
      const debit = longAsk != null && shortBid != null ? round2(longAsk - shortBid) : null;
      vertical = {
        kind: isBull ? "bull_call" : "bear_put",
        longStrike: longK,
        shortStrike: shortK,
        debit,
        width: Math.abs(shortK - longK),
        reason: es
          ? `Misma dirección que GEX Trade (target ${shortK}), pero riesgo definido: cuesta el débito, nunca más.`
          : `Same direction as GEX Trade (target ${shortK}), but defined risk: costs the debit, never more.`,
      };
    }
  }

  // ----------------------------------------------------------- credit call
  // Vender en el Call Wall real (mayor gamma de calls arriba del spot) solo
  // tiene sentido en γ+ (régimen que REVIERTE al imán, "FADEAR" en el script
  // de referencia) — en γ− el precio puede romper el muro en vez de frenar ahí.
  let creditCall: CreditCallSuggestion | null = null;
  if (gex.regime === "positive") {
    const { callWall } = gammaWalls(gex.nodes, spot);
    if (callWall != null) {
      const idx = callStrikes.indexOf(callWall);
      const longK = idx >= 0 ? callStrikes[idx + 1] ?? null : null;
      if (longK != null) {
        const shortBid = legPrice(callsByStrike.get(callWall), "sell");
        const longAsk = legPrice(callsByStrike.get(longK), "buy");
        const credit = shortBid != null && longAsk != null ? round2(shortBid - longAsk) : null;
        creditCall = {
          shortStrike: callWall,
          longStrike: longK,
          credit,
          width: longK - callWall,
          reason: es
            ? `Vende en el Call Wall real (mayor gamma de calls arriba del spot) — gana si el precio se queda debajo de ${callWall} al cierre.`
            : `Sells at the real Call Wall (largest call gamma above spot) — wins if price stays below ${callWall} at the close.`,
        };
      }
    }
  }

  // ---------------------------------------------------------- iron condor
  // Mismo criterio que credit call, del lado del Put Wall también — vender el
  // rango completo solo en γ+ (régimen de pin, no de amplificación).
  let ironCondor: IronCondorSuggestion | null = null;
  if (gex.regime === "positive") {
    const { callWall, putWall } = gammaWalls(gex.nodes, spot);
    if (callWall != null && putWall != null) {
      const ci = callStrikes.indexOf(callWall);
      const longCallK = ci >= 0 ? callStrikes[ci + 1] ?? null : null;
      const pi = putStrikes.indexOf(putWall);
      const longPutK = pi >= 1 ? putStrikes[pi - 1] ?? null : null; // el strike siguiente hacia ABAJO
      if (longCallK != null && longPutK != null) {
        const shortCallBid = legPrice(callsByStrike.get(callWall), "sell");
        const longCallAsk = legPrice(callsByStrike.get(longCallK), "buy");
        const shortPutBid = legPrice(putsByStrike.get(putWall), "sell");
        const longPutAsk = legPrice(putsByStrike.get(longPutK), "buy");
        const callLeg = shortCallBid != null && longCallAsk != null ? shortCallBid - longCallAsk : null;
        const putLeg = shortPutBid != null && longPutAsk != null ? shortPutBid - longPutAsk : null;
        const credit = callLeg != null && putLeg != null ? round2(callLeg + putLeg) : null;
        ironCondor = {
          shortPut: putWall,
          longPut: longPutK,
          shortCall: callWall,
          longCall: longCallK,
          credit,
          beLow: credit != null ? round2(putWall - credit) : null,
          beHigh: credit != null ? round2(callWall + credit) : null,
          reason: es
            ? `Vende el rango entre el Put Wall (${putWall}) y el Call Wall (${callWall}) — gana el crédito si el cierre queda adentro.`
            : `Sells the range between the Put Wall (${putWall}) and the Call Wall (${callWall}) — wins the credit if the close lands inside.`,
        };
      }
    }
  }

  return { vertical, creditCall, ironCondor };
}
