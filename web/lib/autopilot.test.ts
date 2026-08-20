import { describe, expect, it } from "vitest";
import {
  swingCandidate,
  intradayCandidate,
  selectCandidates,
  swingProbability,
  SWING_TARGET_PCT,
  SWING_STOP_PCT,
  SWING_DTE_MIN,
  SWING_DTE_MAX,
  type SwingSignal,
  type IntradaySignal,
  type Candidate,
} from "./autopilot";

function swing(over: Partial<SwingSignal> = {}): SwingSignal {
  return {
    ticker: "NVDA", optionType: "call", strike: 200, expiration: "2026-08-21",
    assetPrice: 200, unusualScore: 24, hitRate: 70, ...over,
  };
}
function intra(over: Partial<IntradaySignal> = {}): IntradaySignal {
  return {
    ticker: "SPY", spot: 750, direction: "up", kingStrike: 760, confidence: 72,
    strike: 750, expiration: "2026-08-05", ...over,
  };
}

const AHORA = new Date("2026-08-01T15:00:00Z"); // la señal por defecto queda a 20 DTE

describe("swingCandidate", () => {
  it("call → dirección up, objetivo arriba y stop abajo del subyacente", () => {
    const c = swingCandidate(swing(), AHORA)!;
    expect(c.direction).toBe("up");
    expect(c.optionType).toBe("call");
    expect(c.target).toBeCloseTo(200 * (1 + SWING_TARGET_PCT / 100), 1); // 208
    expect(c.stop).toBeCloseTo(200 * (1 - SWING_STOP_PCT / 100), 1); // 196
    expect(c.trigger).toBeGreaterThan(c.refPrice);
    expect(c.target).toBeGreaterThan(c.trigger);
  });

  it("put → dirección down, objetivo abajo y stop arriba", () => {
    const c = swingCandidate(swing({ optionType: "put", assetPrice: 100 }), AHORA)!;
    expect(c.direction).toBe("down");
    expect(c.target).toBeCloseTo(96, 1);
    expect(c.stop).toBeCloseTo(102, 1);
    expect(c.target).toBeLessThan(c.trigger);
    expect(c.stop).toBeGreaterThan(c.refPrice);
  });

  it("descarta señal sin precio de subyacente", () => {
    expect(swingCandidate(swing({ assetPrice: 0 }), AHORA)).toBeNull();
  });

  // El contrato lo elige la institución, no el agente: llegan desde 2 días hasta
  // LEAPS de 2028. Un plan de ±4% en días no encaja en ninguno de los dos extremos.
  it("descarta un contrato demasiado corto para el plan", () => {
    expect(swingCandidate(swing({ expiration: "2026-08-03" }), AHORA)).toBeNull(); // 2 DTE
  });

  it("descarta un LEAP", () => {
    expect(swingCandidate(swing({ expiration: "2028-12-15" }), AHORA)).toBeNull();
  });

  it("acepta los bordes de la banda", () => {
    const dias = (n: number) => {
      const d = new Date(AHORA);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    expect(swingCandidate(swing({ expiration: dias(SWING_DTE_MIN) }), AHORA)).not.toBeNull();
    expect(swingCandidate(swing({ expiration: dias(SWING_DTE_MAX) }), AHORA)).not.toBeNull();
    expect(swingCandidate(swing({ expiration: dias(SWING_DTE_MIN - 1) }), AHORA)).toBeNull();
    expect(swingCandidate(swing({ expiration: dias(SWING_DTE_MAX + 1) }), AHORA)).toBeNull();
  });

});

describe("swingProbability", () => {
  it("mezcla acierto histórico e inusualidad", () => {
    expect(swingProbability(swing({ hitRate: 70, unusualScore: 24 }))).toBe(79); // 0.5*70 + 0.5*88
  });
  it("sin historial usa solo la inusualidad", () => {
    expect(swingProbability(swing({ hitRate: null, unusualScore: 24 }))).toBe(88);
  });
});

describe("intradayCandidate", () => {
  it("up con imán arriba → call, objetivo = kingStrike", () => {
    const c = intradayCandidate(intra())!;
    expect(c.optionType).toBe("call");
    expect(c.target).toBe(760);
    expect(c.stop).toBeLessThan(c.refPrice); // stop bajo el spot
    expect(c.probability).toBe(72);
    expect(c.note).toBe("Day Trading");
  });

  it("down con imán abajo → put", () => {
    const c = intradayCandidate(intra({ direction: "down", kingStrike: 740 }))!;
    expect(c.optionType).toBe("put");
    expect(c.target).toBe(740);
    expect(c.stop).toBeGreaterThan(c.refPrice);
  });

  it("descarta si no hay dirección clara o el imán está del lado contrario", () => {
    expect(intradayCandidate(intra({ direction: "flat" }))).toBeNull();
    expect(intradayCandidate(intra({ direction: null }))).toBeNull();
    expect(intradayCandidate(intra({ direction: "up", kingStrike: 740 }))).toBeNull(); // imán abajo
    expect(intradayCandidate(intra({ kingStrike: null }))).toBeNull();
  });
});

describe("selectCandidates", () => {
  const base: Candidate = {
    source: "swing", ticker: "AAPL", optionType: "call", strike: 300, expiration: "2026-08-21",
    direction: "up", trigger: 301, target: 312, stop: 294, probability: 75, note: "Swing", refPrice: 300,
  };

  it("descarta los que no superan el umbral", () => {
    const out = selectCandidates([{ ...base, probability: 50 }], { minProb: 60 });
    expect(out).toHaveLength(0);
  });

  it("una entrada por ticker: gana la de mayor probabilidad", () => {
    const out = selectCandidates([
      { ...base, ticker: "TSLA", probability: 65 },
      { ...base, ticker: "TSLA", probability: 80 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].probability).toBe(80);
  });

  it("salta tickers ya ocupados por un trade abierto", () => {
    const out = selectCandidates([base], { blockedTickers: new Set(["AAPL"]) });
    expect(out).toHaveLength(0);
  });

  it("deja pasar varios tickers distintos ordenados por probabilidad", () => {
    const out = selectCandidates([
      { ...base, ticker: "A", probability: 62 },
      { ...base, ticker: "B", probability: 90 },
      { ...base, ticker: "C", probability: 71 },
    ]);
    expect(out.map((c) => c.ticker)).toEqual(["B", "C", "A"]);
  });
});
