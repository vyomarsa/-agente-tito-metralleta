import { describe, expect, it } from "vitest";
import { earningsDeFecha, earningsFlag } from "./earnings";

describe("earningsFlag", () => {
  it("no_aplica cuando no hay fecha (ETF, o el ticker no está cubierto)", () => {
    expect(earningsFlag({ nextEarnings: null, expiration: "2026-09-11", frontSkew: null })).toBe("no_aplica");
  });

  it("fuera cuando el reporte cae después del vencimiento", () => {
    expect(earningsFlag({ nextEarnings: "2026-10-29", expiration: "2026-09-11", frontSkew: null })).toBe("fuera");
  });

  it("dentro cuando el reporte cae antes del vencimiento", () => {
    expect(earningsFlag({ nextEarnings: "2026-09-09", expiration: "2026-09-11", frontSkew: null })).toBe("dentro");
  });

  it("dentro_confirmado si además el skew del frente lo respalda (>10 pts)", () => {
    expect(earningsFlag({ nextEarnings: "2026-09-09", expiration: "2026-09-11", frontSkew: 12 })).toBe("dentro_confirmado");
  });

  it("el mismo día del vencimiento cuenta como dentro", () => {
    expect(earningsFlag({ nextEarnings: "2026-09-11", expiration: "2026-09-11", frontSkew: null })).toBe("dentro");
  });
});

describe("earningsDeFecha", () => {
  const HOY = "2026-09-07";
  const VENCE = "2026-09-11";

  it("una fecha PASADA es 'fuera': ya reportó", () => {
    // El caso real: Tastytrade devuelve a veces el ÚLTIMO reporte, no el próximo.
    // Medido el 2026-09-07 — GOOGL 22-jul, META y MSFT 29-jul, NVDA 26-ago.
    expect(earningsDeFecha("2026-07-22", VENCE, HOY)).toBe("fuera");
    expect(earningsDeFecha("2026-08-26", VENCE, HOY)).toBe("fuera");
  });

  it("una fecha futura DENTRO del vencimiento sigue bloqueando", () => {
    expect(earningsDeFecha("2026-09-09", VENCE, HOY)).toBe("dentro");
  });

  it("una fecha futura MÁS ALLÁ del vencimiento es 'fuera'", () => {
    expect(earningsDeFecha("2026-10-29", VENCE, HOY)).toBe("fuera");
  });

  it("HOY mismo no es pasado: si cae dentro del vencimiento, bloquea", () => {
    expect(earningsDeFecha(HOY, VENCE, HOY)).toBe("dentro");
  });

  it("sin fecha, no se sabe: 'no_aplica'", () => {
    expect(earningsDeFecha(null, VENCE, HOY)).toBe("no_aplica");
  });
});
