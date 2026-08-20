import { describe, expect, it } from "vitest";
import {
  evaluate,
  summarize,
  realizedPnl,
  unrealizedPnl,
  securedGain,
  trailStopPrice,
  TRAIL_LOCK_FRACTION,
  type PaperTrade,
} from "./paperTrade";

function trade(over: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "t1",
    createdAt: "2026-08-03T13:00:00.000Z",
    source: "manual",
    ticker: "IWM",
    optionType: "call",
    strike: 295,
    expiration: "2026-08-15",
    direction: "up",
    trigger: 296,
    target: 297,
    stop: 295,
    trailing: true,
    probability: 65,
    note: "Day Trading",
    contracts: 10,
    status: "pendiente",
    entryPrice: null,
    entryAt: null,
    exitPrice: null,
    exitAt: null,
    peakPrice: null,
    currentUnderlying: null,
    currentPrice: null,
    updatedAt: null,
    closeReason: null,
    verdict: null,
    ...over,
  };
}

const NOW = new Date("2026-08-03T14:30:00.000Z");

describe("evaluate — gatillo (pendiente → activa)", () => {
  it("no activa mientras el subyacente no cruza el gatillo", () => {
    const t = evaluate(trade(), 295.5, 0.9, NOW); // 295.5 < 296
    expect(t.status).toBe("pendiente");
    expect(t.entryPrice).toBeNull();
    expect(t.currentUnderlying).toBe(295.5);
  });

  it("activa a la prima actual cuando cruza el gatillo (dirección up)", () => {
    const t = evaluate(trade(), 296.0, 0.91, NOW);
    expect(t.status).toBe("activa");
    expect(t.entryPrice).toBe(0.91);
    expect(t.peakPrice).toBe(0.91);
    expect(t.entryAt).toBe(NOW.toISOString());
  });

  it("dirección down: activa al cruzar hacia abajo", () => {
    const put = trade({ optionType: "put", direction: "down", trigger: 100, target: 95, stop: 102 });
    expect(evaluate(put, 101, 1.2, NOW).status).toBe("pendiente");
    expect(evaluate(put, 99.9, 1.2, NOW).status).toBe("activa");
  });

  it("no activa sin prima (no puede fijar la entrada)", () => {
    const t = evaluate(trade(), 296.0, null, NOW);
    expect(t.status).toBe("pendiente");
  });
});

describe("evaluate — cierres (activa → ganada/perdida)", () => {
  const active = trade({ status: "activa", entryPrice: 0.91, entryAt: NOW.toISOString(), peakPrice: 0.91, trailing: false });

  it("gana al tocar el objetivo del subyacente", () => {
    const t = evaluate(active, 297.0, 1.6, NOW);
    expect(t.status).toBe("ganada");
    expect(t.closeReason).toBe("objetivo");
    expect(t.exitPrice).toBe(1.6);
    expect(t.verdict).toContain("llegó al objetivo");
    expect(t.verdict).toContain("65%");
  });

  it("pierde al tocar el stop del subyacente", () => {
    const t = evaluate(active, 295.0, 0.4, NOW);
    expect(t.status).toBe("perdida");
    expect(t.closeReason).toBe("stop");
    expect(realizedPnl(t)).toBeCloseTo((0.4 - 0.91) * 100 * 10, 6);
  });
});

describe("trailing de ganancia", () => {
  it("trailStopPrice asegura la fracción del avance", () => {
    expect(trailStopPrice(0.91, 1.45)).toBeCloseTo(0.91 + TRAIL_LOCK_FRACTION * (1.45 - 0.91), 6);
    expect(trailStopPrice(1.0, 0.8)).toBe(1.0); // sin avance → nunca bajo la entrada
  });

  it("securedGain reproduce el '+$270' del IWM (entry 0.91, peak 1.45, 10 contratos)", () => {
    const t = trade({ status: "activa", entryPrice: 0.91, peakPrice: 1.45, contracts: 10, trailing: true });
    expect(securedGain(t)).toBeCloseTo(270, 0);
  });

  it("cierra por trailing al nivel asegurado cuando la prima recae", () => {
    const t = trade({ status: "activa", entryPrice: 1.0, peakPrice: 2.0, contracts: 1, trailing: true, target: 999, stop: -1 });
    const secured = trailStopPrice(1.0, 2.0); // 1.5
    const out = evaluate({ ...t, peakPrice: 2.0 }, 296.5, 1.4, NOW); // 1.4 <= 1.5
    expect(out.status).toBe("ganada");
    expect(out.closeReason).toBe("trailing");
    expect(out.exitPrice).toBeCloseTo(secured, 6);
    expect(realizedPnl(out)).toBeGreaterThan(0); // el trailing nunca cierra en pérdida
  });

  it("el trailing no dispara si la prima sigue subiendo (actualiza el pico)", () => {
    const t = trade({ status: "activa", entryPrice: 1.0, peakPrice: 1.8, contracts: 1, trailing: true, target: 999, stop: -1 });
    const out = evaluate(t, 296.5, 2.2, NOW);
    expect(out.status).toBe("activa");
    expect(out.peakPrice).toBe(2.2);
  });
});

describe("expiración", () => {
  it("pendiente que vence sin activarse → expirada", () => {
    const t = evaluate(trade({ expiration: "2026-08-01" }), 250, 0.5, NOW); // NOW = 08-03 ET
    expect(t.status).toBe("expirada");
    expect(t.closeReason).toBe("expirada");
  });
});

describe("summarize", () => {
  it("reproduce las stats de la captura (1 cerrada +268, 2 activas +687)", () => {
    const qqq = trade({
      id: "qqq", ticker: "QQQ", status: "ganada", entryPrice: 3.04, exitPrice: 5.72,
      contracts: 1, closeReason: "objetivo",
    });
    const crwv = trade({
      id: "crwv", ticker: "CRWV", status: "activa", entryPrice: 25.45, currentPrice: 26.92, contracts: 1,
    });
    const iwm = trade({
      id: "iwm", ticker: "IWM", status: "activa", entryPrice: 0.91, currentPrice: 1.45, contracts: 10,
    });
    expect(unrealizedPnl(crwv)).toBeCloseTo(147, 0);
    expect(unrealizedPnl(iwm)).toBeCloseTo(540, 0);

    const s = summarize([qqq, crwv, iwm]);
    expect(s.closedPnl).toBeCloseTo(268, 0);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(0);
    expect(s.winRatePct).toBe(100);
    expect(s.pending).toBe(0);
    expect(s.active).toBe(2);
    expect(s.openUnrealized).toBeCloseTo(687, 0);
  });
});

describe("caducidad de los pendientes (7 días sin gatillo)", () => {
  const largo = { expiration: "2026-12-18", trigger: 296, stop: 200 };

  it("a los 7 días sin cruzar el gatillo se caduca y libera el ticker", () => {
    const t = evaluate(trade({ ...largo, status: "pendiente" }), 295, 1.0, new Date("2026-08-10T13:00:00.000Z"));
    expect(t.status).toBe("expirada");
    expect(t.closeReason).toBe("caducada");
    expect(t.verdict).toMatch(/sin cruzar el gatillo/);
  });

  it("a los 6 días sigue esperando", () => {
    const t = evaluate(trade({ ...largo, status: "pendiente" }), 295, 1.0, new Date("2026-08-09T12:00:00.000Z"));
    expect(t.status).toBe("pendiente");
  });

  it("si cruza el gatillo justo el día 7, se ACTIVA en vez de caducar", () => {
    const t = evaluate(trade({ ...largo, status: "pendiente" }), 297, 1.0, new Date("2026-08-10T13:00:00.000Z"));
    expect(t.status).toBe("activa");
    expect(t.entryPrice).toBe(1.0);
  });

  it("una caducada no cuenta como pérdida en el win rate", () => {
    const t = evaluate(trade({ ...largo, status: "pendiente" }), 295, 1.0, new Date("2026-08-10T13:00:00.000Z"));
    const s = summarize([t]);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.winRatePct).toBeNull();
  });
});
