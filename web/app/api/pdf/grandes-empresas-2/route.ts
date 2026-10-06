// GET /api/grandes-empresas-2?ticker=AAPL|MSFT|... — "Grandes empresas 2.0"
// (Prueba de Fuego, ago 2026, pedido explícito): "recreame el
// botón de grandes empresas pero con el motor de 0DTE". Copia deliberada de
// app/api/grandes-empresas/route.ts (NO se toca ese archivo ni
// lib/grandesEmpresas.ts) — mismo pre-market/order-book/gráfica, pero el
// imán/señal viene de lib/grandesEmpresas2Gex.ts (griegos REALES de Schwab,
// el MISMO motor que la pestaña "0DTE") sobre el vencimiento más próximo de
// cada empresa, en vez del GEX pre-calculado de MarketSnack + el net premium
// de "Contratos vecinos 3.0" que usa la versión 1.
//
// Qué se mantiene IGUAL que la v1 (no es "señal/imán", así que no cambia):
//   - Order book (`orderBookSentiment`, net premium real de MarketSnack) —
//     sigue siendo informativo, sin tocar.
//   - % movido en pre-market + "puntos de rechazo" + la gráfica de velas.
// Qué cambia: `magnet`/`signal`/`suggestions` de la v1 se reemplazan por el
// bloque `gex` (ver lib/grandesEmpresas2Gex.ts) — imán real, régimen γ+/γ−,
// GEX Trade (evaluateEntry), GEX Ticket, y las mismas sugerencias de
// estrategia (vertical/credit call/iron condor) que ya tiene la pestaña
// "0DTE". Ojo: `gex.spot` es de Schwab (~15 min delay) — el `spot` de nivel
// superior sigue siendo el en vivo de MarketSnack (para pre-market/order
// book), pueden no coincidir al centavo.

import { fetchActivityGroupedTasty, fetchCompanyBase } from "@/lib/pdf/grandesEmpresasTasty";
import { isMarketOpen, isPreMarket, filterPremarketBars } from "@/lib/pdf/marketHours";
import { etTimeToUnix, marketDateStr } from "@/lib/pdf/occ";
import { findPivots, clusterPivots } from "@/lib/pdf/levels";
import { orderBookSentiment, NEIGHBOR_COUNT, type ActivityLevel } from "@/lib/pdf/contratosVecinos3";
import {
  GRANDES_EMPRESAS_TICKERS,
  DEFAULT_GRANDES_EMPRESA,
  selectWeeklyExpirations,
} from "@/lib/pdf/grandesEmpresas";
import { SP500_TICKERS } from "@/lib/pdf/sp500";
import { fetchCompanyGex, TastytradeError } from "@/lib/pdf/grandesEmpresas2Gex";
import type { TfBar } from "@/lib/pdf/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("ticker") ?? DEFAULT_GRANDES_EMPRESA).trim().toUpperCase();
  const TICKER =
    GRANDES_EMPRESAS_TICKERS.has(requested) || SP500_TICKERS.has(requested) ? requested : DEFAULT_GRANDES_EMPRESA;
  const now = new Date();

  try {
    // `gex` (Schwab) se pide en paralelo con todo lo demás — es la llamada
    // más pesada, esperarla en serie duplicaría el tiempo total (mismo
    // problema ya documentado en la v1 con la cadena de tastytrade).
    // Todo desde Tastytrade (oct 2026): una sola cadena sirve para el order book
    // y para el GEX (antes: Massive + MarketSnack + Schwab).
    const base = await fetchCompanyBase(TICKER);
    const chain = base;
    const { bars15m, dailyBars, todayBars } = base;
    const gex = await fetchCompanyGex(TICKER, now, { tt: base.tt, spot: base.spot })
      .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));

    const spot = base.spot ?? dailyBars.at(-1)?.close ?? 0;
    if (!(spot > 0)) {
      return Response.json({ error: `Sin precio en vivo de ${TICKER} ahora mismo.` }, { status: 502 });
    }

    // Vencimientos "semanales" — SOLO para el vecindario de order book (net
    // premium real, ver v1). El vencimiento que realmente usa el GEX real
    // vive en `gex.expiration` (puede no coincidir exacto con estos).
    const allExpirations = [...new Set(chain.contracts.map((c) => c.expiration))];
    const nearExpirations = selectWeeklyExpirations(allExpirations, now);

    let aboveLevels: ActivityLevel[] = [];
    let belowLevels: ActivityLevel[] = [];
    if (nearExpirations.length > 0) {
      const nearExpirationSet = new Set(nearExpirations);
      const nearRows = chain.contracts.filter((c) => nearExpirationSet.has(c.expiration));
      const strikeSet = new Set<number>();
      const symbolsByStrikeType = new Map<string, string[]>();
      for (const c of nearRows) {
        strikeSet.add(c.strike);
        const cleanSymbol = c.optionTicker.startsWith("O:") ? c.optionTicker.slice(2) : c.optionTicker;
        const key = `${c.strike}|${c.contractType}`;
        const arr = symbolsByStrikeType.get(key);
        if (arr) arr.push(cleanSymbol);
        else symbolsByStrikeType.set(key, [cleanSymbol]);
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
      const streamerOf = new Map(chain.contracts.map((c) => [c.optionTicker, c.streamer]));
      const streamerGroups = new Map(
        [...activityGroups].map(([k, occs]) => [k, occs.map((o) => streamerOf.get(o)).filter((x): x is string => !!x)]),
      );
      const activityByKey = await fetchActivityGroupedTasty(streamerGroups, base.token, now);
      aboveLevels = above
        .map((strike): ActivityLevel | null => {
          const activity = activityByKey.get(`${strike}|call`);
          if (!activity) return null;
          const otherActivity = activityByKey.get(`${strike}|put`) ?? null;
          return { strike, type: "call", activity, otherActivity };
        })
        .filter((l): l is ActivityLevel => l != null);
      belowLevels = below
        .map((strike): ActivityLevel | null => {
          const activity = activityByKey.get(`${strike}|put`);
          if (!activity) return null;
          const otherActivity = activityByKey.get(`${strike}|call`) ?? null;
          return { strike, type: "put", activity, otherActivity };
        })
        .filter((l): l is ActivityLevel => l != null);
    }
    const orderBook = orderBookSentiment({ spot, above: aboveLevels, below: belowLevels });

    // Pre-market — % movido y soportes/resistencias de HOY. MISMA lógica que
    // la v1 (ver ese archivo para el porqué de cada fuente de datos).

    const sessionDateStr =
      todayBars.length > 0 ? marketDateStr(new Date(todayBars.at(-1)!.time * 1000)) : marketDateStr(now);
    const premarketBars = filterPremarketBars(todayBars, sessionDateStr);
    const priorDailyBars = dailyBars.filter((b) => marketDateStr(new Date(b.time * 1000)) < sessionDateStr);
    const prevClose = priorDailyBars.at(-1)?.close ?? null;
    const premarketLastClose = premarketBars.at(-1)?.close ?? null;
    const premarketReference = isPreMarket(now) ? spot : (premarketLastClose ?? spot);
    const premarketChangePct =
      prevClose != null && prevClose > 0 && (isPreMarket(now) || premarketLastClose != null)
        ? ((premarketReference - prevClose) / prevClose) * 100
        : null;

    const premarketRejections =
      premarketBars.length >= 3
        ? clusterPivots(
            findPivots(
              premarketBars.map((b) => ({
                time: marketDateStr(new Date(b.time * 1000)),
                high: b.high,
                low: b.low,
                close: b.close,
              })),
              1,
            ),
            0.2,
          ).map((c) => ({
            price: c.price,
            touches: c.touches,
            kind: c.highs >= c.lows ? ("techo" as const) : ("piso" as const),
          }))
        : [];

    const lastMassiveTime = bars15m.at(-1)?.time ?? 0;
    const chartBars: TfBar[] = [...bars15m, ...todayBars.filter((b) => b.time > lastMassiveTime)];
    const chartDates = [...new Set(chartBars.map((b) => marketDateStr(new Date(b.time * 1000))))];
    const premarketWindows = chartDates.map((d) => ({
      from: etTimeToUnix(d, 4, 0),
      to: etTimeToUnix(d, 9, 30),
    }));

    return Response.json({
      ticker: TICKER,
      asOf: now.toISOString(),
      spot,
      prevClose,
      premarketChangePct,
      isPreMarket: isPreMarket(now),
      marketOpen: isMarketOpen(now),
      orderBookExpirations: nearExpirations,
      bars: chartBars,
      premarketWindows,
      premarketRejections,
      above: aboveLevels,
      below: belowLevels,
      orderBook,
      gex: "error" in gex ? null : gex,
      gexError: "error" in gex ? gex.error : null,
    });
  } catch (err) {
    const message =
      err instanceof TastytradeError
        ? err.message
        : "Error inesperado analizando la empresa.";
    return Response.json({ error: message }, { status: 502 });
  }
}
