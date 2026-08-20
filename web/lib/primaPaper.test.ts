import { describe, expect, it } from "vitest";
import {
  MAX_LOSS_PCT, MAX_OPEN, MAX_PER_SECTOR, PROFIT_FLOOR_PCT, START_EQUITY,
  closePosition, dteOn, lossPct, managePosition, maxRiskOf, planOpen, pnlOf,
  positionFrom, profitPct, reprice, sizeFor, summarize,
  type PrimaPosition,
} from "./primaPaper";
import type { SpreadCandidate } from "./creditSpread";

// --- ayudas -----------------------------------------------------------------

const LUNES = new Date("2026-08-17T15:45:00Z");
const MARTES = new Date("2026-08-18T15:45:00Z");
const MIERCOLES = new Date("2026-08-19T18:30:00Z");
const JUEVES = new Date("2026-08-20T18:30:00Z");
const VIERNES = new Date("2026-08-21T18:30:00Z");
const VENCE = "2026-08-21";

function cand(over: Partial<{ ticker: string; sector: string; pop: number; credit: number; width: number; maxRisk: number }> = {}): SpreadCandidate {
  const { ticker = "MSFT", sector = "tech", pop = 88, credit = 0.42, width = 5, maxRisk = 458 } = over;
  return {
    ticker, sector, type: "call", spot: 500, expiration: VENCE, dte: 4, iv: 0.25,
    shortLeg: { strike: 510, delta: 0.13, absDelta: 0.13, bid: 0.4, ask: 0.44, mid: 0.42, openInterest: 900, volume: 100, spreadAbs: 0.04 },
    longLeg: { strike: 515, delta: 0.04, absDelta: 0.04, bid: 0.0, ask: 0.02, mid: 0.01, openInterest: 300, volume: 20, spreadAbs: 0.02 },
    economics: { width, credit, creditPct: (credit / width) * 100, maxRisk, breakeven: 510 + credit, distanceToBreakevenPct: 2, expectedMovePct: 3 },
    stats: { probOtmPct: pop, breakevenHitRatePct: 91, marginOverBreakevenPts: pop - 91, elevatedDelta: false },
    management: { takeProfitGain: 21, stopLossLoss: 105, gammaAlert: false, deltaRollAlert: 0.4, riskPerContract: maxRisk },
    longDeltaInBand: true, ivRank: 50, ivRankLow: false, guard: null, softMacroEvents: [], warnings: [],
  } as unknown as SpreadCandidate;
}

function pos(over: Partial<PrimaPosition> = {}): PrimaPosition {
  return {
    id: "p1", openedAt: LUNES.toISOString(), ticker: "MSFT", sector: "tech",
    type: "call_credit", shortStrike: 510, longStrike: 515, width: 5,
    expiration: VENCE, contracts: 1, entryCredit: 1.0, currentValue: 1.0,
    peakProfitPct: 0, shortDelta: 0.13, popPct: 88, status: "abierta",
    closedAt: null, closeReason: null, realizedPnl: null, ...over,
  };
}

// --- cálculos ---------------------------------------------------------------

describe("cálculos", () => {
  it("profitPct: el spread a cero es el 100% de la prima", () => {
    expect(profitPct({ entryCredit: 1, currentValue: 0 })).toBe(1);
    expect(profitPct({ entryCredit: 1, currentValue: 0.5 })).toBe(0.5);
  });

  it("lossPct es 0 mientras va en ganancia", () => {
    expect(lossPct({ entryCredit: 1, currentValue: 0.5 })).toBe(0);
    expect(lossPct({ entryCredit: 1, currentValue: 1.3 })).toBeCloseTo(0.3, 4);
  });

  it("pnlOf multiplica por 100 y por contratos", () => {
    expect(pnlOf({ entryCredit: 1, currentValue: 0.4, contracts: 2 })).toBe(120);
  });

  it("maxRiskOf = (ancho − crédito) × 100", () => {
    expect(maxRiskOf({ width: 5, entryCredit: 0.42 })).toBe(458);
  });

  it("dteOn se mide desde el día que se le pase, no del reloj real", () => {
    expect(dteOn(VENCE, LUNES)).toBe(4);
    expect(dteOn(VENCE, VIERNES)).toBe(0);
    expect(dteOn(VENCE, new Date("2026-08-24T12:00:00Z"))).toBe(-3);
  });
});

// --- apertura ---------------------------------------------------------------

describe("planOpen — solo lunes y con topes", () => {
  it("no abre ningún otro día", () => {
    for (const d of [MIERCOLES, JUEVES, VIERNES]) {
      const p = planOpen([cand()], [], d);
      expect(p.chosen).toHaveLength(0);
      expect(p.blocked).toMatch(/solo se abre los lunes y martes/);
    }
  });

  it("el martes también abre", () => {
    expect(planOpen([cand()], [], MARTES).chosen).toHaveLength(1);
  });

  // Ventana horaria: el bot Python la tenía (`entry_gate`) y se perdió al trasladar
  // el motor. Abrir fuera de horario significa cotizar con el mercado cerrado.
  it("un lunes ANTES de las 10:30 ET no abre", () => {
    const p = planOpen([cand()], [], new Date("2026-08-17T14:29:00Z")); // 10:29 ET
    expect(p.chosen).toHaveLength(0);
    expect(p.blocked).toMatch(/fuera de la ventana de apertura/);
  });

  it("un lunes DESPUÉS de las 12:00 ET no abre", () => {
    const p = planOpen([cand()], [], new Date("2026-08-17T16:00:00Z")); // 12:00 ET justo
    expect(p.chosen).toHaveLength(0);
    expect(p.blocked).toMatch(/fuera de la ventana de apertura/);
  });

  // El caso que motiva el tope estrecho: con recuperación de disparos perdidos, un
  // PC que despierta a media tarde reintentaría la corrida del lunes. Debe saltarla,
  // no abrir cuatro horas fuera del criterio del dueño.
  it("un lunes por la tarde (recuperación tardía) NO abre", () => {
    const p = planOpen([cand()], [], new Date("2026-08-17T19:00:00Z")); // 15:00 ET
    expect(p.chosen).toHaveLength(0);
    expect(p.blocked).toMatch(/fuera de la ventana de apertura/);
  });

  it("los bordes de la ventana: 10:30 ET entra, 11:59 ET todavía entra", () => {
    expect(planOpen([cand()], [], new Date("2026-08-17T14:30:00Z")).chosen).toHaveLength(1);
    expect(planOpen([cand()], [], new Date("2026-08-17T15:59:00Z")).chosen).toHaveLength(1);
  });

  // La razón de medir en Nueva York y no en el reloj local: esta laptop va en UTC−4
  // todo el año, pero en noviembre Nueva York está en UTC−5. Las 15:00Z son las
  // 11:00 locales (dentro de la ventana) pero las 10:00 ET (fuera). Con el reloj
  // local este caso pasaría y abriría media hora antes de tiempo.
  it("respeta el horario de invierno de Nueva York", () => {
    const p = planOpen([cand()], [], new Date("2026-11-16T15:00:00Z")); // lunes, 10:00 ET
    expect(p.chosen).toHaveLength(0);
    expect(p.blocked).toMatch(/fuera de la ventana de apertura/);
    // Y a las 11:45 ET de ese mismo lunes de invierno sí abre.
    expect(planOpen([cand()], [], new Date("2026-11-16T16:45:00Z")).chosen).toHaveLength(1);
  });

  it("el lunes abre y ordena por POP a secas", () => {
    // Sectores distintos a propósito: con los tres en "tech" el tope por sector
    // recortaría a 2 y el test estaría midiendo otra cosa.
    const cs = [
      cand({ ticker: "A", pop: 85, sector: "energy" }),
      cand({ ticker: "B", pop: 92, sector: "tech" }),
      cand({ ticker: "C", pop: 88, sector: "health" }),
    ];
    const p = planOpen(cs, [], LUNES);
    expect(p.chosen.map((c) => c.ticker)).toEqual(["B", "C", "A"]);
  });

  it("no pasa de 5 en una sesión", () => {
    const cs = Array.from({ length: 9 }, (_, i) => cand({ ticker: `T${i}`, sector: `s${i}`, pop: 90 - i }));
    expect(planOpen(cs, [], LUNES).chosen).toHaveLength(5);
  });

  it("respeta el tope por sector", () => {
    const cs = [cand({ ticker: "A", sector: "tech" }), cand({ ticker: "B", sector: "tech" }), cand({ ticker: "C", sector: "tech" })];
    const p = planOpen(cs, [], LUNES);
    expect(p.chosen).toHaveLength(MAX_PER_SECTOR);
    expect(p.skipped[0].why).toMatch(/por sector/);
  });

  it("no duplica subyacente ya abierto", () => {
    const p = planOpen([cand({ ticker: "MSFT" })], [pos({ ticker: "MSFT" })], LUNES);
    expect(p.chosen).toHaveLength(0);
    expect(p.skipped[0].why).toMatch(/ya hay una posición abierta/);
  });

  it("con la cartera llena no abre nada", () => {
    const llenas = Array.from({ length: MAX_OPEN }, (_, i) => pos({ id: `p${i}`, ticker: `T${i}`, sector: `s${i}` }));
    const p = planOpen([cand({ ticker: "NUEVO", sector: "otro" })], llenas, LUNES);
    expect(p.blocked).toMatch(/tope/);
  });

  it("las posiciones ya cerradas no ocupan hueco", () => {
    const cerradas = Array.from({ length: MAX_OPEN }, (_, i) => pos({ id: `c${i}`, ticker: `T${i}`, status: "ganada" }));
    expect(planOpen([cand({ ticker: "NUEVO" })], cerradas, LUNES).chosen).toHaveLength(1);
  });
});

describe("sizeFor", () => {
  it("dimensiona al 2% del capital", () => {
    expect(sizeFor(cand({ maxRisk: 458 }), 10_000)).toBe(0); // 200/458 → 0
    expect(sizeFor(cand({ maxRisk: 90 }), 10_000)).toBe(2);  // 200/90 → 2
  });
});

describe("positionFrom", () => {
  it("al abrir, cerrar cuesta lo mismo que se cobró (PnL 0)", () => {
    const p = positionFrom(cand(), 1, "x1", LUNES);
    expect(p.currentValue).toBe(p.entryCredit);
    expect(pnlOf(p)).toBe(0);
    expect(p.status).toBe("abierta");
  });
});

// --- gestión ----------------------------------------------------------------

describe("managePosition — válvula de pérdida", () => {
  it("cierra al 30% de pérdida el miércoles", () => {
    const d = managePosition(pos({ currentValue: 1.30 }), MIERCOLES);
    expect(d.action).toBe("cerrar");
    expect(d.reason).toMatch(/30%.*miércoles/);
  });

  it("la MISMA pérdida no cierra lunes ni martes", () => {
    for (const dia of [LUNES, MARTES]) {
      expect(managePosition(pos({ currentValue: 1.30 }), dia).action).not.toBe("cerrar");
    }
  });

  it("sigue vigilando jueves y viernes", () => {
    for (const dia of [JUEVES, VIERNES]) {
      expect(managePosition(pos({ currentValue: 1.5 }), dia).action).toBe("cerrar");
    }
  });

  it("una pérdida menor aguanta", () => {
    expect(managePosition(pos({ currentValue: 1.25 }), MIERCOLES).action).toBe("mantener");
  });
});

describe("managePosition — aguantar a vencimiento", () => {
  it("NO cierra al 50% de ganancia entre semana", () => {
    expect(managePosition(pos({ currentValue: 0.5 }), MIERCOLES).action).toBe("mantener");
  });

  it("ni siquiera al 80%: se persigue el 100%", () => {
    expect(managePosition(pos({ currentValue: 0.2 }), JUEVES).action).toBe("mantener");
  });

  it("gamma caliente avisa pero no cierra", () => {
    const d = managePosition(pos({ currentValue: 0.9, shortDelta: 0.55 }), JUEVES);
    expect(d.action).toBe("avisar");
  });
});

describe("managePosition — suelo de ganancia del viernes", () => {
  it("retroceso material estando sobre el 50% → cierra", () => {
    const d = managePosition(pos({ currentValue: 0.42, peakProfitPct: 0.70 }), VIERNES);
    expect(d.action).toBe("cerrar");
    expect(d.reason).toMatch(/Suelo de ganancia/);
  });

  it("si ya cayó por debajo del 50% NO cierra ahí", () => {
    // Cerrar al 30% no cumple "recoger con más del 50%".
    expect(managePosition(pos({ currentValue: 0.70, peakProfitPct: 0.70 }), VIERNES).action).toBe("mantener");
  });

  it("un tick de ruido no cierra", () => {
    expect(managePosition(pos({ currentValue: 0.32, peakProfitPct: 0.70 }), VIERNES).action).toBe("mantener");
  });

  it("si nunca tocó el suelo, no cierra", () => {
    expect(managePosition(pos({ currentValue: 0.70, peakProfitPct: 0.35 }), VIERNES).action).toBe("mantener");
  });

  it("si sigue subiendo, no cierra", () => {
    expect(managePosition(pos({ currentValue: 0.10, peakProfitPct: 0.60 }), VIERNES).action).toBe("mantener");
  });

  it("el suelo NO aplica antes del vencimiento", () => {
    expect(managePosition(pos({ currentValue: 0.42, peakProfitPct: 0.70 }), MIERCOLES).action).toBe("mantener");
  });

  it("pasado el vencimiento se liquida", () => {
    const d = managePosition(pos({ currentValue: 0 }), new Date("2026-08-24T14:00:00Z"));
    expect(d.action).toBe("cerrar");
    expect(d.reason).toMatch(/Venció/);
  });
});

describe("reprice y closePosition", () => {
  it("reprice recuerda el pico aunque luego baje", () => {
    let p = pos({ currentValue: 1.0 });
    p = reprice(p, 0.4);              // +60%
    expect(p.peakProfitPct).toBeCloseTo(0.6, 4);
    p = reprice(p, 0.8);              // cae a +20%
    expect(p.peakProfitPct).toBeCloseTo(0.6, 4);
    expect(profitPct(p)).toBeCloseTo(0.2, 4);
  });

  it("closePosition sella estado, motivo y PnL", () => {
    const c = closePosition(pos({ currentValue: 0.4 }), "prueba", VIERNES);
    expect(c.status).toBe("ganada");
    expect(c.realizedPnl).toBe(60);
    expect(c.closeReason).toBe("prueba");
    expect(c.closedAt).toBeTruthy();
  });

  it("una pérdida se marca como perdida", () => {
    expect(closePosition(pos({ currentValue: 1.5 }), "stop", MIERCOLES).status).toBe("perdida");
  });
});

// --- cuenta -----------------------------------------------------------------

describe("summarize — capital acumulativo", () => {
  const ganada = (pnl: number) => pos({ status: pnl > 0 ? "ganada" : pnl < 0 ? "perdida" : "neutra", realizedPnl: pnl });

  it("sin operaciones la cuenta está intacta y el win rate es null", () => {
    const s = summarize([], []);
    expect(s.equity).toBe(START_EQUITY);
    expect(s.winRate).toBeNull();
  });

  it("suma y resta sobre los $10.000 de partida", () => {
    const s = summarize([ganada(250), ganada(-100), ganada(80)], []);
    expect(s.realizedPnl).toBe(230);
    expect(s.equity).toBe(10_230);
    expect(s.returnPct).toBe(2.3);
  });

  it("NO se resetea: añadir operaciones sigue acumulando", () => {
    const libro = [ganada(250), ganada(-100)];
    expect(summarize(libro, []).equity).toBe(10_150);
    libro.push(ganada(500));
    expect(summarize(libro, []).equity).toBe(10_650);
  });

  it("el win rate ignora las neutras", () => {
    expect(summarize([ganada(100), ganada(-30), ganada(0)], []).winRate).toBe(50);
  });

  it("lo abierto va aparte del capital realizado", () => {
    const abierta = pos({ currentValue: 0.5 });       // +$50
    const s = summarize([ganada(100)], [abierta]);
    expect(s.equity).toBe(10_100);
    expect(s.unrealizedPnl).toBe(50);
    expect(s.openCount).toBe(1);
    expect(s.committed).toBe(maxRiskOf(abierta));
  });

  it("la curva lleva un punto por operación más el inicio", () => {
    expect(summarize([ganada(250), ganada(-100)], []).equityCurve).toEqual([10_000, 10_250, 10_150]);
  });
});
