// Traducción del Time & Sales de Tastytrade al formato del scorecard.
// Lo que se prueba aquí es lo que puede equivocarse en silencio: el LADO (de él
// dependen Agresividad y Convicción), el sentimiento y la estabilidad del id.

import { describe, it, expect } from "vitest";
import { COND_MULTI_LEG, COND_SINGLE, printId, sentimentOf, sideOf } from "./flowSources";
import { aggressionOf, executionLevel } from "./flow";
import { conditionOf, isMultiLegCondition } from "./conditions";

const p = (over: Partial<{ price: number; bid: number | null; ask: number | null; aggressor: string }> = {}) => ({
  price: 1, bid: 0.9, ask: 1.1, aggressor: "UNDEFINED", ...over,
});

describe("sideOf — el lado que consume el scorecard", () => {
  it("por encima del ask y por debajo del bid son los casos agresivos", () => {
    expect(sideOf(p({ price: 1.2 }))).toBe("ABOVE_ASK");
    expect(sideOf(p({ price: 0.8 }))).toBe("BELOW_BID");
  });

  it("clavado en el ask o en el bid", () => {
    expect(sideOf(p({ price: 1.1 }))).toBe("AT_ASK");
    expect(sideOf(p({ price: 0.9 }))).toBe("AT_BID");
  });

  it("entre medias, manda de qué lado del mid cayó", () => {
    expect(sideOf(p({ price: 1.05 }))).toBe("ASKSIDE");
    expect(sideOf(p({ price: 0.95 }))).toBe("BIDSIDE");
    expect(sideOf(p({ price: 1.0 }))).toBe("MIDMKT");
  });

  it("sin horquilla se cae al agresor, que dxFeed sí marca", () => {
    expect(sideOf(p({ bid: null, ask: null, aggressor: "BUY" }))).toBe("ASKSIDE");
    expect(sideOf(p({ bid: null, ask: null, aggressor: "SELL" }))).toBe("BIDSIDE");
    expect(sideOf(p({ bid: null, ask: null }))).toBe("MIDMKT");
  });

  it("los lados que produce los entiende el motor (no son cadenas inventadas)", () => {
    expect(aggressionOf(sideOf(p({ price: 1.2 })))).toBe("ask");
    expect(aggressionOf(sideOf(p({ price: 0.8 })))).toBe("bid");
    expect(aggressionOf(sideOf(p({ price: 1.0 })))).toBe("mid");
    // `executionLevel` es lo que puntúa Convicción: no puede salir "unclear".
    expect(executionLevel(1.2, 0.9, 1.1, sideOf(p({ price: 1.2 })))).toBe("above_ask");
    expect(executionLevel(0.8, 0.9, 1.1, sideOf(p({ price: 0.8 })))).toBe("below_bid");
  });
});

describe("sentimentOf", () => {
  it("comprar calls y vender puts es alcista; lo contrario, bajista", () => {
    expect(sentimentOf("call", "AT_ASK")).toBe("bull");
    expect(sentimentOf("put", "AT_BID")).toBe("bull");
    expect(sentimentOf("call", "BELOW_BID")).toBe("bear");
    expect(sentimentOf("put", "ABOVE_ASK")).toBe("bear");
  });

  it("un cruce en el medio no dice lado", () => {
    expect(sentimentOf("call", "MIDMKT")).toBe("neutral");
  });
});

describe("condiciones sintéticas", () => {
  it("son ids REALES del catálogo, no inventados", () => {
    expect(conditionOf(COND_MULTI_LEG)?.code).toBe("MLET");
    expect(conditionOf(COND_SINGLE)?.code).toBe("AUTO");
  });

  it("solo la multi-pata marca multileg", () => {
    expect(isMultiLegCondition(COND_MULTI_LEG)).toBe(true);
    expect(isMultiLegCondition(COND_SINGLE)).toBe(false);
  });
});

describe("printId", () => {
  it("es ESTABLE: la misma impresión da el mismo id en otra consulta", () => {
    const a = printId("SPY260917C00760000", 1789589690922, 1.2, 10);
    const b = printId("SPY260917C00760000", 1789589690922, 1.2, 10);
    expect(a).toBe(b);
    // Sin esto, `saveTrades` (que deduplica por id) volvería a guardar los mismos
    // trades en cada corrida y el histórico de 30 días de Convicción se inflaría.
  });

  it("distingue impresiones distintas", () => {
    const base = printId("SPY260917C00760000", 1789589690922, 1.2, 10);
    expect(printId("SPY260917P00760000", 1789589690922, 1.2, 10)).not.toBe(base);
    expect(printId("SPY260917C00760000", 1789589690923, 1.2, 10)).not.toBe(base);
    expect(printId("SPY260917C00760000", 1789589690922, 1.25, 10)).not.toBe(base);
    expect(printId("SPY260917C00760000", 1789589690922, 1.2, 11)).not.toBe(base);
  });

  it("siempre es un entero positivo (el motor lo usa como clave numérica)", () => {
    for (const s of ["A", "SPY260917C00760000", "NVDA261016P00300000"]) {
      const id = printId(s, Date.now(), 3.33, 7);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
    }
  });
});
