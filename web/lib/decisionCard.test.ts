import { describe, it, expect } from "vitest";
import { buildDecisionCard, type DecisionInput, type FlowTapeRow } from "./decisionCard";
import type { GexAnalysis } from "./gex";
import type { ProPrediction, Scenario } from "./prediction";
import type { LevelsReport, Level, LevelSource } from "./levels";
import type { NewsBias } from "./news";

// ── Fixtures ─────────────────────────────────────────────────────────────

const SRC: LevelSource = {
  touches: 3, lastTouch: "2026-08-01", openInterest: 10000, notional: 5e6, flowPremium: 2e6, netGex: 1e6,
};

function level(price: number, kind: Level["kind"], strength: number): Level {
  return { price, kind, strength, distancePct: 0, sources: SRC, flipped: false, why: "test" };
}

function scenario(kind: Scenario["kind"], target: number, prob = 0.4): Scenario {
  return { kind, target, changePct: 0, probability: prob, driver: "test" };
}

function gexOf(over: Partial<GexAnalysis> = {}): GexAnalysis {
  return {
    spot: 100, iv: 0.4,
    nodes: [
      { strike: 105, netGex: 2e6, callGex: 2e6, putGex: 0, tradePremium: 1e6, tradeCount: 5, concentration: 0.9, side: "call" },
    ],
    kingStrike: 105, flipStrike: 98, regime: "negative", totalNetGex: 1e6,
    direction: "up", confidence: 70, lowLiquidity: false, n: 12, greeksSource: "marketsnack",
    ...over,
  };
}

function predOf(over: Partial<ProPrediction> = {}): ProPrediction {
  return {
    horizonDays: 10, spot: 100, iv: 0.4,
    bear: scenario("bear", 94), base: scenario("base", 103), bull: scenario("bull", 108),
    score: 62, active: 6, confidence: 68, levels: [], direction: "up",
    summary: "test", caveat: null, calibration: { applied: false, shiftPct: 0, samples: 0 },
    ...over,
  };
}

function levelsOf(over: Partial<LevelsReport> = {}): LevelsReport {
  return {
    spot: 100,
    supports: [level(96, "soporte", 55)],
    resistances: [level(106, "resistencia", 50)],
    keySupport: level(96, "soporte", 55),
    keyResistance: level(106, "resistencia", 50),
    tolerancePct: 1,
    ...over,
  };
}

function newsOf(over: Partial<NewsBias> = {}): NewsBias {
  return { bias: "bullish", score: 0.4, positive: 3, negative: 0, neutral: 1, ...over };
}

const FLOW: FlowTapeRow[] = [
  { contract: "AAPL 105C", side: "BUY", size: 500, premium: 1e6, spot: 100, sentiment: "bull" },
];

/** Cierres en tendencia alcista clara: precio > SMA20 > SMA50. */
function bullishCloses(): number[] {
  return Array.from({ length: 60 }, (_, i) => 80 + i * 0.4); // sube monótono → alcista
}
function lateralCloses(): number[] {
  return Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5)); // sierra plana
}

function baseInput(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    ticker: "AAPL", company: "Apple Inc.", spot: 100, now: new Date("2026-08-09T14:00:00Z"),
    horizonDays: 10, closes: bullishCloses(), prevHigh: 99, prevLow: 97,
    gex: gexOf(), prediction: predOf(), levels: levelsOf(), news: newsOf(),
    callPct: 70, flowTape: FLOW, gammaLadder: [], premarketAvailable: false,
    ...over,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildDecisionCard — confluencia y semáforo", () => {
  it("setup alcista limpio → EJECUTAR o ESPERAR con score alto", () => {
    const card = buildDecisionCard(baseInput());
    expect(card.bias).toBe("ALCISTA");
    expect(card.scoreTotal).toBeGreaterThanOrEqual(8);
    expect(["EJECUTAR", "ESPERAR TRIGGER"]).toContain(card.decision);
    expect(card.factors).toHaveLength(7);
  });

  it("el score total es la suma de los 7 factores (0-14)", () => {
    const card = buildDecisionCard(baseInput());
    const sum = card.factors.reduce((s, f) => s + f.points, 0);
    expect(card.scoreTotal).toBe(sum);
    expect(card.scoreTotal).toBeLessThanOrEqual(14);
    expect(card.scoreTotal).toBeGreaterThanOrEqual(0);
  });

  it("sin invalidación (sin niveles guardián) → NO TRADE, setup C", () => {
    const card = buildDecisionCard(
      baseInput({ levels: levelsOf({ supports: [], keySupport: null }) }),
    );
    expect(card.decision).toBe("NO TRADE");
    expect(card.setup).toBe("C");
    expect(card.degradations.some((d) => d.includes("invalidación"))).toBe(true);
  });

  it("cadena ilíquida → NO TRADE aunque el resto alinee", () => {
    const card = buildDecisionCard(baseInput({ gex: gexOf({ lowLiquidity: true }) }));
    expect(card.decision).toBe("NO TRADE");
    expect(card.decisionNote.toLowerCase()).toContain("ilíquid");
  });

  it("precio pegado a la pared (rango < mínimo) → degrada y ESPERAR/NO", () => {
    // resistencia a 100.5 con spot 100 → 0.5% de rango (< 1.5%)
    const card = buildDecisionCard(
      baseInput({ levels: levelsOf({ resistances: [level(100.5, "resistencia", 50)] }) }),
    );
    expect(card.degradations.some((d) => d.includes("Rango insuficiente"))).toBe(true);
    expect(["ESPERAR TRIGGER", "NO TRADE"]).toContain(card.decision);
  });

  it("tendencia lateral + dirección plana → NO TRADE", () => {
    const card = buildDecisionCard(
      baseInput({
        closes: lateralCloses(),
        prediction: predOf({ direction: "flat", score: 50 }),
        gex: gexOf({ direction: "flat", regime: "positive" }),
      }),
    );
    expect(card.bias).toBe("NEUTRAL");
    expect(card.decision).toBe("NO TRADE");
    // El factor de estructura debe fallar (lateral).
    expect(card.factors.find((f) => f.key === "structure")?.points).toBe(0);
  });

  it("compresión γ+ con tesis direccional → ESPERAR TRIGGER (la ruptura se gana)", () => {
    const card = buildDecisionCard(baseInput({ gex: gexOf({ regime: "positive" }) }));
    expect(card.decision).toBe("ESPERAR TRIGGER");
    expect(card.factors.find((f) => f.key === "gex")?.points).toBe(1);
  });
});

describe("buildDecisionCard — degradación y datos faltantes", () => {
  it("greeks estimados (GEX Black-Scholes) → degrada setup y marca DATO NO DISPONIBLE", () => {
    const card = buildDecisionCard(baseInput({ gex: gexOf({ greeksSource: "estimated" }) }));
    expect(card.degradations.some((d) => d.includes("Capa de opciones"))).toBe(true);
    expect(card.missingData.some((m) => m.includes("Greeks"))).toBe(true);
  });

  it("premarket no disponible se reporta en missingData y limita el factor 2", () => {
    const card = buildDecisionCard(baseInput({ premarketAvailable: false }));
    expect(card.missingData).toContain("Premarket");
    expect(card.factors.find((f) => f.key === "premarket")!.points).toBeLessThanOrEqual(1);
  });

  it("imán del GEX en contra de la tesis → factor walls falla", () => {
    // tesis alcista pero imán por DEBAJO del precio
    const card = buildDecisionCard(baseInput({ gex: gexOf({ kingStrike: 95 }) }));
    expect(card.factors.find((f) => f.key === "walls")?.status).toBe("fail");
  });

  it("noticias en conflicto con el flujo → factor catalizador = 0", () => {
    // flujo alcista (callPct 70) vs noticias bajistas
    const card = buildDecisionCard(
      baseInput({ news: newsOf({ bias: "bearish", score: -0.5, positive: 0, negative: 3 }) }),
    );
    expect(card.factors.find((f) => f.key === "catalyst")?.points).toBe(0);
  });
});

describe("buildDecisionCard — plan condicional", () => {
  it("calcula trigger, invalidación, targets y R:R con niveles presentes", () => {
    const card = buildDecisionCard(baseInput());
    expect(card.plan.trigger).toContain("Romper");
    expect(card.plan.invalidation).toBe(96);
    expect(card.plan.t1).toBe(103);
    expect(card.plan.t2).toBe(108);
    expect(card.plan.rr1).not.toBeNull();
    expect(card.plan.rr2).not.toBeNull();
  });

  it("sin invalidación → R:R null y aviso de no dimensionar", () => {
    const card = buildDecisionCard(
      baseInput({ levels: levelsOf({ supports: [], keySupport: null }) }),
    );
    expect(card.plan.invalidation).toBeNull();
    expect(card.plan.rr1).toBeNull();
    expect(card.plan.riesgo.toLowerCase()).toContain("sin invalidación");
  });
});

describe("buildDecisionCard — IV Rank real (Tastytrade)", () => {
  it("IV Rank comprimido (16-30) → nota de prima barata, no en missingData", () => {
    const card = buildDecisionCard(baseInput({ ivRank: 22 }));
    expect(card.ivRank).toBe(22);
    expect(card.ivNote).toContain("comprimida");
    expect(card.missingData).not.toContain("IV Rank (Tastytrade)");
  });

  it("IV Rank estirado (>70) → aviso de IV crush", () => {
    const card = buildDecisionCard(baseInput({ ivRank: 85 }));
    expect(card.ivNote.toLowerCase()).toContain("crush");
  });

  it("sin IV Rank → null y marcado DATO NO DISPONIBLE", () => {
    const card = buildDecisionCard(baseInput({ ivRank: null }));
    expect(card.ivRank).toBeNull();
    expect(card.missingData).toContain("IV Rank (Tastytrade)");
  });
});
