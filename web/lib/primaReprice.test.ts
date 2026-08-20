import { describe, expect, it } from "vitest";
import { repriceFromChain } from "./primaReprice";
import type { PrimaPosition } from "./primaPaper";
import type { Chain2Contract } from "./optionChain2";

const VENCE = "2026-08-21";

function pos(over: Partial<PrimaPosition> = {}): PrimaPosition {
  return {
    id: "p1", openedAt: "2026-08-17T15:45:00Z", ticker: "MSFT", sector: "tech",
    type: "call_credit", shortStrike: 510, longStrike: 515, width: 5,
    expiration: VENCE, contracts: 1, entryCredit: 0.42, currentValue: 0.42,
    peakProfitPct: 0, shortDelta: 0.13, popPct: 88, status: "abierta",
    closedAt: null, closeReason: null, realizedPnl: null, ...over,
  };
}

function leg(strike: number, mid: number, over: Partial<Chain2Contract> = {}): Chain2Contract {
  return {
    symbol: `M${strike}`, type: "call", strike, expiration: VENCE,
    bid: mid - 0.02, ask: mid + 0.02, mid, delta: 0.13, gamma: 0.01,
    theta: -0.1, vega: 0.1, iv: 0.25, openInterest: 900, volume: 50,
    premiumTraded: 0, lastPrice: mid, ...over,
  };
}

describe("repriceFromChain", () => {
  it("el coste de cerrar es mid(corto) − mid(largo)", () => {
    const r = repriceFromChain(pos(), [leg(510, 0.30), leg(515, 0.05)]);
    expect(r.currentValue).toBeCloseTo(0.25, 4);
    expect(r.problem).toBeNull();
  });

  it("devuelve el delta del corto para el aviso de gamma", () => {
    const r = repriceFromChain(pos(), [leg(510, 0.3, { delta: -0.55 }), leg(515, 0.05)]);
    expect(r.shortDelta).toBeCloseTo(0.55, 4); // en valor absoluto
  });

  it("cae al punto medio de bid/ask si no hay mid", () => {
    const r = repriceFromChain(pos(), [
      leg(510, 0.3, { mid: null, bid: 0.28, ask: 0.32 }),
      leg(515, 0.05, { mid: null, bid: 0.04, ask: 0.06 }),
    ]);
    expect(r.currentValue).toBeCloseTo(0.25, 4);
  });

  it("NO cotiza contra otro vencimiento aunque coincidan los strikes", () => {
    // Un número plausible pero de otro contrato es peor que no tener número.
    const otra = [leg(510, 0.3, { expiration: "2026-08-28" }), leg(515, 0.05, { expiration: "2026-08-28" })];
    const r = repriceFromChain(pos(), otra);
    expect(r.currentValue).toBeNull();
    expect(r.problem).toMatch(/sin cadena/);
  });

  it("avisa si faltan los strikes de la posición", () => {
    const r = repriceFromChain(pos(), [leg(500, 0.9), leg(505, 0.6)]);
    expect(r.currentValue).toBeNull();
    expect(r.problem).toMatch(/no aparecen los strikes/);
  });

  it("avisa si una pata no tiene cotización utilizable", () => {
    const r = repriceFromChain(pos(), [
      leg(510, 0.3),
      leg(515, 0, { mid: null, bid: null, ask: null, lastPrice: null }),
    ]);
    expect(r.currentValue).toBeNull();
    expect(r.problem).toMatch(/sin cotización/);
  });

  it("acota el débito entre 0 y el ancho (quotes cruzadas)", () => {
    const cruzado = repriceFromChain(pos(), [leg(510, 0.05), leg(515, 0.30)]);
    expect(cruzado.currentValue).toBe(0);            // negativo → 0
    const absurdo = repriceFromChain(pos(), [leg(510, 99), leg(515, 0.01)]);
    expect(absurdo.currentValue).toBe(5);            // > ancho → ancho
  });

  it("usa los PUTS cuando la posición es un put credit spread", () => {
    const puts = [
      leg(470, 0.30, { type: "put", strike: 470 }),
      leg(465, 0.05, { type: "put", strike: 465 }),
    ];
    const p = pos({ type: "put_credit", shortStrike: 470, longStrike: 465 });
    // Con solo calls en la cadena no debe encontrar nada
    expect(repriceFromChain(p, [leg(470, 0.3), leg(465, 0.05)]).currentValue).toBeNull();
    expect(repriceFromChain(p, puts).currentValue).toBeCloseTo(0.25, 4);
  });
});
