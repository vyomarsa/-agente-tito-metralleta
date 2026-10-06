// Resuelve el vecindario de "Contratos vecinos 3.0" (spot + 10 niveles arriba
// + 10 abajo) para UN ticker cualquiera, en vivo — extraído de
// scripts/cv3-live-alert/poll.ts (que antes tenía esta lógica embebida en su
// `main()`) para poder reusarla también desde scripts/telegram-qa/poll.ts
// (pedido explícito: preguntar por Telegram por CUALQUIER ticker,
// no solo los que ya tiene configurados la alerta en vivo — "yo te envío el
// ticker y vos me mandás call o put o no hacer nada"). Misma lógica EXACTA
// que ya usan app/api/contratos-vecinos-3/route.ts (índices) y
// app/api/grandes-empresas/route.ts (acciones) — no un motor aparte.

import { fetchZeroDteChain } from "./tastytradeChain";
import { fetchNearTermChain } from "./massive";
import {
  fetchAssetPrice, fetchContractActivitySummaries, fetchContractActivitySummariesGrouped, fetchGexStats,
} from "./marketsnack";
import { selectWeeklyExpirations, NEAR_TERM_DTE_MAX } from "./grandesEmpresas";
import { etDate } from "./zerodte";
import { NEIGHBOR_COUNT, type ActivityLevel } from "./contratosVecinos3";

export const INDEX_TICKERS = new Set(["SPX", "SPY", "QQQ"]);

export interface GexContext {
  netGex: number;
  regime: "positivo" | "negativo";
  callWall: number;
  putWall: number;
  magnet: number;
  gammaFlip: number | null;
}

/**
 * GEX real (no estimado) de MarketSnack para CUALQUIER ticker — pedido
 * explícito (2026-08-27): "puedes usar el gex de marketsnack...
 * y ver que puedes hacer ahí" para mejorar Contratos 3.0 ("me salen call y
 * puts de 1 minuto, quiero entradas más grandes... mayor a 5 [puntos]").
 * Confirmado en vivo el mismo día: `fetchGexStats` (`gex_stats_chart`) NO es
 * exclusivo de índices — da datos reales igual de completos para acciones
 * individuales (TSLA/CRM/PLTR probados, mismos campos que SPX). Antes esto
 * solo se usaba para SPX (vía `zeroDteGex`, una ESTIMACIÓN Black-Scholes) y
 * en el panel de "Grandes empresas" (dato real, pero sin conectarlo con la
 * señal de Contratos 3.0) — acá se expone igual para todos, real, sin
 * estimar nada, para poder compararlo con el target de la señal de flujo.
 *
 * `regime` = signo de `net_gex`: **positivo** (dealers cubren EN CONTRA del
 * movimiento → tiende a pinear/amortiguar, recorridos cortos) vs
 * **negativo** (dealers cubren A FAVOR del movimiento → lo amplifica,
 * recorridos más largos) — mismo principio ya usado en `lib/zerodte.ts`
 * (`closingForecast`) y `lib/magnetWall.ts` (`REGIME_DISCOUNT`), ahora con el
 * dato REAL en vez de la gamma estimada por Black-Scholes.
 *
 * Puramente informativo por ahora: no cambia `contratosVecinos3Signal` ni
 * decide la señal — pedido explícito es "ver qué se puede hacer",
 * no forzar un filtro todavía sin datos que lo validen. `null` si
 * MarketSnack no tiene nada para ese ticker ahora mismo.
 */
export async function fetchGexContext(ticker: string): Promise<GexContext | null> {
  const buckets = await fetchGexStats(ticker, { period: "1d" }).catch(() => []);
  const latest = buckets.at(-1);
  if (!latest) return null;
  return {
    netGex: latest.net_gex,
    regime: latest.net_gex >= 0 ? "positivo" : "negativo",
    callWall: latest.call_wall,
    putWall: latest.put_wall,
    magnet: latest.magnet,
    gammaFlip: latest.gamma_flip,
  };
}

/**
 * Línea de texto reusada por los dos pollers de Telegram (cv3-live-alert y
 * telegram-qa) — compara el target1 de la señal de flujo contra la pared/imán
 * REAL del GEX del mismo lado: si la pared está MÁS LEJOS que target1, hay
 * "más recorrido real posible" (justo lo que pidió el usuario: "quiero entradas
 * más grandes, 5 puntos, 10, lo que sea mayor a 5"). Régimen positivo avisa
 * que el GEX tiende a pinear (recorridos más cortos); negativo, que amplifica
 * (recorridos más largos) — dicho explícito, no usado para bloquear nada
 * todavía (pendiente de validar con más días de backtest).
 */
export function formatGexNote(gex: GexContext, type: "call" | "put", spot: number, target1Strike: number): string {
  const wall = type === "call" ? gex.callWall : gex.putWall;
  const wallLabel = type === "call" ? "call wall" : "put wall";
  const distToTarget1 = Math.abs(target1Strike - spot);
  const distToWall = Math.abs(wall - spot);
  const regimeNote = gex.regime === "positivo"
    ? "régimen GEX positivo (tiende a pinear, recorridos más cortos)"
    : "régimen GEX negativo (amplifica, recorridos más largos posibles)";
  let roomNote: string;
  if (distToWall > distToTarget1 + 1) {
    roomNote = `📏 más recorrido real posible hacia la ${wallLabel} GEX ($${wall}, a ${distToWall.toFixed(1)} pts) — más allá del target1.`;
  } else {
    roomNote = `La ${wallLabel} GEX ($${wall}) está cerca o antes del target1 — poco margen extra ahí.`;
  }
  return `GEX real: ${regimeNote}. Imán $${gex.magnet}. ${roomNote}`;
}

export interface LiveActivityResult {
  spot: number;
  above: ActivityLevel[];
  below: ActivityLevel[];
}

/**
 * `null` si no se pudo resolver (sin cadena, sin precio) — el caller decide
 * cómo avisarlo (la alerta en vivo lo loguea y no manda nada; el Q&A de
 * Telegram le contesta al usuario explicando qué faltó).
 */
export async function fetchLiveActivityLevels(ticker: string, now: Date): Promise<LiveActivityResult | null> {
  const TICKER = ticker.toUpperCase();

  if (INDEX_TICKERS.has(TICKER)) {
    // SPX/SPY/QQQ — 0DTE vía tastytrade.
    const day = etDate(now);
    const { rows, underlyingPrice } = await fetchZeroDteChain(TICKER, day);
    if (rows.length === 0) return null;
    const msPrice = await fetchAssetPrice(TICKER).catch(() => null);
    const spot = msPrice ?? underlyingPrice ?? 0;
    if (!(spot > 0)) return null;

    const strikes = [...new Set(rows.map((r) => r.strike))];
    const above = strikes.filter((s) => s > spot).sort((a, b) => a - b).slice(0, NEIGHBOR_COUNT);
    const below = strikes.filter((s) => s < spot).sort((a, b) => b - a).slice(0, NEIGHBOR_COUNT);

    const bySymbolKey = new Map<string, string>();
    for (const r of rows) bySymbolKey.set(`${r.strike}|${r.contractType}`, r.optionTicker);
    const callSymbol = (s: number) => bySymbolKey.get(`${s}|call`) ?? null;
    const putSymbol = (s: number) => bySymbolKey.get(`${s}|put`) ?? null;
    const occSymbols = [
      ...above.flatMap((s) => [callSymbol(s), putSymbol(s)]).filter((s): s is string => s != null),
      ...below.flatMap((s) => [putSymbol(s), callSymbol(s)]).filter((s): s is string => s != null),
    ];
    const activityBySymbol = await fetchContractActivitySummaries(occSymbols);

    const above_: ActivityLevel[] = above
      .map((strike): ActivityLevel | null => {
        const symbol = callSymbol(strike);
        const activity = symbol ? activityBySymbol.get(symbol) : undefined;
        if (!activity) return null;
        const otherSymbol = putSymbol(strike);
        const otherActivity = otherSymbol ? (activityBySymbol.get(otherSymbol) ?? null) : null;
        return { strike, type: "call", activity, otherActivity };
      })
      .filter((l): l is ActivityLevel => l != null);
    const below_: ActivityLevel[] = below
      .map((strike): ActivityLevel | null => {
        const symbol = putSymbol(strike);
        const activity = symbol ? activityBySymbol.get(symbol) : undefined;
        if (!activity) return null;
        const otherSymbol = callSymbol(strike);
        const otherActivity = otherSymbol ? (activityBySymbol.get(otherSymbol) ?? null) : null;
        return { strike, type: "put", activity, otherActivity };
      })
      .filter((l): l is ActivityLevel => l != null);
    return { spot, above: above_, below: below_ };
  }

  // Equities (TSLA, PLTR, y cualquier otro ticker con cadena real en Massive)
  // — vencimientos semanales reales, misma lógica que
  // app/api/grandes-empresas/route.ts.
  const chain = await fetchNearTermChain(TICKER, { dteMax: NEAR_TERM_DTE_MAX, now });
  const msPrice = await fetchAssetPrice(TICKER).catch(() => null);
  const spot = msPrice ?? chain.spot ?? 0;
  if (!(spot > 0)) return null;

  const allExpirations = [...new Set(chain.contracts.map((c) => c.expiration))];
  const nearExpirations = selectWeeklyExpirations(allExpirations, now);
  if (nearExpirations.length === 0) return null;
  const nearExpirationSet = new Set(nearExpirations);
  const nearRows = chain.contracts.filter((c) => nearExpirationSet.has(c.expiration));
  const strikeSet = new Set<number>();
  const symbolsByStrikeType = new Map<string, string[]>();
  for (const c of nearRows) {
    strikeSet.add(c.strike);
    const cleanSymbol = c.optionTicker.startsWith("O:") ? c.optionTicker.slice(2) : c.optionTicker;
    const key = `${c.strike}|${c.contractType}`;
    const arr = symbolsByStrikeType.get(key);
    if (arr) arr.push(cleanSymbol); else symbolsByStrikeType.set(key, [cleanSymbol]);
  }
  const strikes = [...strikeSet];
  const above = strikes.filter((s) => s > spot).sort((a, b) => a - b).slice(0, NEIGHBOR_COUNT);
  const below = strikes.filter((s) => s < spot).sort((a, b) => b - a).slice(0, NEIGHBOR_COUNT);
  const callSymbols = (s: number) => symbolsByStrikeType.get(`${s}|call`) ?? [];
  const putSymbols = (s: number) => symbolsByStrikeType.get(`${s}|put`) ?? [];
  const activityGroups = new Map<string, string[]>();
  for (const s of [...above, ...below]) {
    const cs = callSymbols(s);
    const ps = putSymbols(s);
    if (cs.length > 0) activityGroups.set(`${s}|call`, cs);
    if (ps.length > 0) activityGroups.set(`${s}|put`, ps);
  }
  const activityByKey = await fetchContractActivitySummariesGrouped(activityGroups);

  const above_: ActivityLevel[] = above
    .map((strike): ActivityLevel | null => {
      const activity = activityByKey.get(`${strike}|call`);
      if (!activity) return null;
      const otherActivity = activityByKey.get(`${strike}|put`) ?? null;
      return { strike, type: "call", activity, otherActivity };
    })
    .filter((l): l is ActivityLevel => l != null);
  const below_: ActivityLevel[] = below
    .map((strike): ActivityLevel | null => {
      const activity = activityByKey.get(`${strike}|put`);
      if (!activity) return null;
      const otherActivity = activityByKey.get(`${strike}|call`) ?? null;
      return { strike, type: "put", activity, otherActivity };
    })
    .filter((l): l is ActivityLevel => l != null);
  return { spot, above: above_, below: below_ };
}
