import { describe, expect, it } from "vitest";
import { closeOnDate, dailyBarDate, schwabIndexSymbol } from "./barSources";
import type { TfBar } from "./types";

const bar = (iso: string, close: number): TfBar => ({
  time: Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000),
  open: close, high: close, low: close, close,
});

describe("dailyBarDate", () => {
  it("devuelve el día de sesión de una vela diaria", () => {
    expect(dailyBarDate(bar("2026-08-21", 100).time)).toBe("2026-08-21");
  });

  it("una vela marcada a medianoche ET sigue cayendo en su día", () => {
    // Medianoche ET = 04:00 UTC del mismo día.
    const t = Math.floor(Date.parse("2026-08-21T04:00:00Z") / 1000);
    expect(dailyBarDate(t)).toBe("2026-08-21");
  });
});

describe("closeOnDate", () => {
  // La serie del USO alrededor del vencimiento que motivó todo esto.
  const serie = [bar("2026-08-19", 130.91), bar("2026-08-20", 134.54), bar("2026-08-21", 134.64), bar("2026-08-24", 132.21)];

  it("encuentra el cierre del día del vencimiento", () => {
    expect(closeOnDate(serie, "2026-08-21")).toBe(134.64);
  });

  it("NO devuelve el día más cercano: un fin de semana o un feriado da null", () => {
    // Liquidar con el día de al lado es justo el error que se quiere evitar.
    expect(closeOnDate(serie, "2026-08-22")).toBeNull();
  });

  it("sin serie devuelve null en vez de reventar", () => {
    expect(closeOnDate([], "2026-08-21")).toBeNull();
  });
});

describe("schwabIndexSymbol", () => {
  it("traduce los índices que Massive no cotiza", () => {
    expect(schwabIndexSymbol("SPX")).toBe("$SPX");
    expect(schwabIndexSymbol("$SPX")).toBe("$SPX");
  });

  it("una acción no es un índice", () => {
    expect(schwabIndexSymbol("AAPL")).toBeNull();
  });
});
