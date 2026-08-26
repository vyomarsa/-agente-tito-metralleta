import { describe, expect, it } from "vitest";
import { WHEEL_UNIVERSE } from "./wheelUniverse";

describe("WHEEL_UNIVERSE", () => {
  it("no tiene tickers repetidos", () => {
    const seen = new Set(WHEEL_UNIVERSE.map((s) => s.ticker));
    expect(seen.size).toBe(WHEEL_UNIVERSE.length);
  });

  it("cubre los cuatro tramos, para que una cuenta chica tenga algo que hacer", () => {
    const tiers = new Set(WHEEL_UNIVERSE.map((s) => s.tier));
    expect(tiers).toEqual(new Set(["etf", "barato", "medio", "caro"]));
    expect(WHEEL_UNIVERSE.filter((s) => s.tier === "barato").length).toBeGreaterThanOrEqual(8);
  });

  it("cada entrada declara por qué está", () => {
    for (const s of WHEEL_UNIVERSE) {
      expect(s.ticker).toMatch(/^[A-Z.]{1,6}$/);
      expect(s.razon.length).toBeGreaterThan(8);
    }
  });
});
