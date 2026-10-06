import { describe, expect, it } from "vitest";
import type { ZeroDteAnalysis, ZeroDteLeg, ZeroDteStrike } from "./zerodte";
import type { ZeroDteTrade } from "./zerodteSignals";
import { breakevenWinPct, gammaWalls, zeroDteSpreads } from "./zerodteSpreads";
import { commissionOf } from "./commissions";

// ---------------------------------------------------------------------------
// Fixtura: cadena de strikes 95-105 con spot 100. Valor temporal 1.20 en el ATM
// que baja 0.20 por strike; horquilla ±0.05. Muros de gamma en 103 (calls) y
// 97 (puts) por OI.
// ---------------------------------------------------------------------------

const SPOT = 100;
const tv = (k: number) => Math.max(0.1, 1.2 - 0.2 * Math.abs(k - SPOT));
const callMid = (k: number) => Math.max(0, SPOT - k) + tv(k);
const putMid = (k: number) => Math.max(0, k - SPOT) + tv(k);

function leg(mid: number, over: Partial<ZeroDteLeg> = {}): ZeroDteLeg {
  return {
    optionSymbol: "TEST", volume: 1000, openInterest: 500,
    price: mid, bid: round(mid - 0.05), ask: round(mid + 0.05),
    delta: 0.4, gamma: 0.05, iv: 0.2,
    openPremium: 0, notional: 0, premiumTraded: 0, ...over,
  };
}

function strike(k: number): ZeroDteStrike {
  return {
    strike: k,
    call: leg(callMid(k), { optionSymbol: `C${k}`, openInterest: k === 103 ? 5000 : 500 }),
    put: leg(putMid(k), { optionSymbol: `P${k}`, delta: -0.4, openInterest: k === 97 ? 5000 : 500 }),
    callVolume: 1000, putVolume: 1000, totalVolume: 2000,
    netGex: 0, itm: null,
  };
}

function analysis(over: Partial<ZeroDteAnalysis> = {}): ZeroDteAnalysis {
  const strikes = [95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105].map(strike);
  return {
    spot: SPOT, iv: 0.2, chainIv: 0.2, ivSource: "realizada" as const,
    strikes, maxVolume: 1000, magnet: 102, flipStrike: 98.5,
    regime: "positive", totalGex: 5e8,
    maxCall: null, maxPut: null, topVolumeCall: null, topVolumePut: null,
    putCall: { ratio: 1, puts: 1000, calls: 1000 },
    gammaCoverage: { strikes: 11, contracts: 22, withGamma: 22, pct: 100 },
    lean: "lateral", confidence: 40, leanScore: 0, callPct: 50,
    scenarios: {
      bear: { kind: "bear", target: 98, changePct: -2, driver: "", touchProb: 0.5, attractionStrike: 98, attractionContracts: 1000 },
      base: { kind: "base", target: 101, changePct: 1, driver: "", touchProb: 0.6, attractionStrike: 101, attractionContracts: 1000 },
      bull: { kind: "bull", target: 102, changePct: 2, driver: "", touchProb: 0.4, attractionStrike: 102, attractionContracts: 1000 },
    },
    expectedRange: { low: 98, high: 102, sigmaPct: 2 },
    horizonDays: 0.5, horizonDaysUsed: 0.5,
    ...over,
  };
}

function trade(over: Partial<ZeroDteTrade> = {}): ZeroDteTrade {
  return {
    model: "magnet", side: "LONG", entry: 100, target: 102, stop: 99.8,
    reward: 2, risk: 0.2, rr: 10, rationale: "", ...over,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Quita una cotización de una pata para simular un strike sin bid/ask. */
function withoutQuote(a: ZeroDteAnalysis, k: number, type: "call" | "put", side: "bid" | "ask"): ZeroDteAnalysis {
  return {
    ...a,
    strikes: a.strikes.map((s) => {
      if (s.strike !== k) return s;
      const l = type === "call" ? s.call : s.put;
      const patched = l ? { ...l, [side]: null } : l;
      return type === "call" ? { ...s, call: patched } : { ...s, put: patched };
    }),
  };
}

// ---------------------------------------------------------------------------

describe("breakevenWinPct", () => {
  it("gana 1, pierde 1 → 50%", () => {
    expect(breakevenWinPct(100, 100)).toBe(50);
  });

  it("el pago invertido de la auditoría (+38% / −54%) exige ~59% de aciertos", () => {
    expect(breakevenWinPct(38, -54)).toBeCloseTo(58.7, 1);
  });

  it("sin ganancia o sin pérdida no hay apuesta", () => {
    expect(breakevenWinPct(0, 50)).toBeNull();
    expect(breakevenWinPct(50, 0)).toBeNull();
  });
});

describe("gammaWalls", () => {
  it("toma el strike con más gamma·OI de calls arriba y de puts abajo", () => {
    expect(gammaWalls(analysis())).toEqual({ callWall: 103, putWall: 97 });
  });

  it("ignora un pico de gamma DENTRO del cono de 1σ (el ATM de un 0DTE)", () => {
    const a = analysis();
    const atm = {
      ...a,
      strikes: a.strikes.map((s) =>
        s.strike === 101 && s.call ? { ...s, call: { ...s.call, openInterest: 99_000 } } : s),
    };
    // 101 está dentro de 98-102: el muro sigue siendo 103.
    expect(gammaWalls(atm).callWall).toBe(103);
  });

  it("ignora patas sin gamma", () => {
    const a = analysis();
    const noGamma = {
      ...a,
      strikes: a.strikes.map((s) => (s.call ? { ...s, call: { ...s.call, gamma: null } } : s)),
    };
    expect(gammaWalls(noGamma).callWall).toBeNull();
  });
});

describe("vertical de débito", () => {
  it("LONG: compra el call en la entrada y vende el call en el objetivo, al peor precio", () => {
    const v = zeroDteSpreads(analysis(), trade()).vertical!;
    expect(v.kind).toBe("bull_call");
    expect(v.longStrike).toBe(100);
    expect(v.shortStrike).toBe(102);
    expect(v.width).toBe(2);
    // ask del 100C (1.25) − bid del 102C (0.75)
    expect(v.debit).toBeCloseTo(0.5, 2);
    const fees = commissionOf(1, 2, true);
    expect(v.maxLoss).toBeCloseTo(50 + fees, 2);
    expect(v.maxGain).toBeCloseTo(150 - fees, 2);
    expect(v.breakeven).toBeCloseTo(100.5, 2);
    expect(v.breakevenWinPct).toBeCloseTo(((50 + fees) / 200) * 100, 1);
  });

  it("SHORT: bear put con la pata corta debajo de la larga", () => {
    const v = zeroDteSpreads(analysis(), trade({ side: "SHORT", target: 98, stop: 100.2 })).vertical!;
    expect(v.kind).toBe("bear_put");
    expect(v.longStrike).toBe(100);
    expect(v.shortStrike).toBe(98);
    expect(v.breakeven).toBeCloseTo(100 - v.debit, 2);
  });

  it("sin trade activo no sugiere vertical", () => {
    const s = zeroDteSpreads(analysis(), null);
    expect(s.vertical).toBeNull();
    expect(s.verticalNote).toMatch(/sin trade/i);
  });

  it("objetivo en el mismo strike que la entrada → sin ancho", () => {
    const s = zeroDteSpreads(analysis(), trade({ target: 100.3 }));
    expect(s.vertical).toBeNull();
    expect(s.verticalNote).toMatch(/ancho/);
  });

  it("si falta el ask de la pata larga no inventa el precio", () => {
    const s = zeroDteSpreads(withoutQuote(analysis(), 100, "call", "ask"), trade());
    expect(s.vertical).toBeNull();
    expect(s.verticalNote).toMatch(/bid\/ask/);
  });
});

describe("credit spreads e iron condor (solo γ+)", () => {
  it("vende cada muro y compra el strike siguiente hacia afuera", () => {
    const s = zeroDteSpreads(analysis(), trade());
    expect(s.creditCall).toMatchObject({ side: "call", shortStrike: 103, longStrike: 104, width: 1 });
    expect(s.creditPut).toMatchObject({ side: "put", shortStrike: 97, longStrike: 96, width: 1 });
    // bid del 103C (0.55) − ask del 104C (0.45)
    expect(s.creditCall!.credit).toBeCloseTo(0.1, 2);
    expect(s.creditCall!.breakeven).toBeCloseTo(103.1, 2);
    expect(s.creditPut!.breakeven).toBeCloseTo(96.9, 2);
  });

  it("vencer OTM no paga comisión de cierre", () => {
    const c = zeroDteSpreads(analysis(), trade()).creditCall!;
    const fees = commissionOf(1, 2, false);
    expect(c.maxGain).toBeCloseTo(10 - fees, 2);
    expect(c.maxLoss).toBeCloseTo(90 + fees, 2);
  });

  it("marca el crédito por debajo del mínimo de Venta de Prima", () => {
    expect(zeroDteSpreads(analysis(), trade()).creditCall!.belowMinCredit).toBe(true);
  });

  it("el iron condor suma los dos créditos y solo puede perder un lado", () => {
    const ic = zeroDteSpreads(analysis(), trade()).ironCondor!;
    const fees = commissionOf(1, 4, false);
    expect(ic.credit).toBeCloseTo(0.2, 2);
    expect(ic.maxGain).toBeCloseTo(20 - fees, 2);
    expect(ic.maxLoss).toBeCloseTo(80 + fees, 2);
    expect(ic.beLow).toBeCloseTo(96.8, 2);
    expect(ic.beHigh).toBeCloseTo(103.2, 2);
  });

  it("en γ− no vende prima en los muros", () => {
    const s = zeroDteSpreads(analysis({ regime: "negative" }), trade());
    expect(s.creditCall).toBeNull();
    expect(s.creditPut).toBeNull();
    expect(s.ironCondor).toBeNull();
    expect(s.creditNote).toMatch(/γ−/);
    // El vertical no depende del régimen: sigue la dirección del trade activo.
    expect(s.vertical).not.toBeNull();
  });

  it("sin strike de protección más allá del muro no hay spread ni condor", () => {
    const a = analysis();
    const sinAla = { ...a, strikes: a.strikes.filter((s) => s.strike <= 103) };
    const s = zeroDteSpreads(sinAla, trade());
    expect(s.creditCall).toBeNull();
    expect(s.creditNote).toMatch(/protección/);
    expect(s.creditPut).not.toBeNull();
    expect(s.ironCondor).toBeNull();
  });

  it("un crédito no positivo con precio conservador se descarta", () => {
    // Sin bid real en la corta del call wall.
    const s = zeroDteSpreads(withoutQuote(analysis(), 103, "call", "bid"), trade());
    expect(s.creditCall).toBeNull();
  });
});
