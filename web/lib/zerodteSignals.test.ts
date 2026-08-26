import { describe, expect, it } from "vitest";
import type { ZeroDteAnalysis, ZeroDteLeg, ZeroDteStrike } from "./zerodte";
import {
  gexBias, gexTicket, magnetTrade, momentumTrade, pinning, PIN_START_MIN,
} from "./zerodteSignals";

// ---------------------------------------------------------------------------
// Fixtura: una cadena mínima pero realista alrededor de un spot de 100.
// ---------------------------------------------------------------------------

function leg(over: Partial<ZeroDteLeg> = {}): ZeroDteLeg {
  return {
    optionSymbol: "TEST", volume: 1000, openInterest: 500, price: 1.2,
    bid: 1.15, ask: 1.25, delta: 0.4, gamma: 0.05, iv: 0.2,
    openPremium: 0, notional: 0, premiumTraded: 0, ...over,
  };
}

function strike(k: number, over: Partial<ZeroDteStrike> = {}): ZeroDteStrike {
  return {
    strike: k,
    call: leg({ optionSymbol: `C${k}` }),
    put: leg({ optionSymbol: `P${k}`, delta: -0.4 }),
    callVolume: 1000, putVolume: 1000, totalVolume: 2000,
    netGex: 0, itm: null, ...over,
  };
}

function analysis(over: Partial<ZeroDteAnalysis> = {}): ZeroDteAnalysis {
  const strikes = [
    strike(98, { netGex: -1e8 }),
    strike(99, { netGex: -2e8 }),
    strike(100, { netGex: 1e8 }),
    strike(101, { netGex: 5e8 }),
    strike(102, { netGex: 2e8 }),
  ];
  return {
    spot: 100,
    iv: 0.2,
    chainIv: 0.2,
    ivSource: "realizada" as const,
    strikes,
    maxVolume: 1000,
    magnet: 101,
    flipStrike: 99.5,
    regime: "positive",
    totalGex: 5e8,
    maxCall: { strike: 102, openInterest: 500, volume: 1000, side: "call" },
    maxPut: { strike: 98, openInterest: 500, volume: 1000, side: "put" },
    topVolumeCall: { strike: 102, openInterest: 500, volume: 1000, side: "call" },
    topVolumePut: { strike: 98, openInterest: 500, volume: 1000, side: "put" },
    putCall: { ratio: 1.1, puts: 1100, calls: 1000 },
    gammaCoverage: { strikes: 5, contracts: 10, withGamma: 10, pct: 100 },
    lean: "lateral",
    confidence: 40,
    leanScore: 0,
    callPct: 50,
    scenarios: {
      bear: { kind: "bear", target: 98, changePct: -2, driver: "", touchProb: 0.5, attractionStrike: 98, attractionContracts: 1000 },
      base: { kind: "base", target: 101, changePct: 1, driver: "", touchProb: 0.6, attractionStrike: 101, attractionContracts: 1000 },
      bull: { kind: "bull", target: 102, changePct: 2, driver: "", touchProb: 0.4, attractionStrike: 102, attractionContracts: 1000 },
    },
    expectedRange: { low: 98.5, high: 101.5, sigmaPct: 1.5 },
    horizonDays: 0.5,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("magnetTrade (original — vuelta al imán)", () => {
  it("en γ+ con el imán arriba propone LONG hacia el imán", () => {
    const card = magnetTrade(analysis());
    expect(card.trade?.side).toBe("LONG");
    expect(card.trade?.target).toBe(101);
    expect(card.trade?.stop).toBeLessThan(100);
    expect(card.trade?.rr).toBeGreaterThan(1);
  });

  it("en γ+ con el imán abajo propone SHORT", () => {
    const card = magnetTrade(analysis({ magnet: 99 }));
    expect(card.trade?.side).toBe("SHORT");
    expect(card.trade?.stop).toBeGreaterThan(100);
  });

  it("en γ− no propone nada y remite al modelo alterno", () => {
    const card = magnetTrade(analysis({ regime: "negative" }));
    expect(card.trade).toBeNull();
    expect(card.note).toMatch(/alterno/i);
  });

  it("con el precio pegado al imán no hay recorrido", () => {
    const card = magnetTrade(analysis({ magnet: 100.01 }));
    expect(card.trade).toBeNull();
    expect(card.note).toMatch(/pegado/i);
  });

  it("sin imán no inventa una idea", () => {
    expect(magnetTrade(analysis({ magnet: null })).trade).toBeNull();
  });
});

describe("momentumTrade (alterno — γ−)", () => {
  const neg = (over: Partial<ZeroDteAnalysis> = {}) =>
    analysis({ regime: "negative", totalGex: -5e8, ...over });

  it("en γ+ no propone nada y remite al modelo original", () => {
    const card = momentumTrade(analysis());
    expect(card.trade).toBeNull();
    expect(card.note).toMatch(/original/i);
  });

  it("por encima del flip persigue la ruptura al alza", () => {
    const card = momentumTrade(neg({ flipStrike: 99.5 }));
    expect(card.trade?.side).toBe("LONG");
    expect(card.trade!.target).toBeGreaterThan(100);
  });

  it("por debajo del flip persigue la ruptura a la baja", () => {
    const card = momentumTrade(neg({ flipStrike: 100.5 }));
    expect(card.trade?.side).toBe("SHORT");
    expect(card.trade!.target).toBeLessThan(100);
  });

  it("nunca pone el objetivo más allá de 1σ", () => {
    // El muro de volumen está en 105, fuera del cono: se recorta al borde de 1σ.
    const card = momentumTrade(neg({
      topVolumeCall: { strike: 105, openInterest: 500, volume: 9999, side: "call" },
    }));
    expect(card.trade!.target).toBeLessThanOrEqual(101.5);
  });

  it("sin flip y sin sesgo claro no hay dirección que perseguir", () => {
    const card = momentumTrade(neg({ flipStrike: null, leanScore: 3 }));
    expect(card.trade).toBeNull();
    expect(card.note).toMatch(/dirección/i);
  });

  it("sin flip usa el sesgo del día como dirección", () => {
    const card = momentumTrade(neg({ flipStrike: null, leanScore: -60 }));
    expect(card.trade?.side).toBe("SHORT");
  });
});

describe("gexTicket", () => {
  it("sin trade no sugiere contrato", () => {
    const { ticket, note } = gexTicket(analysis(), null);
    expect(ticket).toBeNull();
    expect(note).toMatch(/sin trade/i);
  });

  it("un LONG se traduce a una CALL y un SHORT a una PUT", () => {
    const a = analysis();
    const long = gexTicket(a, magnetTrade(a).trade).ticket;
    expect(long?.type).toBe("call");
    const short = gexTicket(a, magnetTrade(analysis({ magnet: 99 })).trade).ticket;
    expect(short?.type).toBe("put");
  });

  it("descarta contratos fuera de la banda de delta útil", () => {
    const a = analysis({
      strikes: analysis().strikes.map((s) => ({
        ...s,
        call: leg({ delta: 0.95 }), // todo deep ITM
        put: leg({ delta: -0.95 }),
      })),
    });
    const { ticket, note } = gexTicket(a, magnetTrade(a).trade);
    expect(ticket).toBeNull();
    expect(note).toMatch(/delta/i);
  });

  it("proyecta la ganancia con delta lineal y marca la liquidez", () => {
    const a = analysis();
    const t = magnetTrade(a).trade!;
    const { ticket } = gexTicket(a, t);
    // delta 0.4 × 1 punto de subyacente × 100 = ~$40 por contrato.
    expect(ticket!.targetGain).toBeCloseTo(0.4 * (t.target - t.entry) * 100, 6);
    expect(ticket!.stopLoss).toBeLessThan(0);
    // horquilla 0.10 sobre mid 1.20 ≈ 8.3% → "justa" (buena es ≤6%)
    expect(ticket!.liquidity).toBe("justa");
  });

  it("una horquilla estrecha se etiqueta como liquidez buena", () => {
    const a = analysis({
      strikes: analysis().strikes.map((s) => ({
        ...s,
        call: leg({ bid: 1.18, ask: 1.22 }), // 3.3% del mid
      })),
    });
    const { ticket } = gexTicket(a, magnetTrade(a).trade);
    expect(ticket!.liquidity).toBe("buena");
  });
});

describe("gexBias", () => {
  it("el cono se abre con la raíz del tiempo y se centra en el spot sin sesgo", () => {
    const b = gexBias(analysis({ leanScore: 0 }), 5);
    expect(b.center).toBeCloseTo(100, 6);
    expect(b.dir).toBe("flat");
    expect(b.high - b.low).toBeCloseTo(2 * b.sigmaPts, 6);
    // 5 min de un día natural: σ = 100 × 0.20 × √(5/1440/365) ≈ 0.062
    expect(b.sigmaPts).toBeGreaterThan(0.05);
    expect(b.sigmaPts).toBeLessThan(0.08);
  });

  it("un sesgo alcista fuerte desplaza el centro arriba, pero como mucho media sigma", () => {
    const b = gexBias(analysis({ leanScore: 100 }), 5);
    expect(b.dir).toBe("up");
    expect(b.center - 100).toBeCloseTo(0.5 * b.sigmaPts, 6);
  });

  it("el alterno con flujo neutral coincide con el original", () => {
    const a = analysis();
    const orig = gexBias(a, 5, { model: "original" });
    const alt = gexBias(a, 5, { model: "alterno", flowWeight: 0 });
    expect(alt.center).toBeCloseTo(orig.center, 10);
    expect(alt.flowNote).toMatch(/neutral/);
  });

  it("el alterno mueve el centro con el peso del flujo", () => {
    const a = analysis({ leanScore: 0 });
    const alt = gexBias(a, 5, { model: "alterno", flowWeight: -1 });
    expect(alt.center).toBeLessThan(100);
    expect(alt.dir).toBe("down");
    expect(alt.flowNote).toMatch(/vendedora/);
  });

  it("en γ− avisa del nivel que dispara la aceleración", () => {
    const b = gexBias(analysis({ regime: "negative" }), 5);
    expect(b.note).toMatch(/amplifican/);
    expect(b.note).toContain("99.50");
  });

  it("la confianza sale del score del análisis", () => {
    expect(gexBias(analysis({ confidence: 10 }), 5).confidence).toBe("baja");
    expect(gexBias(analysis({ confidence: 50 }), 5).confidence).toBe("media");
    expect(gexBias(analysis({ confidence: 80 }), 5).confidence).toBe("alta");
  });
});

describe("pinning", () => {
  it("antes de las 15:00 ET no publica strike, solo la cuenta atrás", () => {
    const p = pinning(analysis(), 12 * 60, 240);
    expect(p.strike).toBeNull();
    expect(p.inWindow).toBe(false);
    expect(p.minutesToPin).toBe(PIN_START_MIN - 12 * 60);
    expect(p.candidate).toBe(101); // ya lo ve, pero no lo firma
  });

  it("dentro de la ventana publica el strike de más gamma del cono", () => {
    const p = pinning(analysis(), 15 * 60 + 10, 50);
    expect(p.inWindow).toBe(true);
    expect(p.strike).toBe(101);
  });

  it("con la sesión terminada no está en ventana aunque sean las 15:30", () => {
    expect(pinning(analysis(), 15 * 60 + 30, 0).inWindow).toBe(false);
  });

  it("ignora los strikes que caen fuera del cono de 1σ", () => {
    const a = analysis({
      expectedRange: { low: 99.8, high: 100.2, sigmaPct: 0.2 },
    });
    const p = pinning(a, 15 * 60 + 10, 50);
    expect(p.strike).toBe(100); // 101 queda fuera del cono
  });

  it("la fuerza del pin es el GEX neto y su signo explica el régimen", () => {
    const p = pinning(analysis({ regime: "negative", totalGex: -3e8 }), 15 * 60 + 5, 55);
    expect(p.strength).toBe(-3e8);
    expect(p.note).toMatch(/débil/);
  });
});
