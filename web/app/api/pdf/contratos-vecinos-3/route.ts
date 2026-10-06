// GET /api/contratos-vecinos-3?ticker=SPX|SPY|QQQ — "Contratos vecinos 3.0"
// (Prueba de Fuego). Mismo universo de tickers que Agente ODTE, PERO sin GEX:
// pedido explícito (ago 2026), acá el dinero real de MarketSnack
// decide TODO — dónde hay más Premium Traded marca soportes/resistencias
// candidatos, y el Net Premium ahí confirma la dirección. Ver
// lib/contratosVecinos3.ts para la lógica pura y el ejemplo práctico que dio
// el usuario a mano (SPX en 7750).
//
// Solo mira CALLS arriba del spot y PUTS abajo (nunca al revés) — así lo pidió
// el usuario. El precio en vivo combina MarketSnack (fuente principal, la misma
// que usa el resto del agente) y tastytrade (respaldo, y de paso ya trae la
// cadena de opciones que hace falta para resolver los símbolos OCC).

import { fetchZeroDteChain } from "@/lib/pdf/tastytradeChain";
import { TastytradeError } from "@/lib/pdf/tastytrade";
import { fetchAssetPrice, fetchContractActivitySummaries, MarketSnackError } from "@/lib/pdf/marketsnack";
import { isMarketOpen } from "@/lib/pdf/marketHours";
import { etDate } from "@/lib/pdf/zerodte";
import { contratosVecinos3Signal, orderBookSentiment, NEIGHBOR_COUNT, type ActivityLevel } from "@/lib/pdf/contratosVecinos3";
import { zeroDteGex } from "@/lib/pdf/zerodte";
import { fetchGexContext, formatGexNote } from "@/lib/pdf/liveTickerActivity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_TICKERS = new Set(["SPX", "SPY", "QQQ"]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("ticker") ?? "SPX").trim().toUpperCase();
  const TICKER = SUPPORTED_TICKERS.has(requested) ? requested : "SPX";
  const now = new Date();

  try {
    const day = etDate(now);
    const { rows, underlyingPrice } = await fetchZeroDteChain(TICKER, day);
    if (rows.length === 0) {
      return Response.json(
        { error: `Sin cadena 0DTE de ${TICKER} disponible en tastytrade ahora mismo.` },
        { status: 502 },
      );
    }

    // MarketSnack es la fuente principal de spot en vivo (mismo criterio que
    // el resto del agente); si falla, cae al precio de tastytrade que ya vino
    // con la cadena — nunca deja al usuario sin precio solo porque una de las
    // dos fuentes tuvo un problema puntual.
    const msPrice = await fetchAssetPrice(TICKER).catch(() => null);
    const spot = msPrice ?? underlyingPrice ?? 0;
    if (!(spot > 0)) {
      return Response.json({ error: `Sin precio en vivo de ${TICKER} ahora mismo.` }, { status: 502 });
    }

    const strikes = [...new Set(rows.map((r) => r.strike))];
    const above = strikes.filter((s) => s > spot).sort((a, b) => a - b).slice(0, NEIGHBOR_COUNT);
    const below = strikes.filter((s) => s < spot).sort((a, b) => b - a).slice(0, NEIGHBOR_COUNT);

    const bySymbolKey = new Map<string, string>();
    for (const r of rows) bySymbolKey.set(`${r.strike}|${r.contractType}`, r.optionTicker);

    const callSymbol = (s: number) => bySymbolKey.get(`${s}|call`) ?? null;
    const putSymbol = (s: number) => bySymbolKey.get(`${s}|put`) ?? null;
    // Se pide TAMBIÉN el tipo contrario en cada strike (put arriba del spot,
    // call abajo) — pedido explícito: mostrar los dos net premium
    // lado a lado en la tabla, aunque el motor (`contratosVecinos3Signal`)
    // solo use el tipo primario para decidir la señal.
    const occSymbols = [
      ...above.flatMap((s) => [callSymbol(s), putSymbol(s)]).filter((s): s is string => s != null),
      ...below.flatMap((s) => [putSymbol(s), callSymbol(s)]).filter((s): s is string => s != null),
    ];
    const activityBySymbol = await fetchContractActivitySummaries(occSymbols);

    const aboveLevels: ActivityLevel[] = above
      .map((strike): ActivityLevel | null => {
        const symbol = callSymbol(strike);
        const activity = symbol ? activityBySymbol.get(symbol) : undefined;
        if (!activity) return null;
        const otherSymbol = putSymbol(strike);
        const otherActivity = otherSymbol ? (activityBySymbol.get(otherSymbol) ?? null) : null;
        return { strike, type: "call", activity, otherActivity };
      })
      .filter((l): l is ActivityLevel => l != null);

    const belowLevels: ActivityLevel[] = below
      .map((strike): ActivityLevel | null => {
        const symbol = putSymbol(strike);
        const activity = symbol ? activityBySymbol.get(symbol) : undefined;
        if (!activity) return null;
        const otherSymbol = callSymbol(strike);
        const otherActivity = otherSymbol ? (activityBySymbol.get(otherSymbol) ?? null) : null;
        return { strike, type: "put", activity, otherActivity };
      })
      .filter((l): l is ActivityLevel => l != null);

    const signal = contratosVecinos3Signal({ spot, above: aboveLevels, below: belowLevels });
    const orderBook = orderBookSentiment({ spot, above: aboveLevels, below: belowLevels });

    // Imán del GEX (`lib/zerodte.ts` → `zeroDteGex`, misma cadena ya
    // descargada arriba) — SOLO informativo acá, pedido explícito:
    // "quiero que siempre me muestres... el precio al que está el imán... pero
    // no quiero que tomes una decisión en base a esto". El motor de la señal
    // (`contratosVecinos3Signal`) nunca lo lee.
    const magnetStrike = zeroDteGex(rows, spot).kingStrike;

    // GEX REAL de MarketSnack (no estimado por Black-Scholes como el de
    // arriba) — pedido explícito (2026-08-27): "ponme lo del GEX en
    // contratos 3.0" (ya agregado antes al bot de Telegram, ver
    // lib/liveTickerActivity.ts). Compara la pared real del lado de la
    // operación contra target1: si está más lejos, hay más recorrido real
    // posible — mismo mensaje que ya recibe el usuario por Telegram, ahora
    // también en la pestaña web. Puramente informativo, igual que
    // `magnetStrike`: el motor de la señal nunca lo lee.
    const gex = await fetchGexContext(TICKER).catch(() => null);
    const gexNote = gex && signal.type && signal.target1 ? formatGexNote(gex, signal.type, spot, signal.target1.strike) : null;

    return Response.json({
      ticker: TICKER,
      asOf: now.toISOString(),
      spot,
      marketOpen: isMarketOpen(now),
      magnetStrike,
      gex,
      gexNote,
      above: aboveLevels,
      below: belowLevels,
      signal,
      orderBook,
    });
  } catch (err) {
    const message =
      err instanceof TastytradeError || err instanceof MarketSnackError
        ? err.message
        : "Error inesperado calculando Contratos vecinos 3.0.";
    return Response.json({ error: message }, { status: 502 });
  }
}
