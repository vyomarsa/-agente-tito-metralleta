// Posición de day-trading sugerida (TSLA/SPX), día-scoped — PURO.
//
// Mismo espíritu que lib/watchlist.ts: se guarda una FOTO del momento (precio
// de entrada, spot de entrada) que nunca se pisa sola. Acá además caduca sola
// cada día hábil nuevo (dayKey vs marketDateStr) porque es day-trading: la
// posición de ayer no tiene sentido hoy.

import { buildOccSymbol, marketDateStr } from "./occ";
import type { ContractSuggestion } from "./dayTrade";

export interface DayTradePosition {
  ticker: string;
  symbol: string;
  type: "call" | "put";
  strike: number;
  expiration: string;
  entryPrice: number;
  entrySpot: number;
  suggestedAt: string; // ISO
  dayKey: string; // marketDateStr al momento de sugerir — para saber si "hoy" cambió
}

export function buildPosition(s: ContractSuggestion, entryPrice: number, now: Date): DayTradePosition {
  return {
    ticker: s.ticker,
    symbol: buildOccSymbol({ underlying: s.occRoot, expiration: s.expiration, type: s.type, strike: s.strike }),
    type: s.type,
    strike: s.strike,
    expiration: s.expiration,
    entryPrice,
    entrySpot: s.spot,
    suggestedAt: now.toISOString(),
    dayKey: marketDateStr(now),
  };
}

/** Ganancia/pérdida en vivo vs. el precio de entrada. Por contrato, sin sizing de cuenta. */
export function pnlOf(
  entryPrice: number,
  currentPrice: number | null,
): { pctChange: number | null; usdChange: number | null } {
  if (currentPrice == null || !(entryPrice > 0)) return { pctChange: null, usdChange: null };
  return {
    pctChange: ((currentPrice - entryPrice) / entryPrice) * 100,
    usdChange: (currentPrice - entryPrice) * 100,
  };
}

/** ¿Sigue vigente esta posición hoy, o ya cambió el día de mercado? */
export function isSameTradingDay(position: DayTradePosition, now: Date): boolean {
  return position.dayKey === marketDateStr(now);
}
