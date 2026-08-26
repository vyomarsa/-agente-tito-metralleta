import { describe, expect, it } from "vitest";
import { affordOf, sortByAffordThenScore } from "./wheelAfford";
import type { WheelCandidate } from "./wheel";

// NOTA: el parámetro extra se llama `scoreTotal` (no `score`) porque
// `WheelCandidate.score` ya es un `WheelScore` — reusar el nombre `score`
// para un `number` suelto choca con `Partial<WheelCandidate>` en la
// intersección del tipo y TypeScript no deja compilar (ver concern en el
// report). Misma lógica probada, solo cambia el nombre del parámetro.
function cand(p: Partial<WheelCandidate> & { collateral: number; scoreTotal: number }): WheelCandidate {
  return {
    ticker: "F", strike: p.collateral / 100, expiration: "2026-08-21", dte: 35, spot: 12,
    delta: -0.25, iv: 0.45, ivSource: "implicita", openInterest: 900, spreadPct: 5,
    premium: { price: 0.3, source: "bid", raw: 0.3 },
    metrics: {
      credit: 30, collateral: p.collateral, returnPct: 2, annualizedPct: 25,
      breakeven: 10.7, cushionPct: 8, probExpireWorthless: 75,
    },
    score: {
      total: p.scoreTotal, annualized: { points: 0, max: 30, band: "", why: "" },
      ivRank: { points: 0, max: 20, band: "", why: "" },
      cushion: { points: 0, max: 25, band: "", why: "" },
      liquidity: { points: 0, max: 15, band: "", why: "" },
      earnings: { points: 0, max: 10, band: "", why: "" },
    },
    blocked: false, blockReason: null,
  };
}

describe("affordOf", () => {
  it("alcanza cuando el colateral cabe en el efectivo", () => {
    const a = affordOf(cand({ collateral: 1100, scoreTotal: 80 }), 2000);
    expect(a.affordable).toBe(true);
    expect(a.shortfall).toBe(0);
  });

  it("no alcanza y reporta cuánto falta", () => {
    const a = affordOf(cand({ collateral: 1100, scoreTotal: 80 }), 800);
    expect(a.affordable).toBe(false);
    expect(a.shortfall).toBe(300);
  });

  it("un candidato bloqueado nunca es asequible", () => {
    const blocked = { ...cand({ collateral: 1100, scoreTotal: 0 }), blocked: true, metrics: null };
    const a = affordOf(blocked, 5000);
    expect(a.affordable).toBe(false);
  });
});

describe("sortByAffordThenScore", () => {
  it("pone los asequibles arriba y ordena por score dentro de cada grupo", () => {
    const rows = sortByAffordThenScore([
      cand({ collateral: 5000, scoreTotal: 95 }), // caro pero mejor score
      cand({ collateral: 1000, scoreTotal: 60 }), // asequible, peor score
    ], 1500);
    expect(rows[0].metrics?.collateral).toBe(1000); // el asequible va primero
    expect(rows[0].afford.affordable).toBe(true);
    expect(rows[1].afford.affordable).toBe(false);
  });
});
