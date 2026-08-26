import { describe, it, expect } from "vitest";
import { ttGreeksMap, occSymbol } from "./chainSources";
import { schwabKey } from "./gex";
import type { TtContract } from "./tastytrade";

function contrato(p: Partial<TtContract>): TtContract {
  return {
    strike: 100, type: "call", expiration: "2026-09-18", dte: 23,
    bid: 1, ask: 1.2, delta: 0.5, iv: 0.28, gamma: 0.02,
    openInterest: 500, volume: 10, last: 1.1,
    ...p,
  };
}

describe("ttGreeksMap", () => {
  it("indexa por la MISMA clave que consume gexAnalysis", () => {
    const map = ttGreeksMap([contrato({ strike: 250, expiration: "2026-09-18", type: "put" })]);
    expect(map.get(schwabKey(250, "2026-09-18", "put"))).toEqual({ gamma: 0.02, iv: 0.28 });
  });

  it("no confunde el call y el put del mismo strike", () => {
    const map = ttGreeksMap([
      contrato({ strike: 250, type: "call", gamma: 0.03, iv: 0.25 }),
      contrato({ strike: 250, type: "put", gamma: 0.07, iv: 0.31 }),
    ]);
    expect(map.size).toBe(2);
    expect(map.get(schwabKey(250, "2026-09-18", "call"))?.gamma).toBe(0.03);
    expect(map.get(schwabKey(250, "2026-09-18", "put"))?.gamma).toBe(0.07);
  });

  it("descarta el contrato sin gamma NI iv (no tickeó en el snapshot)", () => {
    const map = ttGreeksMap([contrato({ gamma: null, iv: null })]);
    expect(map.size).toBe(0);
  });

  it("conserva el contrato al que solo le llegó una de las dos, con la otra en cero", () => {
    const soloGamma = ttGreeksMap([contrato({ iv: null })]);
    expect(soloGamma.get(schwabKey(100, "2026-09-18", "call"))).toEqual({ gamma: 0.02, iv: 0 });

    const soloIv = ttGreeksMap([contrato({ gamma: null })]);
    expect(soloIv.get(schwabKey(100, "2026-09-18", "call"))).toEqual({ gamma: 0, iv: 0.28 });
  });

  it("trata gamma/iv no positivas como ausentes (dxFeed manda ceros y negativos)", () => {
    expect(ttGreeksMap([contrato({ gamma: 0, iv: 0 })]).size).toBe(0);
    expect(ttGreeksMap([contrato({ gamma: -0.01, iv: null })]).size).toBe(0);
  });

  it("mapa vacío para una cadena vacía", () => {
    expect(ttGreeksMap([]).size).toBe(0);
  });
});

describe("occSymbol", () => {
  it("monta el símbolo OCC con strike ×1000 en 8 dígitos", () => {
    expect(occSymbol("AAPL", "2026-09-18", "call", 250)).toBe("AAPL260918C00250000");
    expect(occSymbol("spy", "2026-01-02", "put", 5.5)).toBe("SPY260102P00005500");
  });
});
