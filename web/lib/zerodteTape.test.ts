import { describe, expect, it } from "vitest";
import type { FlowRow } from "./flow";
import { buildTape, emptyTape, TOP_BLOCKS, VELOCITY_WINDOW_MIN } from "./zerodteTape";

const EXP = "2026-08-24";
const NOW = new Date("2026-08-24T18:00:00Z"); // 14:00 ET

function row(over: Partial<FlowRow> = {}): FlowRow {
  return {
    id: 1, symbol: "SPY240824C00500000", underlying: "SPY",
    type: "call", strike: 500, expiration: EXP, dte: 0,
    price: 1.5, size: 100, side: "ask", aggression: "ask",
    assetPrice: 500, bid: 1.45, ask: 1.55, premium: 15_000,
    delta: 0.4, gamma: 0.05, theta: -0.5, vega: 0.1, thetaPctDaily: 33,
    iv: 20, openInterest: 1000, volume: 5000, score: 5, sentiment: "alcista",
    timestamp: NOW.toISOString(), conditionCode: null, conditionName: null,
    flags: {
      big: false, convDelta: false, aboveAsk: false, belowBid: false, mid: false,
      leap: false, repeated: false, multileg: false, simultaneous: false, exceededOI: false,
    },
    scores: { volume: 0, timing: 0, repetition: 0, total: 0 },
    unusual: false, interesting: false, expiryStatus: "expira_hoy",
    ...over,
  };
}

describe("buildTape", () => {
  it("sin filas del vencimiento devuelve la cinta vacía", () => {
    expect(buildTape([row({ expiration: "2026-09-19" })], EXP, NOW)).toEqual(emptyTape());
  });

  it("el CVD suma lo agredido al ask y resta lo agredido al bid", () => {
    const t = buildTape([
      row({ id: 1, aggression: "ask", size: 300 }),
      row({ id: 2, aggression: "bid", size: 100 }),
    ], EXP, NOW);
    expect(t.buy).toBe(300);
    expect(t.sell).toBe(100);
    expect(t.cvd).toBe(200);
    expect(t.contracts).toBe(400);
    expect(t.weight).toBeCloseTo(0.5, 6);
    expect(t.pressure).toBe("compradora");
  });

  it("los cruces en el mid NO entran: no dicen quién tenía prisa", () => {
    const t = buildTape([
      row({ id: 1, aggression: "mid", size: 9999 }),
      row({ id: 2, aggression: "unknown", size: 9999 }),
      row({ id: 3, aggression: "ask", size: 50 }),
    ], EXP, NOW);
    expect(t.contracts).toBe(50);
    expect(t.trades).toBe(1);
  });

  it("un CVD casi equilibrado se lee como neutral", () => {
    const t = buildTape([
      row({ id: 1, aggression: "ask", size: 100 }),
      row({ id: 2, aggression: "bid", size: 98 }),
    ], EXP, NOW);
    expect(t.pressure).toBe("neutral");
  });

  it("la velocidad compara la ventana reciente contra la media de la sesión", () => {
    const rows: FlowRow[] = [];
    // 60 minutos de historia a 10 contratos/min…
    for (let i = 60; i > VELOCITY_WINDOW_MIN; i--) {
      rows.push(row({ id: i, size: 10, timestamp: new Date(NOW.getTime() - i * 60_000).toISOString() }));
    }
    // …y una ráfaga de 500 contratos en los últimos 5 minutos.
    rows.push(row({ id: 999, size: 500, timestamp: new Date(NOW.getTime() - 60_000).toISOString() }));
    const t = buildTape(rows, EXP, NOW);
    expect(t.velocity).toBeCloseTo(100, 6); // 500 / 5 min
    expect(t.velocityRatio).toBeGreaterThan(1.2);
    expect(t.velocityLabel).toBe("acelerando");
  });

  it("con el mercado cerrado no reporta velocidad (la ventana vacía no es 'apagándose')", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({ id: i, size: 10, timestamp: new Date(NOW.getTime() - (i + 10) * 60_000).toISOString() }));
    const abierto = buildTape(rows, EXP, NOW, true);
    expect(abierto.velocityLabel).toBe("apagándose");
    const cerrado = buildTape(rows, EXP, NOW, false);
    expect(cerrado.velocity).toBeNull();
    expect(cerrado.velocityLabel).toBeNull();
    // el CVD y los bloques SÍ siguen valiendo cerrados
    expect(cerrado.contracts).toBe(300);
    expect(cerrado.blocks.length).toBeGreaterThan(0);
  });

  it("sin una ventana completa de historia no inventa una velocidad", () => {
    const t = buildTape([
      row({ timestamp: new Date(NOW.getTime() - 60_000).toISOString() }),
    ], EXP, NOW);
    expect(t.velocity).toBeNull();
    expect(t.velocityLabel).toBeNull();
  });

  it("los bloques salen ordenados por prima y topados en 10", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ id: i, premium: (i + 1) * 1000 }));
    const t = buildTape(rows, EXP, NOW);
    expect(t.blocks).toHaveLength(TOP_BLOCKS);
    expect(t.blocks[0].premium).toBe(25_000);
    expect(t.blocks[0].premium).toBeGreaterThan(t.blocks[1].premium);
  });

  it("aplica la tabla de dominio: comprar call es alcista, vender put es soporte", () => {
    const t = buildTape([
      row({ id: 1, type: "call", aggression: "ask", premium: 40_000 }),
      row({ id: 2, type: "put", aggression: "bid", premium: 30_000 }),
      row({ id: 3, type: "call", aggression: "bid", premium: 20_000 }),
      row({ id: 4, type: "put", aggression: "ask", premium: 10_000 }),
    ], EXP, NOW);
    expect(t.blocks.map((b) => [b.meaning, b.bullish])).toEqual([
      ["direccional alcista", true],
      ["soporte", true],
      ["resistencia / muro", false],
      ["cobertura o bajista", false],
    ]);
  });
});
