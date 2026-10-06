// Cadena de opciones sobre EL FUTURO ACTIVO de un producto CME (ES/NQ) vía
// tastytrade — mismo shape de salida que fetchZeroDteChain (ZRow[]), así
// zeroDteGex/atmIV (lib/zerodte.ts) se reusan sin cambios. A diferencia de
// las opciones de índice (SPX/NDX, que dejan de cotizar a las 16:00 ET), CME
// lista opciones DIARIAS sobre el futuro que siguen operando toda la noche —
// pedido explícito: datos reales de /ES y /NQ mientras el mercado
// de acciones/índice está cerrado.

import {
  fetchActiveFuture, fetchFuturesOptionQuotesByType, fetchFuturesQuote, fetchNestedFuturesOptionChain,
  type TastyQuote,
} from "./tastytrade";
import type { ContractType, ZContractGreeks, ZRow } from "./zerodteTypes";

function num(v: string | number | undefined | null): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function pos(v: string | number | undefined | null): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

function toGreeks(q: TastyQuote | undefined): ZContractGreeks | null {
  if (!q) return null;
  const delta = num(q.delta);
  const gamma = num(q.gamma);
  const theta = num(q.theta);
  const vega = num(q.vega);
  const iv = num(q.volatility);
  if (delta == null && gamma == null && theta == null && vega == null && iv == null) return null;
  return { delta, gamma, theta, vega, iv };
}

export interface FuturesChainResult {
  rows: ZRow[];
  underlyingPrice: number | null;
  /** Contrato de futuro real usado como spot y liquidación (ej. "/ESU6"). */
  futureSymbol: string | null;
  /** Vencimiento de la opción diaria elegida. */
  expirationDate: string | null;
  /** Cuándo deja de cotizar esa opción diaria (ISO) — horizonte real para probTouch. */
  stopsTradingAt: string | null;
}

const EMPTY: FuturesChainResult = {
  rows: [], underlyingPrice: null, futureSymbol: null, expirationDate: null, stopsTradingAt: null,
};

/**
 * Cadena "0DTE-equivalente" de opciones sobre el futuro activo de un
 * producto (ES/NQ): resuelve el contrato activo (`active-month`), su
 * cotización real, y la expiración diaria MÁS PRÓXIMA que todavía no dejó de
 * cotizar (`stops-trading-at > now`) — así sigue funcionando de noche, cuando
 * la de hoy ya cerró pero la de mañana ya está listada y operando.
 */
export async function fetchActiveFuturesOptionChain(
  productCode: string, now: Date,
): Promise<FuturesChainResult> {
  const future = await fetchActiveFuture(productCode);
  if (!future) return EMPTY;

  const [spot, expirations] = await Promise.all([
    fetchFuturesQuote(future.symbol),
    fetchNestedFuturesOptionChain(productCode),
  ]);

  // Solo expiraciones que liquidan contra el futuro activo: las que liquidan
  // contra otro mes no comparten el mismo spot/GEX.
  const live = expirations
    .filter((e) => e["underlying-symbol"] === future.symbol && new Date(e["stops-trading-at"]) > now)
    .sort((a, b) => Date.parse(a["stops-trading-at"]) - Date.parse(b["stops-trading-at"]));
  const target = live[0];
  if (!target) return { ...EMPTY, underlyingPrice: spot, futureSymbol: future.symbol };

  const symbols = target.strikes.flatMap((s) => [s.call, s.put]).filter(Boolean);
  const quotes = await fetchFuturesOptionQuotesByType(symbols);

  const rows: ZRow[] = [];
  for (const s of target.strikes) {
    const strike = num(s["strike-price"]);
    if (strike == null) continue;
    const legs: [ContractType, string][] = [["call", s.call], ["put", s.put]];
    for (const [contractType, rawSymbol] of legs) {
      if (!rawSymbol) continue;
      const q = quotes.get(rawSymbol);
      rows.push({
        optionTicker: rawSymbol,
        contractType,
        expiration: target["expiration-date"],
        strike,
        openInterest: num(q?.["open-interest"]) ?? 0,
        volume: num(q?.volume) ?? 0,
        bid: pos(q?.bid),
        ask: pos(q?.ask),
        greeks: toGreeks(q),
      });
    }
  }

  return {
    rows, underlyingPrice: spot, futureSymbol: future.symbol,
    expirationDate: target["expiration-date"], stopsTradingAt: target["stops-trading-at"],
  };
}
