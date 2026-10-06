// ============================================================================
// FLUJO (Time & Sales) de un ticker — Tastytrade → MarketSnack.
//
// Hasta el 2026-09-17 el flujo era EXCLUSIVO de MarketSnack y por eso la pestaña
// Ticker entera (Agresividad, Convicción, Inusualidad, Contexto IV y la base de
// Validación) se caía sin su cookie. Verificado ese día: el streamer de Tastytrade
// SÍ sirve Time & Sales de opciones (evento `TimeAndSale`) con lado agresor, la
// horquilla del momento y el marcador de pata de estrategia.
//
// LO QUE NO ES IGUAL QUE MARKETSNACK, y hay que tenerlo delante al leer los datos:
//   1. **Alcance.** MarketSnack devuelve el flujo del ticker en TODA su cadena; aquí
//      se suscriben los `expirations` vencimientos más cercanos (8 por defecto, el
//      régimen ya verificado del streamer). Un LEAPS que opere fuera de esa ventana
//      no aparece.
//   2. **Histórico.** dxFeed corta en ~1.000 impresiones por contrato (las más
//      recientes) y no llega más allá de ~5 sesiones. Para ventanas largas
//      (Convicción mira 30 días) hay que acumular en disco: ver `flowStore`.
//   3. **Griegas.** MarketSnack traía las del INSTANTE del trade; aquí son las de
//      AHORA, del mismo snapshot de la cadena. En delta/gamma de un contrato lejano
//      la diferencia es pequeña, pero en un 0DTE a última hora no lo es.
//   4. **Precio del subyacente.** No viaja en la impresión: se reconstruye con las
//      velas de 1 minuto del subyacente (la del minuto de la operación).
//   5. **`score`/`sentiment`** eran cosechas propias de MarketSnack. El score no lo
//      usa nadie (se rellena a 0) y el sentimiento se deriva del lado agresor.
// ============================================================================

import type { RawTrade } from "./flow";
import { MarketSnackError, fetchFlow } from "./marketsnack";
import { dxlinkTimeAndSale, type DxPrint } from "./tastytradeStream";
import {
  fetchQuoteToken, fetchTastytradeCandles, streamChainForFlow, tastytradeConfigured,
  type QuoteToken,
} from "./tastytrade";

export type FlowSource = "tastytrade" | "marketsnack";

export interface TickerFlowOptions {
  /** Ventana hacia atrás en días de calendario. */
  days?: number;
  /** Piso de prima en $ (premium = precio × tamaño × 100). */
  minPremium?: number;
  /** Vencimientos más cercanos que se escuchan (solo Tastytrade). */
  expirations?: number;
  quoteToken?: QuoteToken;
  timeoutMs?: number;
}

export interface TickerFlowResult {
  trades: RawTrade[];
  source: FlowSource;
  /** Contratos que llegaron al tope de ~1.000 impresiones (histórico recortado). */
  truncated: number;
}

/** Lado al estilo MarketSnack, que es lo que consume `aggressionOf`/`executionLevel`. */
export function sideOf(p: Pick<DxPrint, "price" | "bid" | "ask" | "aggressor">): string {
  const { price, bid, ask } = p;
  if (bid != null && ask != null && ask >= bid) {
    if (price > ask) return "ABOVE_ASK";
    if (price === ask) return "AT_ASK";
    if (price < bid) return "BELOW_BID";
    if (price === bid) return "AT_BID";
    const mid = (bid + ask) / 2;
    if (price > mid) return "ASKSIDE";
    if (price < mid) return "BIDSIDE";
    return "MIDMKT";
  }
  // Sin horquilla queda el agresor, que dxFeed sí marca.
  if (p.aggressor === "BUY") return "ASKSIDE";
  if (p.aggressor === "SELL") return "BIDSIDE";
  return "MIDMKT";
}

/**
 * Sentimiento de la impresión, para la etiqueta de la Tarjeta. Comprar calls o
 * vender puts es alcista; lo contrario, bajista. Un cruce en el medio no dice lado.
 */
export function sentimentOf(type: "call" | "put", side: string): string {
  const compra = side === "ABOVE_ASK" || side === "AT_ASK" || side === "ASKSIDE";
  const venta = side === "BELOW_BID" || side === "AT_BID" || side === "BIDSIDE";
  if (!compra && !venta) return "neutral";
  const alcista = type === "call" ? compra : venta;
  return alcista ? "bull" : "bear";
}

/**
 * Condición OPRA sintética. El motor solo mira si la condición es multi-pata (para
 * `flags.multileg`), y eso dxFeed lo marca con `spreadLeg`. Se usan ids REALES del
 * catálogo para no inventar un código que `conditionOf` no sepa traducir:
 * 232 = MLET (multi leg auto-electronic), 209 = AUTO (ejecución automática).
 */
export const COND_MULTI_LEG = 232;
export const COND_SINGLE = 209;

/**
 * Id ESTABLE de una impresión: mismo trade, mismo id en cualquier consulta.
 *
 * No es un capricho: `saveTrades` deduplica por id para acumular los 30 días que
 * Tastytrade no da, y un id de posición en el array (1, 2, 3…) haría que cada
 * corrida volviera a guardar los mismos trades con ids distintos. FNV-1a de
 * símbolo+hora+precio+tamaño, acotado a entero positivo.
 */
export function printId(symbol: string, time: number, price: number, size: number): number {
  const clave = `${symbol}|${time}|${price}|${size}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < clave.length; i++) {
    h ^= clave.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Precio del subyacente en el minuto de la operación, desde las velas de 1m. */
function precioEnMinuto(velas: { time: number; close: number }[], t: number): number {
  if (velas.length === 0) return 0;
  let lo = 0, hi = velas.length - 1, res = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (velas[m].time <= t) { res = m; lo = m + 1; } else { hi = m - 1; }
  }
  return velas[res >= 0 ? res : 0].close;
}

/**
 * Flujo del ticker desde Tastytrade. Lanza si el streamer no da nada, para que el
 * llamador caiga a MarketSnack.
 */
export async function fetchFlowFromTastytrade(
  ticker: string,
  opts: TickerFlowOptions = {},
): Promise<TickerFlowResult> {
  const clean = ticker.trim().toUpperCase();
  const days = opts.days ?? 5;
  const minPremium = opts.minPremium ?? 0;
  const fromTime = Date.now() - days * 86_400_000;
  const token = opts.quoteToken ?? (await fetchQuoteToken());

  // La cadena da dos cosas a la vez: qué símbolos escuchar y las griegas/OI/volumen
  // con los que se rellena cada impresión.
  const { contratos } = await streamChainForFlow(clean, {
    expirations: opts.expirations ?? 8,
    quoteToken: token,
    timeoutMs: opts.timeoutMs,
  });
  if (contratos.size === 0) throw new Error(`Tastytrade no devolvió cadena para ${clean}.`);

  const [prints, velas] = await Promise.all([
    dxlinkTimeAndSale({
      url: token.url, token: token.token,
      symbols: [...contratos.keys()], fromTime,
      timeoutMs: opts.timeoutMs ?? 30_000,
    }),
    // Para el precio del subyacente de cada impresión. Si falla, va a 0 y quien lo
    // use (moneyness de /ideas) lo trata como dato ausente, no como precio.
    fetchTastytradeCandles(clean, "1m", Math.ceil(days) + 1, { quoteToken: token }).catch(() => []),
  ]);
  if (prints.length === 0) throw new Error(`Tastytrade no devolvió Time & Sales para ${clean}.`);

  const porSimbolo = new Map<string, number>();
  const trades: RawTrade[] = [];
  for (const p of prints) {
    const c = contratos.get(p.symbol);
    if (!c) continue;
    porSimbolo.set(p.symbol, (porSimbolo.get(p.symbol) ?? 0) + 1);
    const premium = p.price * p.size * 100;
    if (premium < minPremium) continue;
    const side = sideOf(p);
    trades.push({
      id: printId(c.occ, p.time, p.price, p.size),
      symbol: c.occ,
      price: p.price,
      size: p.size,
      side,
      bid_price: p.bid ?? 0,
      ask_price: p.ask ?? 0,
      premium,
      delta: c.delta ?? 0,
      gamma: c.gamma ?? undefined,
      theta: c.theta ?? undefined,
      vega: c.vega ?? undefined,
      implied_volatility: c.iv ?? 0,
      open_interest: c.openInterest,
      volume: c.volume,
      score: 0,
      sentiment: sentimentOf(c.type, side),
      timestamp: new Date(p.time).toISOString(),
      asset_price: precioEnMinuto(velas, p.time),
      trade_condition_id: p.spreadLeg ? COND_MULTI_LEG : COND_SINGLE,
    });
  }

  const truncated = [...porSimbolo.values()].filter((n) => n >= 1000).length;
  return { trades, source: "tastytrade", truncated };
}

/**
 * Flujo de un ticker con cascada Tastytrade → MarketSnack.
 *
 * El error de MarketSnack se deja salir tal cual (`MarketSnackError`) porque las
 * rutas ya lo traducen a `kind:"marketsnack"` para la UI.
 */
export async function fetchTickerFlow(
  ticker: string,
  opts: TickerFlowOptions & { maxPages?: number; period?: string } = {},
): Promise<TickerFlowResult> {
  if (tastytradeConfigured()) {
    try {
      return await fetchFlowFromTastytrade(ticker, opts);
    } catch {
      // cae a MarketSnack
    }
  }
  const r = await fetchFlow(ticker, {
    period: opts.period ?? `${opts.days ?? 5}d`,
    minPremium: opts.minPremium,
    maxPages: opts.maxPages,
  });
  return { trades: r.trades, source: "marketsnack", truncated: 0 };
}

export { MarketSnackError };
