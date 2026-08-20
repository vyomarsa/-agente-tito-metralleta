import { describe, expect, it } from "vitest";
import { bsGamma, estimateIV, gexAnalysis, schwabKey, FALLBACK_IV, type GexInput } from "./gex";
import type { Row } from "./types";

// now fijo para DTE determinista.
const NOW = new Date("2026-07-23T15:00:00Z");

function row(strike: number, type: "call" | "put", oi: number, exp = "2026-08-21"): Row {
  return {
    optionTicker: `O:${type}${strike}`,
    contractType: type,
    expiration: exp,
    strike,
    openInterest: oi,
    volume: 0,
    price: 1,
    priceSource: "last_trade",
    openPremium: oi,
    notionalValue: strike * oi * 100,
  };
}

describe("bsGamma", () => {
  it("es 0 con insumos inválidos", () => {
    expect(bsGamma(0, 100, 0.1, 0.4)).toBe(0);
    expect(bsGamma(100, 100, 0, 0.4)).toBe(0);
    expect(bsGamma(100, 100, 0.1, 0)).toBe(0);
  });

  it("pico cerca del dinero (ATM > OTM)", () => {
    const atm = bsGamma(100, 100, 0.1, 0.4);
    const otm = bsGamma(100, 130, 0.1, 0.4);
    expect(atm).toBeGreaterThan(0);
    expect(atm).toBeGreaterThan(otm);
  });
});

describe("estimateIV", () => {
  it("cae al fallback con pocas barras", () => {
    expect(estimateIV([100, 101])).toBe(FALLBACK_IV);
    expect(estimateIV([])).toBe(FALLBACK_IV);
  });

  it("una serie más volátil da IV más alta", () => {
    const calm = Array.from({ length: 22 }, (_, i) => 100 + i * 0.05);
    const wild = Array.from({ length: 22 }, (_, i) => 100 * (1 + (i % 2 === 0 ? 0.04 : -0.04)));
    expect(estimateIV(wild)).toBeGreaterThan(estimateIV(calm));
  });
});

const closes = Array.from({ length: 22 }, (_, i) => 100 + Math.sin(i) * 2);

function analyze(rows: Row[], extra: Partial<GexInput> = {}) {
  return gexAnalysis({ rows, closes, spot: 100, now: NOW, ...extra });
}

describe("gexAnalysis", () => {
  it("devuelve vacío sin filas o sin spot", () => {
    expect(analyze([]).nodes).toHaveLength(0);
    expect(gexAnalysis({ rows: [row(100, "call", 1000)], closes, spot: 0, now: NOW }).nodes).toHaveLength(0);
  });

  it("calls dominan → GEX neto positivo (régimen positivo)", () => {
    const a = analyze([row(100, "call", 5000), row(100, "put", 500)]);
    expect(a.totalNetGex).toBeGreaterThan(0);
    expect(a.regime).toBe("positive");
    expect(a.nodes[0].side).toBe("call");
  });

  it("puts dominan → GEX neto negativo (régimen negativo/amplifica)", () => {
    const a = analyze([row(100, "call", 500), row(100, "put", 5000)]);
    expect(a.totalNetGex).toBeLessThan(0);
    expect(a.regime).toBe("negative");
  });

  it("el nodo principal (imán) es el strike de mayor concentración", () => {
    const a = analyze([
      row(95, "call", 800),
      row(100, "call", 9000), // mayor OI ATM → mayor gamma·OI
      row(105, "call", 600),
    ]);
    expect(a.kingStrike).toBe(100);
    expect(a.direction).toBe("flat");
  });

  it("ignora strikes lejanos (fuera de ±20%) y OI cero / expirados", () => {
    const a = analyze([
      row(100, "call", 1000),
      row(200, "call", 100000),          // lejano
      row(101, "call", 0),               // sin OI
      row(99, "put", 1000, "2020-01-01"), // expirado
    ]);
    expect(a.nodes.map((n) => n.strike).sort()).toEqual([100]);
  });

  it("detecta la zona de inversión gamma entre puts abajo y calls arriba", () => {
    const a = analyze([
      row(95, "put", 8000),
      row(105, "call", 8000),
    ]);
    expect(a.flipStrike).not.toBeNull();
    expect(a.flipStrike!).toBeGreaterThan(95);
    expect(a.flipStrike!).toBeLessThan(105);
  });

  it("el premium de trades reales sube la concentración de su strike", () => {
    const rows = [row(98, "call", 5000), row(102, "call", 5000)];
    const base = analyze(rows);
    const withFlow = analyze(rows, {
      trades: [{ strike: 102, type: "call", premium: 5_000_000, gamma: 0.05 }],
    });
    const c98 = withFlow.nodes.find((n) => n.strike === 98)!.concentration;
    const c102 = withFlow.nodes.find((n) => n.strike === 102)!.concentration;
    expect(c102).toBeGreaterThan(c98);
    void base;
    // con la actividad real concentrada en 102, ese es el nodo principal
    expect(withFlow.kingStrike).toBe(102);
  });

  it("propaga la bandera de baja liquidez", () => {
    expect(analyze([row(100, "call", 1000)], { lowLiquidity: true }).lowLiquidity).toBe(true);
  });

  it("confianza en 0-100", () => {
    const a = analyze([row(100, "call", 5000), row(105, "put", 2000)], {
      convictionScore: 8, structureScore: 7,
    });
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(100);
  });

  it("sin Schwab, la fuente de greeks es 'estimated'", () => {
    const a = analyze([row(100, "call", 5000)]);
    expect(a.greeksSource).toBe("estimated");
    // la IV cae en la estimada por vol realizada
    expect(a.iv).toBe(estimateIV(closes));
  });

  it("con Schwab, usa la IV real y marca la fuente 'schwab'", () => {
    const greeks = new Map([
      [schwabKey(100, "2026-08-21", "call"), { gamma: 0.05, iv: 0.9 }],
    ]);
    const a = analyze([row(100, "call", 5000)], { schwabGreeks: greeks });
    expect(a.greeksSource).toBe("schwab");
    // la IV representativa es la de Schwab (0.9), no la estimada
    expect(a.iv).toBeCloseTo(0.9, 6);
  });

  it("la gamma real de Schwab sustituye a la Black-Scholes en el GEX", () => {
    const rows = [row(100, "call", 5000)];
    const base = analyze(rows);
    // gamma real mucho mayor que la estimada → |GEX neto| mayor
    const big = new Map([
      [schwabKey(100, "2026-08-21", "call"), { gamma: 0.5, iv: 0.4 }],
    ]);
    const withSchwab = analyze(rows, { schwabGreeks: big });
    expect(Math.abs(withSchwab.totalNetGex)).toBeGreaterThan(Math.abs(base.totalNetGex));
  });

  it("un contrato sin entrada en Schwab cae a la estimación (no rompe)", () => {
    // greeks solo para el call; el put no está → se estima como siempre
    const greeks = new Map([
      [schwabKey(100, "2026-08-21", "call"), { gamma: 0.05, iv: 0.5 }],
    ]);
    const a = analyze([row(100, "call", 5000), row(95, "put", 3000)], {
      schwabGreeks: greeks,
    });
    expect(a.nodes.map((n) => n.strike).sort((x, y) => x - y)).toEqual([95, 100]);
  });
});
