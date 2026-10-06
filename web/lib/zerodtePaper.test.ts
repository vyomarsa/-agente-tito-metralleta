import { describe, expect, it } from "vitest";
import {
  MAX_OPEN, MAX_SPREAD_PCT, NO_OPEN_LAST_MIN, START_EQUITY,
  closePosition, managePosition, maxRiskOf, planOpen, pnlOf, reprice,
  returnPct, sizeFor, summarize, MODELO_VERSION, CIERRE_RELOJ_MIN,
  gatilloTrailing, TRAIL_ARMA_PCT, TRAIL_DEVOLUCION_PCT,
  type ZeroPaperPosition,
  minutesSinceLastClose,
  REOPEN_COOLDOWN_MIN,
  MAX_PERDIDAS_DIA, perdidasDelDia, pnlDelDia,
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
    // fees: 0 → estos tests prueban la lógica del plan; las comisiones van aparte.
    status: "abierta", closedAt: null, closeReason: null, realizedPnl: null, fees: 0, ...over,
  };
}

function openInput(over: Partial<Parameters<typeof planOpen>[0]> = {}) {
  return {
    ticker: "SPY", expiration: "2026-08-24", ticket: ticket(), trade: trade(),
    spot: 765, equity: START_EQUITY, open: [] as ZeroPaperPosition[],
    closed: [] as ZeroPaperPosition[],
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
    // Neto: cada una paga $1,30 (1 contrato × $0,65 × entrada y salida).
    expect(s.realizedPnl).toBe(17.4);
    expect(s.grossPnl).toBe(20);
    expect(s.feesPaid).toBe(2.6);
    expect(s.equity).toBe(START_EQUITY + 17.4);
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
    // Netos de $1,30 de comisiones cada una.
    expect(magnet).toMatchObject({ closed: 1, wins: 1, pnl: 78.7, winRate: 100 });
    expect(momentum).toMatchObject({ closed: 1, wins: 0, pnl: -61.3, winRate: 0 });
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

// --- enfriamiento tras un cierre --------------------------------------------

/** Una cerrada de `model`, cerrada `minAntes` minutos antes de NOW. */
function cerrada(
  model: ZeroPaperPosition["model"],
  minAntes: number,
  over: Partial<ZeroPaperPosition> = {},
): ZeroPaperPosition {
  return {
    openedAt: new Date(NOW.getTime() - (minAntes + 30) * 60_000).toISOString(),
    ticker: "SPY", expiration: "2026-08-24", optionSymbol: "SPY260824C00766000",
    type: "call", strike: 766, contracts: 1,
    entryPrice: 1.2, currentPrice: 0.5, peakPrice: 1.3,
    model, modelVersion: 2, side: "LONG",
    entrySpot: 765, target: 767, stop: 763.5,
    status: "perdida",
    closedAt: new Date(NOW.getTime() - minAntes * 60_000).toISOString(),
    closeReason: "stop", realizedPnl: -70,
    ...over,
  } as ZeroPaperPosition;
}

describe("minutesSinceLastClose", () => {
  it("mide desde el cierre MÁS RECIENTE de ese modelo", () => {
    const closed = [cerrada("magnet", 90), cerrada("magnet", 3)];
    expect(minutesSinceLastClose(closed, "magnet", NOW)).toBeCloseTo(3, 5);
  });

  it("no mira los otros modelos", () => {
    expect(minutesSinceLastClose([cerrada("magnet", 1)], "momentum", NOW)).toBeNull();
  });

  it("null cuando el modelo no ha cerrado nada", () => {
    expect(minutesSinceLastClose([], "magnet", NOW)).toBeNull();
  });

  it("una cerrada sin closedAt no desbloquea la entrada: se ignora", () => {
    const rota = cerrada("magnet", 1, { closedAt: null });
    expect(minutesSinceLastClose([rota], "magnet", NOW)).toBeNull();
  });
});

describe("límite diario de pérdidas", () => {
  const AYER = new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString();

  it("tras la primera pérdida de hoy no abre nada más, aunque haya señal", () => {
    const p = planOpen(openInput({ closed: [cerrada("momentum", 60)] }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/Límite diario/);
    expect(MAX_PERDIDAS_DIA).toBe(1);
  });

  it("una GANADORA no cuenta", () => {
    const p = planOpen(openInput({ closed: [cerrada("momentum", 60, { status: "ganada", realizedPnl: 40 })] }));
    expect(p.position).not.toBeNull();
  });

  it("se mide en NETO: una ganancia bruta que no cubre la comisión es pérdida", () => {
    const casi = cerrada("momentum", 60, { status: "ganada", realizedPnl: 1, contracts: 1 });
    expect(perdidasDelDia([casi], NOW)).toBe(1);
  });

  it("las pérdidas de AYER no bloquean hoy", () => {
    const vieja = cerrada("momentum", 60, { openedAt: AYER, closedAt: AYER });
    const p = planOpen(openInput({ closed: [vieja] }));
    expect(p.position).not.toBeNull();
  });

  it("liquidar HOY una posición abierta otro día no cuenta contra la sesión", () => {
    const vencida = cerrada("momentum", 60, { openedAt: AYER, closeReason: "cierre_de_sesion", status: "expirada" });
    expect(perdidasDelDia([vencida], NOW)).toBe(0);
  });

  it("el P&L del día suma solo lo de hoy, neto", () => {
    const hoy = cerrada("momentum", 60); // −70 bruto, −1,30 de comisiones
    const vieja = cerrada("magnet", 60, { openedAt: AYER, closedAt: AYER, realizedPnl: -500 });
    expect(pnlDelDia([hoy, vieja], NOW)).toBe(-71.3);
  });

  it("el límite va antes que la señal: bloquea aunque no haya trade", () => {
    const p = planOpen(openInput({ trade: null, ticket: null, closed: [cerrada("momentum", 60)] }));
    expect(p.blocked).toMatch(/Límite diario/);
  });
});

describe("enfriamiento: no reabrir en el mismo tick que cerró", () => {
  // El enfriamiento aplica tras CUALQUIER cierre. Aquí el cierre es GANADOR para
  // aislarlo del límite diario, que con una pérdida de hoy bloquearía antes.
  const GANO = { status: "ganada", closeReason: "objetivo", realizedPnl: 70 } as const;
  it("bloquea la reapertura inmediata (el caso que costó el 81% de la pérdida)", () => {
    const p = planOpen(openInput({ closed: [cerrada("magnet", 0, GANO)] }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/enfriamiento/);
  });

  it("bloquea también el GIRO de lado, que era 11 de las 15 reentradas", () => {
    // Acaba de cerrar un LONG por stop; el trade nuevo es SHORT del mismo modelo.
    const corto = trade({ side: "SHORT", target: 763, stop: 766.5 });
    const p = planOpen(openInput({ trade: corto, closed: [cerrada("magnet", 0, { ...GANO, side: "LONG" })] }));
    expect(p.position).toBeNull();
    expect(p.blocked).toMatch(/enfriamiento/);
  });

  it("pasado el enfriamiento vuelve a abrir con normalidad", () => {
    const p = planOpen(openInput({ closed: [cerrada("magnet", REOPEN_COOLDOWN_MIN + 1, GANO)] }));
    expect(p.blocked).toBe("");
    expect(p.position).not.toBeNull();
  });

  it("justo en el límite ya puede abrir (la espera es estricta, no inclusiva)", () => {
    const p = planOpen(openInput({ closed: [cerrada("magnet", REOPEN_COOLDOWN_MIN, GANO)] }));
    expect(p.position).not.toBeNull();
  });

  it("el enfriamiento es POR MODELO: el cierre de magnet no frena a momentum", () => {
    const mom = trade({ model: "momentum" });
    const p = planOpen(openInput({ trade: mom, closed: [cerrada("magnet", 0, GANO)] }));
    expect(p.blocked).toBe("");
    expect(p.position).not.toBeNull();
  });

  it("un libro cerrado vacío no bloquea nada", () => {
    expect(planOpen(openInput({ closed: [] })).position).not.toBeNull();
  });
});

describe("byModelVersion — el 25% de momentum mezclaba dos geometrías", () => {
  it("separa cada modelo por versión y omite las combinaciones vacías", () => {
    const closed = [
      cerrada("momentum", 100, { modelVersion: 1, status: "perdida", realizedPnl: -50 }),
      cerrada("momentum", 90, { modelVersion: 1, status: "perdida", realizedPnl: -50 }),
      cerrada("momentum", 80, { modelVersion: 2, status: "ganada", realizedPnl: 40 }),
      cerrada("magnet", 70, { modelVersion: 2, status: "ganada", realizedPnl: 30 }),
    ];
    const s = summarize(closed, []);
    const mv = s.byModelVersion;
    expect(mv.find((r) => r.model === "momentum" && r.version === 1)).toMatchObject({
      closed: 2, wins: 0, winRate: 0,
    });
    expect(mv.find((r) => r.model === "momentum" && r.version === 2)).toMatchObject({
      closed: 1, wins: 1, winRate: 100,
    });
    // magnet no tiene ninguna v1: esa fila no se publica.
    expect(mv.find((r) => r.model === "magnet" && r.version === 1)).toBeUndefined();
  });

  it("el modelo a secas seguiría dando el número mezclado, y por eso hace falta el corte", () => {
    const closed = [
      cerrada("momentum", 100, { modelVersion: 1, status: "perdida", realizedPnl: -50 }),
      cerrada("momentum", 90, { modelVersion: 2, status: "ganada", realizedPnl: 40 }),
    ];
    const s = summarize(closed, []);
    expect(s.byModel.find((m) => m.model === "momentum")?.winRate).toBe(50); // mezcla
    expect(s.byModelVersion.find((r) => r.model === "momentum" && r.version === 2)?.winRate).toBe(100);
  });
});

describe("summarize — los DOS win rates", () => {
  const cerrada = (over: Partial<ZeroPaperPosition> = {}): ZeroPaperPosition =>
    pos({ status: "ganada", realizedPnl: 100, closedAt: "2026-09-07T20:00:00Z", ...over });

  it("el win rate POR DESENLACE deja fuera las expiradas; el de DINERO no", () => {
    // La forma del caso real del 2026-09-07: las cerradas al fin de sesión son
    // casi todas pérdidas y quedaban invisibles en el único win rate que se veía.
    const closed = [
      cerrada({ status: "ganada", realizedPnl: 100 }),
      cerrada({ status: "perdida", realizedPnl: -50 }),
      cerrada({ status: "expirada", realizedPnl: -200 }),
      cerrada({ status: "expirada", realizedPnl: -200 }),
    ];
    const s = summarize(closed, []);
    expect(s.winRate).toBe(50);          // 1W/1L sobre las decididas
    expect(s.winRateMoneyPct).toBe(25);  // 1W/3L sobre TODAS
    expect(s.winsMoney).toBe(1);
    expect(s.lossesMoney).toBe(3);
    expect(s.expired).toBe(2);
  });

  it("sin expiradas los dos coinciden", () => {
    const closed = [
      cerrada({ status: "ganada", realizedPnl: 100 }),
      cerrada({ status: "perdida", realizedPnl: -50 }),
    ];
    const s = summarize(closed, []);
    expect(s.winRate).toBe(s.winRateMoneyPct);
  });

  it("una expirada en positivo cuenta como ganada CON DINERO", () => {
    // No todas las del fin de sesión pierden: una de las ocho reales acabó +$136.
    const s = summarize([cerrada({ status: "expirada", realizedPnl: 136.5 })], []);
    expect(s.winRateMoneyPct).toBe(100);
    expect(s.winRate).toBeNull(); // ninguna decidida por objetivo o stop
  });

  it("sin cierres, los dos son null y no un 0% falso", () => {
    const s = summarize([], []);
    expect(s.winRate).toBeNull();
    expect(s.winRateMoneyPct).toBeNull();
  });
});

describe("cierre por reloj a las 15:30", () => {
  const p = () => pos({ side: "LONG", target: 110, stop: 90, entryPrice: 1, currentPrice: 1.5 });

  it("con la sesión avanzada pero antes de las 15:30, se mantiene", () => {
    const d = managePosition(p(), 100, CIERRE_RELOJ_MIN + 1, true);
    expect(d.action).toBe("mantener");
  });

  it("a las 15:30 en punto se cierra por reloj", () => {
    const d = managePosition(p(), 100, CIERRE_RELOJ_MIN, true);
    expect(d.action).toBe("cerrar");
    expect(d.reason).toBe("cierre_reloj");
  });

  it("el OBJETIVO manda sobre el reloj: si llegó, ese trade lo decidió su plan", () => {
    const d = managePosition(p(), 111, CIERRE_RELOJ_MIN, true);
    expect(d.reason).toBe("objetivo");
  });

  it("y el STOP también manda sobre el reloj", () => {
    const d = managePosition(p(), 89, CIERRE_RELOJ_MIN, true);
    expect(d.reason).toBe("stop");
  });

  it("con la campana ya sonada el motivo es FIN DE SESIÓN, no el reloj", () => {
    // Ahí el contrato venció y no hay salida al mid que registrar: etiquetarlo
    // como cierre por reloj fingiría una venta que nunca ocurrió.
    expect(managePosition(p(), 100, 0, false).reason).toBe("cierre_de_sesion");
    expect(managePosition(p(), 100, -5, false).reason).toBe("cierre_de_sesion");
    expect(managePosition(p(), 100, 5, false).reason).toBe("cierre_de_sesion");
  });

  it("un cierre por RELOJ cuenta como ganada o perdida, NO como expirada", () => {
    // Si fuera "expirada" volvería a caer fuera del win rate por desenlace, que es
    // justo donde estas operaciones estaban escondidas.
    const gana = closePosition(pos({ entryPrice: 1, currentPrice: 1.4 }), "cierre_reloj", new Date());
    expect(gana.status).toBe("ganada");
    const pierde = closePosition(pos({ entryPrice: 1, currentPrice: 0.4 }), "cierre_reloj", new Date());
    expect(pierde.status).toBe("perdida");
    const expira = closePosition(pos({ entryPrice: 1, currentPrice: 0.01 }), "cierre_de_sesion", new Date());
    expect(expira.status).toBe("expirada");
  });

  it("la hora de cerrar coincide con la de dejar de abrir: nada vive un minuto", () => {
    expect(CIERRE_RELOJ_MIN).toBe(NO_OPEN_LAST_MIN);
  });
});

describe("stop por devolución de pico", () => {
  const viva = (over = {}) =>
    pos({ side: "LONG", target: 110, stop: 90, entryPrice: 1, ...over });

  it("no se arma si la posición nunca llegó a correr", () => {
    expect(gatilloTrailing({ entryPrice: 1, peakPrice: 1 + TRAIL_ARMA_PCT - 0.01 })).toBeNull();
    expect(gatilloTrailing({ entryPrice: 1, peakPrice: 0.8 })).toBeNull();
  });

  it("se arma justo en el umbral y asegura la parte fijada de la ganancia", () => {
    const g = gatilloTrailing({ entryPrice: 1, peakPrice: 1 + TRAIL_ARMA_PCT });
    expect(g).toBeCloseTo(1 + TRAIL_ARMA_PCT * (1 - TRAIL_DEVOLUCION_PCT), 6);
  });

  it("una vez armado NO se desarma porque el precio vuelva", () => {
    // Se mira el PICO, no el precio de ahora: la protección se gana por haber
    // llegado. Si se mirara el actual, la posición perdería su red justo cuando
    // más la necesita.
    expect(gatilloTrailing({ entryPrice: 1, peakPrice: 2 })).toBeCloseTo(1 + (1 - TRAIL_DEVOLUCION_PCT), 6);
  });

  it("cierra cuando devuelve más de lo permitido", () => {
    const p = viva({ peakPrice: 2, currentPrice: 1.7 }); // gatillo en 1.75 (devuelve 25%)
    const d = managePosition(p, 100, 200, true);
    expect(d.action).toBe("cerrar");
    expect(d.reason).toBe("trailing");
  });

  it("aguanta mientras siga por encima del gatillo", () => {
    const d = managePosition(viva({ peakPrice: 2, currentPrice: 1.8 }), 100, 200, true);
    expect(d.action).toBe("mantener");
  });

  it("el OBJETIVO y el STOP siguen mandando sobre el trailing", () => {
    const p = viva({ peakPrice: 2, currentPrice: 1.4 });
    expect(managePosition(p, 111, 200, true).reason).toBe("objetivo");
    expect(managePosition(p, 89, 200, true).reason).toBe("stop");
  });

  it("el trailing manda sobre el reloj: dice más que 'se hizo la hora'", () => {
    const p = viva({ peakPrice: 2, currentPrice: 1.4 });
    expect(managePosition(p, 100, CIERRE_RELOJ_MIN, true).reason).toBe("trailing");
  });

  it("un cierre por trailing cuenta como ganada, no como expirada", () => {
    const c = closePosition(viva({ peakPrice: 2, currentPrice: 1.5 }), "trailing", new Date());
    expect(c.status).toBe("ganada");
    expect(c.realizedPnl).toBeGreaterThan(0);
  });

  it("v4: se arma al +20% y devuelve como mucho el 25% de la ganancia", () => {
    // Recalibrado el 2026-09-17 con el camino real de SPY (ver TRAIL_ARMA_PCT).
    // Si alguien lo mueve, que sea a propósito y con la misma medición.
    expect(TRAIL_ARMA_PCT).toBe(0.2);
    expect(TRAIL_DEVOLUCION_PCT).toBe(0.25);
    expect(MODELO_VERSION).toBe(4);
    expect(gatilloTrailing({ entryPrice: 1, peakPrice: 1.19 })).toBeNull();
    expect(gatilloTrailing({ entryPrice: 1, peakPrice: 1.2 })).toBeCloseTo(1.15, 6);
  });

  it("una posición sin precio de entrada no arma nada", () => {
    expect(gatilloTrailing({ entryPrice: 0, peakPrice: 5 })).toBeNull();
  });
});

describe("summarize — por LADO", () => {
  const cerr = (over = {}) => pos({ status: "ganada", realizedPnl: 100, ...over });

  it("separa largo de corto y cruza con la versión", () => {
    const closed = [
      cerr({ side: "LONG", modelVersion: 2, realizedPnl: 100 }),
      cerr({ side: "LONG", modelVersion: 2, realizedPnl: -40 }),
      cerr({ side: "SHORT", modelVersion: 2, realizedPnl: -200 }),
      cerr({ side: "SHORT", modelVersion: 1, realizedPnl: -50 }),
    ];
    const s = summarize(closed, []);
    const l2 = s.bySide.find((r) => r.side === "LONG" && r.version === 2)!;
    const c2 = s.bySide.find((r) => r.side === "SHORT" && r.version === 2)!;
    expect(l2.closed).toBe(2);
    expect(l2.winRate).toBe(50);
    expect(c2.closed).toBe(1);
    expect(c2.pnl).toBe(-200);
    expect(s.bySide.find((r) => r.side === "SHORT" && r.version === 1)!.closed).toBe(1);
  });

  it("el win rate por lado va por el SIGNO DEL P&L, no por desenlace", () => {
    // Una expirada en pérdida tiene que contar aquí: si se excluyera, el corto
    // saldría limpio justo en las operaciones donde más pierde.
    const s = summarize([cerr({ side: "SHORT", status: "expirada", realizedPnl: -300 })], []);
    const corto = s.bySide.find((r) => r.side === "SHORT")!;
    expect(corto.closed).toBe(1);
    expect(corto.winRate).toBe(0);
    expect(corto.pnl).toBe(-300);
  });

  it("no inventa filas de lados sin operaciones", () => {
    const s = summarize([cerr({ side: "LONG" })], []);
    expect(s.bySide.every((r) => r.closed > 0)).toBe(true);
    expect(s.bySide.some((r) => r.side === "SHORT")).toBe(false);
  });
});
