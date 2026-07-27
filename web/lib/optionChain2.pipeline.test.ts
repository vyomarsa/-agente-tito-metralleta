// Test de INTEGRACIÓN de la "Option Chain 2.0": una sola cadena cruda de MarketSnack
// (varios vencimientos) recorre las tres integraciones nuevas:
//   A — GEX real         : realGreeksMap + gexByStrike (gamma real, no Black-Scholes)
//   B — Credit Spreads    : expirationsInDteWindow + delta/mid reales por pata (sin Schwab)
//   C — Contexto IV real  : chainIvSurface → ivContextScore (source "chain")
// No pega a la red: valida que el MISMO payload alimenta los tres subsistemas de forma coherente.

import { describe, it, expect } from "vitest";
import {
  normalizeChain2,
  realGreeksMap,
  gexByStrike,
  totalGex,
  chainIvSurface,
  expirationsInDteWindow,
  nearestExpirations,
  dteOf,
  type Chain2RawContract,
} from "./optionChain2";
import { ivContextScore } from "./ivcontext";
import type { FlowRow } from "./flow";

// "Hoy" fijo para que los DTE sean deterministas.
const NOW = new Date("2026-07-27T15:00:00Z");

// Helper: fabrica un contrato crudo como los de option_chain_extended.
function raw(
  o: Partial<Chain2RawContract> & Pick<Chain2RawContract, "expiration" | "strike" | "type" | "symbol">,
): Chain2RawContract {
  return {
    exercise_style: "american",
    greeks: {},
    implied_volatility: null,
    last_quote: {},
    open_interest: 0,
    premium_traded: 0,
    price: null,
    volume: 0,
    ...o,
  };
}

// Cadena cruda multi-vencimiento de un subyacente ~$390 (estilo MSFT).
//   - 2026-07-31 (DTE 4) y 2026-08-03 (DTE 7): caen en la ventana de credit spreads [4,8]
//   - 2026-08-14 (DTE 18): fuera de la ventana, pero cuenta para GEX / superficie IV
const RAW_CHAIN: Chain2RawContract[] = [
  // --- 2026-07-31 (DTE 4): un put OTM Δ≈-0.13 (candidato a pata corta de credit spread) ---
  raw({
    expiration: "2026-07-31", strike: 375, type: "put", symbol: "X260731P00375000",
    greeks: { delta: -0.132, gamma: 0.018 }, implied_volatility: 0.212,
    last_quote: { bid: 0.90, ask: 1.00, mid: 0.95 }, open_interest: 1800, volume: 900,
  }),
  raw({
    expiration: "2026-07-31", strike: 374, type: "put", symbol: "X260731P00374000",
    greeks: { delta: -0.108, gamma: 0.015 }, implied_volatility: 0.216,
    last_quote: { bid: 0.72, ask: 0.80, mid: 0.76 }, open_interest: 1500, volume: 700,
  }),
  raw({
    expiration: "2026-07-31", strike: 390, type: "call", symbol: "X260731C00390000",
    greeks: { delta: 0.55, gamma: 0.061 }, implied_volatility: 0.198,
    last_quote: { bid: 4.1, ask: 4.3, mid: 4.2 }, open_interest: 3200, volume: 2100,
  }),
  // --- 2026-08-03 (DTE 7): también dentro de la ventana ---
  raw({
    expiration: "2026-08-03", strike: 380, type: "put", symbol: "X260803P00380000",
    greeks: { delta: -0.145, gamma: 0.02 }, implied_volatility: 0.205,
    last_quote: { bid: 1.5, ask: 1.6, mid: 1.55 }, open_interest: 2200, volume: 1200,
  }),
  raw({
    expiration: "2026-08-03", strike: 390, type: "call", symbol: "X260803C00390000",
    greeks: { delta: 0.52, gamma: 0.058 }, implied_volatility: 0.201,
    last_quote: { bid: 5.2, ask: 5.4, mid: 5.3 }, open_interest: 4100, volume: 2600,
  }),
  // --- 2026-08-14 (DTE 18): fuera de la ventana de spreads, dentro de GEX/IV ---
  raw({
    expiration: "2026-08-14", strike: 390, type: "call", symbol: "X260814C00390000",
    greeks: { delta: 0.5, gamma: 0.05 }, implied_volatility: 0.23,
    last_quote: { bid: 7.0, ask: 7.4, mid: 7.2 }, open_interest: 5000, volume: 3000,
  }),
  // Contrato "sucio": greeks vacío + IV null (deep OTM). Debe sobrevivir a normalizar
  // pero quedar fuera de GEX (gamma null) y de la superficie IV (iv null).
  raw({
    expiration: "2026-08-14", strike: 300, type: "put", symbol: "X260814P00300000",
    greeks: {}, implied_volatility: null,
    last_quote: { bid: 0.02, ask: 0.05, mid: 0.035 }, open_interest: 120, volume: 3,
  }),
];

describe("pipeline Option Chain 2.0 — una cadena alimenta A/B/C", () => {
  const contracts = normalizeChain2(RAW_CHAIN);
  const spot = 390;

  it("normaliza toda la cadena conservando el basura saneado (delta firmado, iv/gamma null)", () => {
    expect(contracts).toHaveLength(RAW_CHAIN.length);
    const put = contracts.find((c) => c.symbol === "X260731P00375000")!;
    expect(put.delta).toBeCloseTo(-0.132); // put mantiene signo negativo
    expect(put.mid).toBeCloseTo(0.95);
    const dirty = contracts.find((c) => c.symbol === "X260814P00300000")!;
    expect(dirty.gamma).toBeNull();
    expect(dirty.iv).toBeNull();
  });

  describe("A — GEX real por strike", () => {
    it("usa la gamma real de MarketSnack y descarta el contrato sin gamma", () => {
      const map = realGreeksMap(contracts);
      // el contrato deep-OTM (greeks {} + iv null) no entra al override
      expect(map["300|2026-08-14|put"]).toBeUndefined();
      // los demás sí, con su gamma real
      expect(map["390|2026-08-03|call"].gamma).toBeCloseTo(0.058);
      expect(map["375|2026-07-31|put"].iv).toBeCloseTo(0.212);
    });

    it("gexByStrike suma calls (+) y resta puts (−) con la fórmula del documento", () => {
      const strikes = gexByStrike(contracts, spot);
      const s390 = strikes.find((s) => s.strike === 390)!;
      expect(s390).toBeDefined();
      // strike 390 es solo calls en esta cadena → GEX positivo (régimen γ+)
      expect(s390.gex).toBeGreaterThan(0);
      // el strike 300 (gamma null) no debe aparecer
      expect(strikes.find((s) => s.strike === 300)).toBeUndefined();
      // total finito y coherente con la suma de strikes
      expect(totalGex(strikes)).toBeCloseTo(strikes.reduce((a, b) => a + b.gex, 0));
    });
  });

  describe("B — Credit Spreads sin Schwab (delta/mid reales por ventana DTE)", () => {
    const dates = [...new Set(RAW_CHAIN.map((c) => c.expiration))];

    it("expirationsInDteWindow selecciona solo 4–8 DTE (07-31 y 08-03, no 08-14)", () => {
      const window = expirationsInDteWindow(dates, 4, 8, NOW);
      expect(window).toEqual(["2026-07-31", "2026-08-03"]);
      expect(dteOf("2026-07-31", NOW)).toBe(4);
      expect(dteOf("2026-08-03", NOW)).toBe(7);
    });

    it("las patas de la ventana traen delta corto en banda 0.10–0.19 y mid real (sin estimar)", () => {
      const window = expirationsInDteWindow(dates, 4, 8, NOW);
      const legs = contracts.filter(
        (c) => window.includes(c.expiration) && c.type === "put" && c.delta != null,
      );
      // Existen puts cortos con |delta| dentro de la banda estricta del motor de spreads.
      const inBand = legs.filter((c) => Math.abs(c.delta!) >= 0.1 && Math.abs(c.delta!) < 0.2);
      expect(inBand.length).toBeGreaterThan(0);
      // y cada pata trae su MID real (no null): el crédito se calcula sobre mid.
      for (const leg of inBand) expect(leg.mid).not.toBeNull();
    });

    it("hay un par de strikes con ancho $1 en el mismo vencimiento (estructura de 2 patas)", () => {
      // 375 y 374 en 2026-07-31 → ancho $1, ambos con delta y mid reales.
      const short = contracts.find((c) => c.symbol === "X260731P00375000")!;
      const long = contracts.find((c) => c.symbol === "X260731P00374000")!;
      expect(short.strike - long.strike).toBe(1);
      const credit = (short.mid ?? 0) - (long.mid ?? 0); // crédito sobre mid
      expect(credit).toBeGreaterThan(0);
    });
  });

  describe("C — Contexto IV real desde la cadena completa", () => {
    it("chainIvSurface saca IV en % ponderada por prima abierta sobre TODA la cadena", () => {
      const surface = chainIvSurface(contracts, NOW);
      expect(surface.current).not.toBeNull();
      // IVs en la cadena van de ~19.8% a 23% → el ponderado cae dentro del rango.
      expect(surface.current!).toBeGreaterThan(19);
      expect(surface.current!).toBeLessThan(24);
      // tres vencimientos con IV utilizable; el deep-OTM sin IV no crea grupo.
      expect(surface.byExpiration.map((e) => e.expiration)).toEqual([
        "2026-07-31", "2026-08-03", "2026-08-14",
      ]);
    });

    it("ivContextScore usa la superficie de cadena (source 'chain') aunque no haya trades", () => {
      const surface = chainIvSurface(contracts, NOW);
      const score = ivContextScore({
        rows: [], // sin flujo: la IV debe venir de la cadena
        closes: [],
        chainIv: surface,
      });
      expect(score.iv.source).toBe("chain");
      expect(score.iv.current).toBeCloseTo(surface.current!, 6);
      expect(score.byExpiration).toHaveLength(3);
    });

    it("sin chainIv cae al comportamiento previo (source 'trades')", () => {
      const rows: FlowRow[] = [
        {
          id: 1, symbol: "X260731P00375000", underlying: "X", type: "put",
          strike: 375, expiration: "2026-07-31", dte: 4, price: 0.95, size: 10,
          side: "ask", aggression: "neutral" as FlowRow["aggression"], assetPrice: 390,
          bid: 0.9, ask: 1.0, premium: 9500, delta: -0.132, gamma: 0.018,
          theta: -0.1, vega: 0.05, thetaPctDaily: 10, iv: 0.212, openInterest: 1800,
          volume: 900, score: 0, sentiment: "", timestamp: "", conditionCode: null,
          conditionName: null,
        } as FlowRow,
      ];
      const score = ivContextScore({ rows, closes: [] });
      expect(score.iv.source).toBe("trades");
      expect(score.iv.current).toBeCloseTo(21.2, 1); // 0.212 × 100
    });
  });

  it("nearestExpirations (para el heatmap/greeks) devuelve los vencimientos vivos en orden", () => {
    const dates = [...new Set(RAW_CHAIN.map((c) => c.expiration))];
    expect(nearestExpirations(dates, 8, NOW)).toEqual([
      "2026-07-31", "2026-08-03", "2026-08-14",
    ]);
  });
});
