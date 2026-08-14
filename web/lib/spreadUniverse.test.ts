import { describe, expect, it } from "vitest";
import { SPREAD_UNIVERSE, SPREAD_UNIVERSE_TICKERS } from "./spreadUniverse";

// En venta de prima SOLO se permiten los ETFs de ÍNDICE AMPLIO. Cualquier otro
// ETF (sectoriales, apalancados, materias primas, volatilidad) sigue prohibido:
// el test grita si alguien mete uno que no sea SPY/QQQ/IWM.
const ALLOWED_ETFS = new Set(["SPY", "QQQ", "IWM"]);
const FORBIDDEN_ETFS = new Set([
  "DIA", "XLF", "XLE", "XLK", "XLV", "XLY", "XLP",
  "XLI", "XLB", "XLU", "XLC", "XLRE", "SMH", "SOXL", "TQQQ", "SQQQ",
  "ARKK", "GLD", "SLV", "TLT", "HYG", "EEM", "VXX", "UVXY",
]);

describe("SPREAD_UNIVERSE", () => {
  it("solo permite ETFs de índice amplio (SPY/QQQ/IWM), ningún otro ETF/ETN", () => {
    const offenders = SPREAD_UNIVERSE.filter((s) => FORBIDDEN_ETFS.has(s.ticker));
    expect(offenders).toEqual([]);
  });

  it("todo símbolo marcado isEtf está en la lista blanca de índices amplios", () => {
    const flagged = SPREAD_UNIVERSE.filter((s) => s.isEtf).map((s) => s.ticker);
    expect(flagged.length).toBeGreaterThan(0); // hay al menos SPY/QQQ/IWM
    for (const t of flagged) expect(ALLOWED_ETFS.has(t)).toBe(true);
  });

  it("todos los símbolos declaran ticker, sector y razón no vacíos", () => {
    for (const s of SPREAD_UNIVERSE) {
      expect(s.ticker.trim().length).toBeGreaterThan(0);
      expect(s.sector.trim().length).toBeGreaterThan(0);
      expect(s.razon.trim().length).toBeGreaterThan(0);
    }
  });

  it("no hay tickers duplicados", () => {
    expect(SPREAD_UNIVERSE_TICKERS.size).toBe(SPREAD_UNIVERSE.length);
  });
});
