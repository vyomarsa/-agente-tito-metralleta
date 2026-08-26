import { describe, expect, it } from "vitest";
import {
  MAX_OPEN, MAX_SPREAD_PCT, NO_OPEN_LAST_MIN, START_EQUITY,
  closePosition, managePosition, maxRiskOf, planOpen, pnlOf, reprice,
  returnPct, sizeFor, summarize, MODELO_VERSION,
  type ZeroPaperPosition,
} from "./zerodtePaper";
import type { ZeroDteTicket, ZeroDteTrade } from "./zerodteSignals";

const NOW = new Date("2026-08-24T15:00:00Z"); // 11:00 ET

function ticket(over: Partial<ZeroDteTicket> = {}): ZeroDteTicket {
  return {
    optionSymbol: "SPY260824C00766000", type: "call", strike: 766, delta: 0.4,
    bid: 1.18, ask: 1.22, mid: 1.2, spreadPct: 3.3, volume: 5000, openInterest: 2000,
    cost: 120, targetPrice: 2.0, targetGain: 80, stopLoss: -30, liquidity: "buena",
    rationale: "", ...over,
  };
}

function trade(over: Partial<ZeroDteTrade> = {}): ZeroDteTrade {
  return {
    model: "magnet", side: "LONG", entry: 765, target: 767, stop: 763.5,
    reward: 2, risk: 1.5, rr: 1.33, rationale: "", ...over,
  };
}

function pos(over: Partial<ZeroPaperPosition> = {}): ZeroPaperPosition {
  return {
    id: "Z-1", openedAt: NOW.toISOString(), ticker: "SPY", expiration: "2026-08-24",
    optionSymbol: "SPY260824C00766000", type: "call", strike: 766, contracts: 1,
    entryPrice: 1.2, currentPrice: 1.2, peakPrice: 1.2,
    model: "magnet", side: "LONG", entrySpot: 765, target: 767, stop: 763.5,
    status: "abierta", closedAt: null, closeReason: null, realizedPnl: null, ...over,
  };
}

function openInput(over: Partial<Parameters<typeof planOpen>[0]> = {}) {
  return {
    ticker: "SPY", expiration: "2026-08-24", ticket: ticket(), trade: trade(),
    spot: 765, equity: START_EQUITY, open: [] as ZeroPaperPosition[],
    minutesLeft: 300, sessionOpen: true, now: NOW, ...over,
  };
}

// --- cálculos ---------------------------------------------------------------

describe("cálculos", () => {
  it("el riesgo máximo de una opción comprada es la prima pagada", () => {
    expect(maxRiskOf({ entryPrice: 1.2, contracts: 2 })).toBe(240);
  });

  it("pnlOf multiplica por 100 y por contratos", () => {
    expect(pnlOf({ entryPrice: 1.2, currentPrice: 2.0, contracts: 2 })).toBe(160);
    expect(pnlOf({ entryPrice: 1.2, currentPrice: 0, contracts: 1 })).toBe(-120);
  });

  it("returnPct: expirar sin valor es −100%", () => {
    expect(returnPct({ entryPrice: 1.2, currentPrice: 0 })).toBe(-1);
    expect(returnPct({ entryPrice: 1.2, currentPrice: 1.8 })).toBeCloseTo(0.5, 4);
  });

  it("sizeFor reparte el 2% del capital entre la prima", () => {
    expect(sizeFor(1.2, 10_000)).toBe(1);   // 200 / 120 → 1
    expect(sizeFor(0.5, 10_000)).toBe(4);   // 200 / 50  → 4
    expect(sizeFor(3.0, 10_000)).toBe(0);   // un contrato cuesta 300 > 200
  });

  it("sizeFor nunca inventa un contrato con datos degenerados", () => {
    expect(sizeFor(0, 10_000)).toBe(0);
    expect(sizeFor(1.2, 0)).toBe(0);
    expect(sizeFor(1.2, 10_000, 0)).toBe(0);
  });
});

// --- apertura ---------------------------------------------------------------

describe("planOpen", () => {
  it("abre cuando hay ticket, trade y sesión", () => {
    const p = planOpen(openInput());
    expect(p.blocked).toBe("");
    expect(p.position).toMatchObject({
      ticker: "SPY", type: "call", strike: 766, contracts: 1,
      entryPrice: 1.2, model: "magnet", side: "LONG", target: 767, stop: 763.5,
    });
  });

  it("fuera de sesión no abre", () => {
    const p = planOpen(openInput({ sessionOpen: false }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/Fuera de sesión/);
  });

  // Un 0DTE comprado a las 15:55 no es una idea, es una apuesta a la campana.
  it("no abre en los últimos minutos de sesión", () => {
    const p = planOpen(openInput({ minutesLeft: NO_OPEN_LAST_MIN }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/últimos/);
  });

  it("sin trade o sin ticket no abre", () => {
    expect(planOpen(openInput({ trade: null })).position).toBeNull();
    expect(planOpen(openInput({ ticket: null })).position).toBeNull();
  });

  it("respeta el tope de posiciones abiertas", () => {
    const llenas = Array.from({ length: MAX_OPEN }, (_, i) =>
      pos({ id: `Z-${i}`, ticker: `T${i}`, model: i === 0 ? "momentum" : "magnet" }));
    const p = planOpen(openInput({ open: llenas }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/tope/);
  });

  it("un modelo sostiene UNA idea a la vez", () => {
    const p = planOpen(openInput({ open: [pos({ model: "magnet" })] }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/magnet/);
  });

  it("el otro modelo sí puede abrir a la vez", () => {
    const p = planOpen(openInput({
      open: [pos({ model: "momentum", ticker: "QQQ" })],
      trade: trade({ model: "magnet" }),
    }));
    expect(p.position).not.toBeNull();
  });

  it("descarta el contrato si la horquilla se come el edge", () => {
    const p = planOpen(openInput({ ticket: ticket({ spreadPct: MAX_SPREAD_PCT + 0.1 }) }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/Horquilla/);
  });

  it("si no cabe ni un contrato dice cuánto capital haría falta", () => {
    const p = planOpen(openInput({ ticket: ticket({ mid: 3 }) }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/Harían falta/);
  });
});

// --- gestión ----------------------------------------------------------------

describe("managePosition", () => {
  it("mantiene mientras el subyacente no toca nada", () => {
    expect(managePosition(pos(), 765.5, 300, true).action).toBe("mantener");
  });

  it("cierra por objetivo cuando el subyacente lo alcanza", () => {
    const d = managePosition(pos(), 767.2, 300, true);
    expect(d).toMatchObject({ action: "cerrar", reason: "objetivo" });
  });

  it("cierra por stop cuando el subyacente lo alcanza", () => {
    const d = managePosition(pos(), 763.0, 300, true);
    expect(d).toMatchObject({ action: "cerrar", reason: "stop" });
  });

  // Si entre dos consultas pasó por los dos, no hay forma de saber el orden;
  // darle la peor lectura falsearía el win rate a la baja.
  it("con objetivo y stop alcanzados a la vez, gana el objetivo", () => {
    const p = pos({ target: 764, stop: 766 }); // niveles cruzados a propósito
    expect(managePosition(p, 765, 300, true).reason).toBe("objetivo");
  });

  it("un SHORT se evalúa al revés", () => {
    const p = pos({ side: "SHORT", type: "put", target: 763, stop: 766.5 });
    expect(managePosition(p, 762.5, 300, true).reason).toBe("objetivo");
    expect(managePosition(p, 767, 300, true).reason).toBe("stop");
  });

  it("al cerrar la sesión se liquida lo que quede vivo", () => {
    const d = managePosition(pos(), 765.5, 0, false);
    expect(d).toMatchObject({ action: "cerrar", reason: "cierre_de_sesion" });
  });
});

describe("reprice", () => {
  it("actualiza el precio y recuerda el pico", () => {
    const p = reprice(reprice(pos(), 1.8), 1.4);
    expect(p.currentPrice).toBe(1.4);
    expect(p.peakPrice).toBe(1.8);
  });

  // Aplicar una regla sobre un valor rancio puede cerrar una posición sana.
  it("sin precio utilizable NO toca nada", () => {
    const p0 = pos();
    expect(reprice(p0, null)).toBe(p0);
    expect(reprice(p0, Number.NaN)).toBe(p0);
    expect(reprice(p0, -1)).toBe(p0);
  });
});

describe("closePosition", () => {
  it("por objetivo con ganancia queda 'ganada'", () => {
    const c = closePosition(reprice(pos(), 2.0), "objetivo", NOW);
    expect(c.status).toBe("ganada");
    expect(c.realizedPnl).toBe(80);
  });

  it("por stop con pérdida queda 'perdida'", () => {
    const c = closePosition(reprice(pos(), 0.6), "stop", NOW);
    expect(c.status).toBe("perdida");
    expect(c.realizedPnl).toBe(-60);
  });

  // El cierre de sesión no dice si el modelo acertó: dice que se acabó el día.
  it("el cierre de sesión es su propio desenlace, gane o pierda", () => {
    expect(closePosition(reprice(pos(), 2.0), "cierre_de_sesion", NOW).status).toBe("expirada");
    expect(closePosition(reprice(pos(), 0.1), "cierre_de_sesion", NOW).status).toBe("expirada");
  });
});

// --- resumen ----------------------------------------------------------------

describe("summarize", () => {
  it("sin cierres el win rate es null, no 0%", () => {
    const s = summarize([], []);
    expect(s.winRate).toBeNull();
    expect(s.equity).toBe(START_EQUITY);
  });

  it("el equity se deriva del libro", () => {
    const cerradas = [
      closePosition(reprice(pos({ id: "a" }), 2.0), "objetivo", NOW),   // +80
      closePosition(reprice(pos({ id: "b" }), 0.6), "stop", NOW),       // −60
    ];
    const s = summarize(cerradas, []);
    expect(s.realizedPnl).toBe(20);
    expect(s.equity).toBe(START_EQUITY + 20);
    expect(s.winRate).toBe(50);
  });

  it("las expiradas cuentan como cerradas pero NO entran en el win rate", () => {
    const cerradas = [
      closePosition(reprice(pos({ id: "a" }), 2.0), "objetivo", NOW),
      closePosition(reprice(pos({ id: "b" }), 0.1), "cierre_de_sesion", NOW),
    ];
    const s = summarize(cerradas, []);
    expect(s.closedCount).toBe(2);
    expect(s.expired).toBe(1);
    expect(s.winRate).toBe(100); // 1 de 1 decidida
  });

  it("separa por modelo, que es la pregunta que motivó el simulador", () => {
    const cerradas = [
      closePosition(reprice(pos({ id: "a", model: "magnet" }), 2.0), "objetivo", NOW),
      closePosition(reprice(pos({ id: "b", model: "momentum" }), 0.6), "stop", NOW),
    ];
    const s = summarize(cerradas, []);
    const magnet = s.byModel.find((m) => m.model === "magnet")!;
    const momentum = s.byModel.find((m) => m.model === "momentum")!;
    expect(magnet).toMatchObject({ closed: 1, wins: 1, pnl: 80, winRate: 100 });
    expect(momentum).toMatchObject({ closed: 1, wins: 0, pnl: -60, winRate: 0 });
  });

  it("el P&L no realizado sale de las abiertas y no toca el equity", () => {
    const s = summarize([], [reprice(pos(), 1.5)]);
    expect(s.openPnl).toBe(30);
    expect(s.equity).toBe(START_EQUITY);
  });
});

// ---------------------------------------------------------------------------
// Versión de la geometría — para que el arreglo del cono se pueda MEDIR
// ---------------------------------------------------------------------------

describe("MODELO_VERSION", () => {
  it("una posición nueva nace marcada con la versión actual", () => {
    const plan = planOpen(openInput());
    expect(plan.position?.modelVersion).toBe(MODELO_VERSION);
  });

  it("el resumen separa por versión y trata la ausencia como v1", () => {
    const vieja = pos({ status: "perdida", realizedPnl: -100 });
    delete (vieja as { modelVersion?: number }).modelVersion; // como las 12 del libro
    const nueva = pos({ id: "Z-2", status: "ganada", realizedPnl: 50, modelVersion: 2 });

    const s = summarize([vieja, nueva], []);
    expect(s.byVersion.find((x) => x.version === 1)).toMatchObject({ closed: 1, wins: 0, pnl: -100, winRate: 0 });
    expect(s.byVersion.find((x) => x.version === 2)).toMatchObject({ closed: 1, wins: 1, pnl: 50, winRate: 100 });
  });

  it("sin el desglose las dos geometrías se promediarían en un solo número", () => {
    const s = summarize([
      pos({ status: "perdida", realizedPnl: -100 }),
      pos({ id: "Z-2", status: "ganada", realizedPnl: 50, modelVersion: 2 }),
    ], []);
    expect(s.winRate).toBe(50);      // el global mezcla…
    expect(s.byVersion).toHaveLength(2); // …y el desglose es el que deja decidir
  });
});
