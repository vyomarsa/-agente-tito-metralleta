// GET /api/magnet-wall?ticker= — "Contratos vecinos 2.0" (Prueba de Fuego).
// Mismo selector de ticker que "Agente ODTE" (SPX/SPY/QQQ/ES/NQ, default SPX).
//
// SPX/SPY/QQQ: opciones de ÍNDICE/equity vía tastytrade (zeroDteGex, griegos
// reales) + net premium real de MarketSnack para confirmar el camino.
//
// ES/NQ: a diferencia del selector de Agente ODTE (que los trata como alias
// de display de SPX/NDX), acá son DATOS REALES del futuro — pedido explícito
//: poder operar mientras el mercado de acciones/índice está
// cerrado, ya que CME (ES/NQ) cotiza casi 24/5. Resuelve el contrato de
// futuro activo + su propia cadena de opciones diarias (lib/futuresChain.ts).
// Sin MarketSnack (no cubre CME — comprobado en vivo: "ES" ahí es la acción
// Eversource Energy, no el futuro) — la dirección sale solo del GEX real de
// tastytrade, sin confirmar por net premium (ver `hasFlowCoverage` en
// lib/magnetWall.ts).
//
// PERO con el mercado de acciones/índice ABIERTO, MarketSnack sí cubre el
// índice hermano (SPX para ES, NDX para NQ) — pedido explícito:
// "cuando abre el mercado combina MarketSnack y tastytrade para futuros,
// para mayor precisión". `fetchCrossMarketFlow` corre la misma señal de
// pared (`wallEntrySignal`, lib/neighborContracts.ts) sobre la cadena REAL
// del índice hermano y se la pasa a `magnetWallSignal` como confirmación
// cruzada — sube la confianza si coincide con el imán de ES/NQ, avisa si
// contradice. Envuelto en try/catch: es una mejora, no debe tumbar la
// respuesta si MarketSnack falla.

import { FALLBACK_IV } from "@/lib/pdf/gex";
import { atmIV, etDate, hoursToClose, zeroDteGex } from "@/lib/pdf/zerodte";
import { fetchZeroDteChain } from "@/lib/pdf/tastytradeChain";
import { fetchActiveFuturesOptionChain } from "@/lib/pdf/futuresChain";
import { TastytradeError } from "@/lib/pdf/tastytrade";
import { fetchContractPremiumSummaries, MarketSnackError } from "@/lib/pdf/marketsnack";
import { isFuturesMarketOpen, isMarketOpen } from "@/lib/pdf/marketHours";
import {
  magnetWallSignal, wallEntrySignalFromPositioning, MAGNET_WALL_NEIGHBOR_COUNT,
  type CrossMarketFlow,
} from "@/lib/pdf/magnetWall";
import { probTouch } from "@/lib/pdf/expectedMove";
import { candidateStrikesForSide } from "@/lib/pdf/backtest";
import { zeroDteTickerConfig } from "@/lib/pdf/zerodteTickers";
import { wallEntrySignal, WALL_NEIGHBOR_COUNT, type StrikePremiums, type WallEntrySignal, type WallTarget } from "@/lib/pdf/neighborContracts";
import type { ZRow } from "@/lib/pdf/zerodteTypes";
import type { MagnetWallSignal } from "@/lib/pdf/magnetWall";
import type { GexChainLine, GexChainSide } from "@/app/prueba-de-fuego/types";

/**
 * "Mejor entrada" — pedido explícito (ago 2026): un segundo veredicto
 * independiente del imán del GEX ("porque a veces el imán se mueve"), la MISMA
 * pared de dinero que ya usa "SPX vecinos" (`wallEntrySignal`), pero con
 * probabilidad de toque agregada (estadística pura — distancia + IV + horas al
 * cierre, sin el ajuste por agresividad/régimen que sí lleva el imán, a
 * propósito: son dos lecturas distintas para comparar, no la misma pesada dos
 * veces). Para ES/NQ (pedido explícito, sin cobertura de
 * MarketSnack en CME) usa `wallEntrySignalFromPositioning` — misma geometría,
 * pero Open Interest × gamma real de tastytrade en vez de net premium; el
 * campo `source` le dice a la UI cuál de las dos fue.
 */
interface BestEntrySource {
  type: "call" | "put";
  wallStrike: number;
  wallMagnitude: number;
  resistance: WallTarget | null;
  support: WallTarget | null;
  target1: WallTarget | null;
  target2: WallTarget | null;
  reason: string;
}

export interface BestEntry extends BestEntrySource {
  source: "flow" | "positioning";
  target1Probability: number | null;
  target2Probability: number | null;
  resistanceProbability: number | null;
  supportProbability: number | null;
}

function withTouchProbabilities(
  entry: BestEntrySource,
  spot: number, iv: number, hoursLeft: number,
  source: "flow" | "positioning",
): BestEntry {
  const days = hoursLeft / 24;
  const prob = (t: WallTarget | null) => (t ? probTouch(spot, t.strike, iv, days) : null);
  return {
    ...entry,
    source,
    target1Probability: prob(entry.target1),
    target2Probability: prob(entry.target2),
    resistanceProbability: prob(entry.resistance),
    supportProbability: prob(entry.support),
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Productos CME reales con datos propios — el resto (SPX/SPY/QQQ) sigue la cadena de índice/equity. */
const FUTURES_PRODUCTS = new Set(["ES", "NQ"]);
/** SPX para ES, NDX para NQ — el índice hermano que sí cubre MarketSnack. */
const CROSS_MARKET_UNDERLYING: Record<string, string> = { ES: "SPX", NQ: "NDX" };

/** Resuelve símbolo real de tastytrade por strike + arma el net premium de MarketSnack del vecindario. Compartido por el camino de índice y la confirmación cruzada de futuros. */
async function fetchNetPremiumNeighborhood(
  rows: { strike: number; contractType: "call" | "put"; optionTicker: string }[],
  spot: number,
  count: number,
): Promise<{ strikes: number[]; strikePremiums: Map<number, StrikePremiums> }> {
  const bySymbolKey = new Map<string, string>();
  for (const r of rows) bySymbolKey.set(`${r.strike}|${r.contractType}`, r.optionTicker);

  const strikes = [...new Set(rows.map((r) => r.strike))];
  const above = candidateStrikesForSide(strikes, spot, "above", count);
  const below = candidateStrikesForSide(strikes, spot, "below", count);
  const neighborhood = [...new Set([...above, ...below])];

  const occSymbols = neighborhood
    .flatMap((s) => [bySymbolKey.get(`${s}|call`), bySymbolKey.get(`${s}|put`)])
    .filter((s): s is string => s != null);
  const premiumsBySymbol = await fetchContractPremiumSummaries(occSymbols);

  const strikePremiums = new Map<number, StrikePremiums>();
  for (const s of neighborhood) {
    const callSymbol = bySymbolKey.get(`${s}|call`) ?? null;
    const putSymbol = bySymbolKey.get(`${s}|put`) ?? null;
    strikePremiums.set(s, {
      strike: s,
      call: callSymbol ? premiumsBySymbol.get(callSymbol) ?? null : null,
      put: putSymbol ? premiumsBySymbol.get(putSymbol) ?? null : null,
    });
  }
  return { strikes, strikePremiums };
}

/**
 * Arma la tabla estilo option-chain (calls | strike | puts) para el "Mapa
 * del GEX" — pedido explícito: que se vea como la tabla de Agente
 * ODTE, no una lista de barras. `strikesToShow` ya viene decidido por el
 * caller (los strikes más cercanos al spot + los que el propio `signal`
 * marcó como soporte/resistencia clave, aunque queden un poco más lejos).
 */
function buildGexChainLines(rows: ZRow[], strikesToShow: number[]): GexChainLine[] {
  const byKey = new Map<string, ZRow>();
  for (const r of rows) byKey.set(`${r.strike}|${r.contractType}`, r);
  const toSide = (r: ZRow | undefined): GexChainSide | null =>
    r ? { volume: r.volume, openInterest: r.openInterest, delta: r.greeks?.delta ?? null } : null;
  return strikesToShow
    .map((strike) => ({ strike, call: toSide(byKey.get(`${strike}|call`)), put: toSide(byKey.get(`${strike}|put`)) }))
    .sort((a, b) => b.strike - a.strike);
}

/** Los strikes más cercanos al spot + los que el signal ya marcó como soporte/resistencia clave (targets hacia el imán o de ruptura), aunque queden fuera de esa ventana. */
function pickDisplayStrikes(nodeStrikes: number[], spot: number, signal: MagnetWallSignal | null, radius = 22): number[] {
  const near = [...nodeStrikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, radius);
  const key = signal ? [...signal.towardTargets, ...signal.breakoutTargets].map((t) => t.strike) : [];
  return [...new Set([...near, ...key])];
}

/**
 * Confirmación cruzada del flujo real de MarketSnack en el índice hermano —
 * solo tiene sentido con el mercado de acciones/índice ABIERTO (fuera de esa
 * ventana MarketSnack no tiene flujo fresco ni de SPX/NDX, y `wallEntrySignal`
 * daría una lectura vieja). `null` si el mercado está cerrado, sin chain, o
 * sin una pared real (misma regla de "ante la duda, no operar").
 */
async function fetchCrossMarketFlow(productCode: string, now: Date): Promise<CrossMarketFlow | null> {
  if (!isMarketOpen(now)) return null;
  const underlying = CROSS_MARKET_UNDERLYING[productCode];
  if (!underlying) return null;

  const day = etDate(now);
  const { rows, underlyingPrice } = await fetchZeroDteChain(underlying, day);
  const spot = underlyingPrice ?? 0;
  if (!(spot > 0) || rows.length === 0) return null;

  const { strikes, strikePremiums } = await fetchNetPremiumNeighborhood(rows, spot, WALL_NEIGHBOR_COUNT);
  const wall = wallEntrySignal({ strikes, spot, strikePremiums });
  return wall ? { direction: wall.type, underlying } : null;
}

export async function GET(request: Request) {
  const now = new Date();
  const { searchParams } = new URL(request.url);
  const requestedId = (searchParams.get("ticker") ?? "").toUpperCase();

  try {
    if (FUTURES_PRODUCTS.has(requestedId)) {
      return await buildFuturesResponse(requestedId, now);
    }
    return await buildIndexResponse(zeroDteTickerConfig(requestedId).underlying, now);
  } catch (err) {
    const message =
      err instanceof TastytradeError || err instanceof MarketSnackError
        ? err.message
        : "Error inesperado calculando Contratos vecinos 2.0.";
    return Response.json({ error: message }, { status: 502 });
  }
}

async function buildIndexResponse(TICKER: string, now: Date) {
  const day = etDate(now);
  const { rows, underlyingPrice, delayed } = await fetchZeroDteChain(TICKER, day);
  const spot = underlyingPrice ?? 0;
  if (!(spot > 0) || rows.length === 0) {
    return Response.json(
      { error: `Sin cadena 0DTE de ${TICKER} disponible en tastytrade ahora mismo.` },
      { status: 502 },
    );
  }

  const gex = zeroDteGex(rows, spot);
  const iv = atmIV(rows, spot) ?? FALLBACK_IV;
  const hrs = hoursToClose(now);

  const { strikes, strikePremiums } = await fetchNetPremiumNeighborhood(rows, spot, MAGNET_WALL_NEIGHBOR_COUNT);
  const magnetConcentration = gex.nodes.find((n) => n.strike === gex.kingStrike)?.concentration ?? 0;

  const signal = magnetWallSignal({
    spot, strikes, strikePremiums,
    magnetStrike: gex.kingStrike, magnetConcentration,
    iv, daysToClose: hrs / 24, regime: gex.regime,
  });

  const chainLines = buildGexChainLines(rows, pickDisplayStrikes(gex.nodes.map((n) => n.strike), spot, signal));

  const wallEntry = wallEntrySignal({ strikes, spot, strikePremiums });
  const bestEntry = wallEntry ? withTouchProbabilities(wallEntry, spot, iv, hrs, "flow") : null;

  return Response.json({
    ticker: TICKER,
    asOf: now.toISOString(),
    spot,
    iv,
    hoursToClose: hrs,
    marketOpen: isMarketOpen(now),
    delayed,
    gex,
    signal,
    chainLines,
    bestEntry,
  });
}

async function buildFuturesResponse(productCode: string, now: Date) {
  const chain = await fetchActiveFuturesOptionChain(productCode, now);
  const spot = chain.underlyingPrice ?? 0;
  if (!(spot > 0) || chain.rows.length === 0) {
    return Response.json(
      { error: `Sin cotización o cadena de opciones de /${productCode} disponible en tastytrade ahora mismo.` },
      { status: 502 },
    );
  }

  const gex = zeroDteGex(chain.rows, spot);
  const iv = atmIV(chain.rows, spot) ?? FALLBACK_IV;
  const hrs = chain.stopsTradingAt
    ? Math.max(0, (Date.parse(chain.stopsTradingAt) - now.getTime()) / 3_600_000)
    : 0;

  const strikes = [...new Set(chain.rows.map((r) => r.strike))];
  const magnetConcentration = gex.nodes.find((n) => n.strike === gex.kingStrike)?.concentration ?? 0;

  // Sin MarketSnack para futuros (CME no está cubierto), pero SÍ hay
  // posicionamiento real (Open Interest × gamma real de tastytrade) por
  // strike — mismos nodos que ya calculó zeroDteGex, reusados como respaldo
  // de confirmación en vez de dejar el vecindario totalmente sin datos.
  const positioningLevels = new Map(gex.nodes.map((n) => [n.strike, { strike: n.strike, callGex: n.callGex, putGex: n.putGex }]));

  // Con el mercado de acciones/índice abierto, MarketSnack sí cubre el
  // índice hermano (SPX/NDX) — se usa como confirmación cruzada extra.
  // Envuelto en catch: es una mejora, no debe tumbar la respuesta de ES/NQ
  // si MarketSnack falla (cookie vencida, etc.).
  const crossMarketFlow = await fetchCrossMarketFlow(productCode, now).catch(() => null);

  const signal = magnetWallSignal({
    spot, strikes, strikePremiums: new Map(),
    magnetStrike: gex.kingStrike, magnetConcentration,
    iv, daysToClose: hrs / 24, regime: gex.regime,
    hasFlowCoverage: false, positioningLevels, crossMarketFlow,
  });

  const chainLines = buildGexChainLines(chain.rows, pickDisplayStrikes(gex.nodes.map((n) => n.strike), spot, signal));

  // Sin MarketSnack para CME, "Mejor entrada" usa la MISMA geometría de pared
  // (lib/neighborContracts.ts → wallGeometryFromLevels) pero sobre Open
  // Interest × gamma real de tastytrade en vez de net premium ejecutado —
  // pedido explícito: "en ES y NQ puedes usar tastytrade y darme la
  // mejor entrada, según la información dada". `positioningLevels` ya está
  // armado arriba para el respaldo del panel del imán; se reusa tal cual.
  const positioningEntry = wallEntrySignalFromPositioning({ strikes, spot, positioningLevels });
  const bestEntry = positioningEntry ? withTouchProbabilities(positioningEntry, spot, iv, hrs, "positioning") : null;

  return Response.json({
    ticker: `/${productCode}`,
    asOf: now.toISOString(),
    spot,
    iv,
    hoursToClose: hrs,
    marketOpen: isFuturesMarketOpen(now),
    delayed: false,
    gex,
    signal,
    chainLines,
    bestEntry,
    futureSymbol: chain.futureSymbol,
    expirationDate: chain.expirationDate,
  });
}
