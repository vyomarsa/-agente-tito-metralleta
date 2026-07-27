import { describe, expect, it, vi, afterEach } from "vitest";
import {
  macroEventsInWindow,
  addDaysStr,
  fetchReleaseDates,
  fetchMacroCalendar,
  fomcEventsInHorizon,
  type MacroEvent,
} from "./macroCalendar";

const EVENTS: MacroEvent[] = [
  { kind: "FOMC", date: "2026-07-29", label: "Comunicado FOMC" },
  { kind: "CPI", date: "2026-08-12", label: "CPI (IPC)" },
  { kind: "NFP", date: "2026-08-01", label: "Nóminas no agrícolas (NFP)" },
  { kind: "PCE", date: "2026-07-31", label: "Ingresos y Gastos (PCE)" },
];

describe("macroEventsInWindow", () => {
  it("devuelve solo los eventos dentro de la ventana, ordenados por fecha", () => {
    const out = macroEventsInWindow(EVENTS, "2026-07-30", "2026-08-05");
    expect(out.map((e) => e.date)).toEqual(["2026-07-31", "2026-08-01"]);
    expect(out.map((e) => e.kind)).toEqual(["PCE", "NFP"]);
  });

  it("los límites son inclusivos", () => {
    const out = macroEventsInWindow(EVENTS, "2026-07-29", "2026-07-31");
    expect(out.map((e) => e.kind)).toEqual(["FOMC", "PCE"]);
  });

  it("ventana sin eventos devuelve lista vacía (cero es una salida válida)", () => {
    expect(macroEventsInWindow(EVENTS, "2026-09-01", "2026-09-10")).toEqual([]);
  });

  it("desempata por tipo cuando dos eventos caen el mismo día", () => {
    const sameDay: MacroEvent[] = [
      { kind: "PCE", date: "2026-08-01", label: "PCE" },
      { kind: "CPI", date: "2026-08-01", label: "CPI" },
    ];
    const out = macroEventsInWindow(sameDay, "2026-08-01", "2026-08-01");
    expect(out.map((e) => e.kind)).toEqual(["CPI", "PCE"]);
  });
});

describe("addDaysStr", () => {
  it("suma días de calendario cruzando fin de mes", () => {
    expect(addDaysStr("2026-07-29", 5)).toBe("2026-08-03");
  });
  it("suma cero deja la fecha igual", () => {
    expect(addDaysStr("2026-07-26", 0)).toBe("2026-07-26");
  });
});

describe("fetchReleaseDates (I/O con fetch mockeado)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("filtra a fechas futuras dentro del horizonte", async () => {
    const now = new Date("2026-07-26T12:00:00Z");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          release_dates: [
            { release_id: 10, date: "2026-06-10" }, // pasado → fuera
            { release_id: 10, date: "2026-08-12" }, // dentro
            { release_id: 10, date: "2027-01-13" }, // más allá de 120d → fuera
          ],
        }),
      })),
    );
    const out = await fetchReleaseDates(10, "KEY", now);
    expect(out).toEqual(["2026-08-12"]);
  });

  it("lanza si FRED responde !ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(fetchReleaseDates(10, "KEY")).rejects.toThrow(/HTTP 500/);
  });
});

describe("fomcEventsInHorizon", () => {
  it("devuelve solo las fechas FOMC futuras dentro del horizonte de 120 días", () => {
    const now = new Date("2026-07-26T12:00:00Z");
    const out = fomcEventsInHorizon(now);
    // Desde 26-jul, horizonte de 120d llega a ~23-nov: entran 29-jul, 16-sep y 28-oct.
    expect(out.map((e) => e.date)).toEqual(["2026-07-29", "2026-09-16", "2026-10-28"]);
    expect(out.every((e) => e.kind === "FOMC")).toBe(true);
  });
});

describe("fetchMacroCalendar", () => {
  afterEach(() => vi.restoreAllMocks());

  it("combina CPI/NFP/PCE de FRED con el FOMC curado, ordenado por fecha", async () => {
    const now = new Date("2026-07-26T12:00:00Z");
    process.env.FRED_API_KEY = "KEY";
    const byRelease: Record<string, string> = {
      "release_id=10&": "2026-08-12", // CPI
      "release_id=50&": "2026-08-01", // NFP
      "release_id=54&": "2026-07-31", // PCE
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const key = Object.keys(byRelease).find((k) => url.includes(k))!;
        return {
          ok: true,
          json: async () => ({ release_dates: [{ release_id: 0, date: byRelease[key] }] }),
        };
      }),
    );
    const out = await fetchMacroCalendar(now);
    // Ordenado por fecha. FOMC (29-jul, 16-sep, 28-oct) viene de la constante curada.
    expect(out.map((e) => e.date)).toEqual([
      "2026-07-29",
      "2026-07-31",
      "2026-08-01",
      "2026-08-12",
      "2026-09-16",
      "2026-10-28",
    ]);
    expect(out.map((e) => e.kind)).toEqual(["FOMC", "PCE", "NFP", "CPI", "FOMC", "FOMC"]);
  });

  it("lanza si falta FRED_API_KEY", async () => {
    delete process.env.FRED_API_KEY;
    await expect(fetchMacroCalendar()).rejects.toThrow(/FRED_API_KEY/);
  });
});
