// Sugerencia de contrato para day-trading EN VIVO (pestañas TSLA/SPX de
// "Prueba de Fuego"). PURO — no toca red ni disco.
//
// Dirección y target salen de leer los STRIKES VECINOS de verdad (contratos
// vecinos: net premium real de call vs put por strike, ver
// lib/neighborContracts.ts), no del nodo imán del GEX — el GEX solo se usa
// como último respaldo cuando el strike central no muestra un desequilibrio
// real todavía. Motivo (pedido explícito, 2026-07-28): el
// kingStrike es un nivel de HOY que puede quedar desactualizado mientras el
// precio sigue moviéndose durante el día — TSLA se quedó apuntando a $300
// toda la sesión mientras el subyacente subía, porque el target viejo era
// literalmente `gex.kingStrike` sin importar qué mostraba el flujo real. El
// target ahora siempre es un strike vecino real y cercano (no 20-30 puntos
// de distancia).
//
// (2026-07-30, el usuario: "rearmando por completo la lógica de contratos
// vecinos") — reemplaza el viejo ladder de volumen≥N×OI por el net premium
// real de MarketSnack por contrato.

import type { Row } from "./types";
import type { RawTrade } from "./flow";
import type { GexAnalysis } from "./gex";
import { daysToExpiration, resolveOccRoot } from "./occ";
import { candidateStrikesForSide, pickAtmContract, type ContractCandidate } from "./backtest";
import {
  neighborContractsEntrySignal, NEIGHBOR_WALK_COUNT, wallEntrySignal, WALL_NEIGHBOR_COUNT,
  type StrikePremiums,
} from "./neighborContracts";

// Defaults internos — ya no configurables desde la UI (antes vivían en el
// formulario de backtest; el usuario pidió esconder toda esa config).
export const MIN_DTE = 0;
// Igualado a MAX_DTE de lib/contractSearch.ts (2026-07-28, pedido):
// las pestañas de Prueba de Fuego que NO son SPX buscan contratos hasta 5 DTE.
export const DEFAULT_MAX_DTE = 5;

// SPX pasa a 0DTE puro (2026-08-01, pedido explícito): a diferencia
// de TSLA, SPXW tiene vencimiento diario, y mezclar contratos de días
// distintos diluía la lectura de net premium/GEX del día. Coincide a
// propósito con la expiración que ya usa lib/spxLevels.ts (siempre "hoy").
const ZERO_DTE_TICKERS = new Set(["SPX"]);
export function maxDteFor(ticker: string): number {
  return ZERO_DTE_TICKERS.has(ticker) ? 0 : DEFAULT_MAX_DTE;
}

/**
 * El precio del subyacente del trade MÁS RECIENTE (por timestamp) — cada trade
 * de MarketSnack trae la foto del spot en ese instante (`asset_price`), así que
 * el último trade del día es, de hecho, un precio en vivo real.
 */
export function latestTradeAssetPrice(trades: RawTrade[]): number | null {
  let best: RawTrade | null = null;
  for (const t of trades) {
    if (t.asset_price == null || !(t.asset_price > 0)) continue;
    if (!best || Date.parse(t.timestamp) > Date.parse(best.timestamp)) best = t;
  }
  return best?.asset_price ?? null;
}

/**
 * Resuelve el spot en vivo probando fuentes en orden de frescura real, no de
 * comodidad: el precio del activo de MarketSnack (`fetchAssetPrice`, MISMO
 * dato que muestra su propia UI — ya resuelve solo regular/pre-market/
 * after-hours) primero; el trade más reciente de MarketSnack como segundo
 * respaldo (solo sirve si hubo operaciones de opciones recientes — en
 * pre-market suele no haber, así que puede quedar tan viejo como el cierre);
 * el snapshot de acciones de Massive y el precio embebido en la cadena de
 * opciones después; y solo como último recurso el cierre de la barra diaria
 * — que queda cacheado UNA vez por día de mercado y por eso NO sirve como
 * "precio en vivo" real.
 *
 * Bug real (2026-07-30, TSLA en pre-market): ni el snapshot de acciones de
 * Massive (`fetchCompany`, NO_AUTORIZADO en el plan actual — 403 en
 * `/v2/snapshot/.../stocks/tickers`, `/v2/last/trade`, `/v2/last/nbbo`) ni el
 * precio embebido en la cadena de opciones (`underlying_asset.price`, ausente
 * en el plan actual) reflejan pre-market/after-hours — y el trade más
 * reciente de MarketSnack tampoco, si no hubo opciones operando todavía. Los
 * tres devolvían (o parecían devolver) ~$298 mientras MarketSnack mostraba
 * $304+ en su propio encabezado, vía `latest_price` de `/api/assets/{ticker}`
 * — un endpoint del ACTIVO, no del flujo de opciones, que sí es genuinamente
 * en vivo.
 */
export function resolveLiveSpot(input: {
  assetPrice: number | null;
  companyPrice: number | null;
  chainUnderlyingPrice: number | null;
  trades: RawTrade[];
  lastDailyClose: number | null;
}): number | null {
  if (input.assetPrice != null && input.assetPrice > 0) return input.assetPrice;
  const fromFlow = latestTradeAssetPrice(input.trades);
  if (fromFlow != null) return fromFlow;
  if (input.companyPrice != null && input.companyPrice > 0) return input.companyPrice;
  if (input.chainUnderlyingPrice != null && input.chainUnderlyingPrice > 0) return input.chainUnderlyingPrice;
  return input.lastDailyClose != null && input.lastDailyClose > 0 ? input.lastDailyClose : null;
}

export interface ContractSuggestion {
  ticker: string;
  /**
   * Símbolo OCC raíz real del contrato (ej. "SPXW" para SPX, cuando el índice
   * cotiza sus opciones bajo una raíz distinta al ticker que se pide/muestra).
   * Para TSLA, igual a `ticker`. Ver `resolveOccRoot` (lib/occ.ts) — sin esto,
   * `buildOccSymbol` armaba un símbolo inexistente ("SPX260729C…" en vez de
   * "SPXW260729C…") y el quote en vivo del contrato fallaba silenciosamente.
   */
  occRoot: string;
  type: "call" | "put";
  strike: number;
  expiration: string;
  /** "continuation" = confirmado con net premium real; "gex_only" = solo el GEX, sin desequilibrio todavía. */
  role: "continuation" | "gex_only";
  reason: string;
  target: number;
  spot: number;
  reversalWarning: string | null;
  /** Solo `suggestWallContract` (lib/neighborContracts.ts `wallEntrySignal`): techo/piso y objetivos. */
  resistance?: { strike: number; netPremium: number } | null;
  support?: { strike: number; netPremium: number } | null;
  /** Net premium (en $) que respalda `target` (target1) — el strike ya está en `target`. */
  targetNetPremium?: number;
  target2?: { strike: number; netPremium: number } | null;
}

export interface DayTradeInput {
  ticker: string;
  spot: number;
  chainRows: Row[];
  /** Net premium por strike (call/put) de los strikes vecinos al spot — ver lib/neighborContracts.ts. */
  strikePremiums: Map<number, StrikePremiums>;
  /** Ausente para tickers que no deben usar GEX (pedido: TSLA es solo MarketSnack). */
  gex?: GexAnalysis | null;
  now: Date;
}

function contractAtStrike(
  nearTermRows: Row[],
  type: "call" | "put",
  targetStrike: number,
  now: Date,
  fallbackTicker: string,
  maxDte: number,
): (ContractCandidate & { occRoot: string }) | null {
  const sideRows = nearTermRows.filter((r) => r.contractType === type);
  const candidates: ContractCandidate[] = sideRows.map((r) => ({
    strike: r.strike, expiration: r.expiration, dte: daysToExpiration(r.expiration, now),
  }));
  // maxStrikeDistance chico a propósito: acá ya se decidió el strike exacto
  // (del recorrido de contratos vecinos o del vecino inmediato del GEX), solo
  // falta resolver el vencimiento más próximo dentro de la ventana de
  // day-trading — no un contrato "cercano".
  const picked = pickAtmContract(candidates, targetStrike, { minDte: MIN_DTE, maxDte, maxStrikeDistance: 0.01 });
  if (!picked) return null;
  const matchedRow = sideRows.find((r) => r.strike === picked.strike && r.expiration === picked.expiration);
  const occRoot = matchedRow ? resolveOccRoot(matchedRow.optionTicker, fallbackTicker) : fallbackTicker;
  return { ...picked, occRoot };
}

/**
 * UNA sugerencia (nunca dos) para hoy. Mira quién domina en net premium real
 * (calls vs puts) en el strike más cercano al spot y camina en esa dirección
 * hasta que la dominancia voltea — ese strike de flip es la resistencia/
 * soporte real, y el target es el último strike que todavía confirmaba antes
 * de voltear (ver lib/neighborContracts.ts). Sin desequilibrio real en el
 * strike central, cae al GEX como señal débil — pero el target sigue siendo
 * el vecino inmediato, no el kingStrike. Sin GEX (input.gex ausente) o sin su
 * dirección → null (misma regla de "ante la duda, no operar" del resto del
 * agente). `gex` es opcional a propósito: el usuario pidió que TSLA use solo
 * MarketSnack, sin GEX en absoluto (2026-07-28) — SPX sí lo recibe.
 */
export function suggestDayTradeContract(input: DayTradeInput): ContractSuggestion | null {
  const { ticker, spot, chainRows, strikePremiums, gex, now } = input;
  const maxDte = maxDteFor(ticker);

  const nearTermRows = chainRows.filter((r) => {
    const dte = daysToExpiration(r.expiration, now);
    return dte >= MIN_DTE && dte <= maxDte;
  });
  const strikes = [...new Set(nearTermRows.map((r) => r.strike))];
  if (strikes.length === 0) return null;

  const signal = neighborContractsEntrySignal({ strikes, spot, strikePremiums, count: NEIGHBOR_WALK_COUNT });

  if (signal) {
    const picked = contractAtStrike(nearTermRows, signal.type, signal.target, now, ticker, maxDte);
    if (!picked) return null;
    return {
      ticker, occRoot: picked.occRoot, type: signal.type, strike: picked.strike, expiration: picked.expiration,
      role: "continuation", reason: signal.reason, target: signal.target, spot,
      reversalWarning: signal.reversalWarning,
    };
  }

  // Sin desequilibrio real en el strike central: cae al GEX como señal débil,
  // pero el target sigue siendo el vecino inmediato (realista), no el
  // kingStrike. Sin GEX (TSLA, pedido explícito: solo MarketSnack)
  // no hay señal débil a la que caer — mismo null que "ante la duda, no operar".
  if (!gex || gex.direction == null || gex.direction === "flat") return null;
  const fallbackType: "call" | "put" = gex.direction === "up" ? "call" : "put";
  const fallbackSide = fallbackType === "call" ? "above" : "below";
  const fallbackLadder = candidateStrikesForSide(strikes, spot, fallbackSide, NEIGHBOR_WALK_COUNT);
  const nearbyTarget = fallbackLadder[1] ?? fallbackLadder[0]; // primer vecino más allá del ATM
  if (nearbyTarget == null) return null;

  const picked = contractAtStrike(nearTermRows, fallbackType, nearbyTarget, now, ticker, maxDte);
  if (!picked) return null;

  return {
    ticker, occRoot: picked.occRoot, type: fallbackType, strike: picked.strike, expiration: picked.expiration,
    role: "gex_only",
    reason: `El GEX apunta hacia $${nearbyTarget} como próximo nivel, pero todavía no se confirmó con net premium real.`,
    target: nearbyTarget, spot, reversalWarning: null,
  };
}

/**
 * Variante de `suggestDayTradeContract` que usa la señal de PARED
 * (`wallEntrySignal`, lib/neighborContracts.ts) en vez del walk de dominancia
 * local: pesa la magnitud real del desbalance en dólares en todo el
 * vecindario (6 strikes arriba/abajo — `WALL_NEIGHBOR_COUNT`) en lugar de
 * solo quién gana en el strike centro. Pedido explícito
 * (2026-08-03) tras un backtest manual que mostró mejor tasa de acierto y
 * resultado con este criterio sobre datos reales de un día completo de SPX.
 * Alimenta la pestaña "SPX vecinos" de Prueba de Fuego — separada de la
 * pestaña "SPX" (que sigue con el walk de siempre, `suggestDayTradeContract`)
 * para poder comparar ambas en vivo.
 *
 * Sin respaldo de GEX a propósito, así se validó en el backtest: sin una
 * pared real, no hay señal — misma regla de "ante la duda, no operar" del
 * resto del agente.
 */
export function suggestWallContract(input: DayTradeInput): ContractSuggestion | null {
  const { ticker, spot, chainRows, strikePremiums, now } = input;
  const maxDte = maxDteFor(ticker);

  const nearTermRows = chainRows.filter((r) => {
    const dte = daysToExpiration(r.expiration, now);
    return dte >= MIN_DTE && dte <= maxDte;
  });
  const strikes = [...new Set(nearTermRows.map((r) => r.strike))];
  if (strikes.length === 0) return null;

  const signal = wallEntrySignal({ strikes, spot, strikePremiums, count: WALL_NEIGHBOR_COUNT });
  if (!signal) return null;

  const picked = contractAtStrike(nearTermRows, signal.type, signal.target1.strike, now, ticker, maxDte);
  if (!picked) return null;

  return {
    ticker, occRoot: picked.occRoot, type: signal.type, strike: picked.strike, expiration: picked.expiration,
    role: "continuation", reason: signal.reason, target: signal.target1.strike, spot, reversalWarning: null,
    resistance: signal.resistance, support: signal.support, target2: signal.target2,
    targetNetPremium: signal.target1.netPremium,
  };
}
