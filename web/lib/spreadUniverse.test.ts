import { describe, expect, it } from "vitest";
import { SPREAD_UNIVERSE, SPREAD_UNIVERSE_TICKERS } from "./spreadUniverse";

// ETFs/ETNs prohibidos por el mandato (Sección 1). Los del Wheel más los
// sospechosos habituales, para que el test grite si alguien mete uno.
const FORBIDDEN_ETFS = new Set([
  "SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "XLV", "XLY", "XLP",
  "XLI", "XLB", "XLU", "XLC", "XLRE", "SMH", "SOXL", "TQQQ", "SQQQ",
  "ARKK", "GLD", "SLV", "TLT", "HYG", "EEM", "VXX", "UVXY",
]);

describe("SPREAD_UNIVERSE", () => {
  it("no contiene ningún ETF/ETN conocido", () => {
    const offenders = SPREAD_UNIVERSE.filter((s) => FORBIDDEN_ETFS.has(s.ticker));
    expect(offenders).toEqual([]);
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
