// Comisiones en los tres simuladores de paper. La tarifa y la regla viven en
// `commissions.ts`; aquí se fija cómo la aplica cada motor.

import { describe, it, expect } from "vitest";
import { COMISION_POR_CONTRATO, commissionOf } from "./commissions";
import * as zero from "./zerodtePaper";
import * as prima from "./primaPaper";
import * as swing from "./paperTrade";

describe("commissionOf", () => {
  it("cobra por contrato, por pata y por orden", () => {
    expect(COMISION_POR_CONTRATO).toBe(0.65);
    expect(commissionOf(1, 1, true)).toBe(1.3);   // opción suelta, abre y cierra
    expect(commissionOf(2, 2, true)).toBe(5.2);   // vertical ×2, abre y cierra
    expect(commissionOf(2, 2, false)).toBe(2.6);  // vertical ×2 que vence
  });

  it("sin contratos no hay nada que cobrar", () => {
    expect(commissionOf(0, 1, true)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 0DTE
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-24T15:00:00Z");

function zpos(over: Partial<zero.ZeroPaperPosition> = {}): zero.ZeroPaperPosition {
  return {
    id: "Z-1", openedAt: NOW.toISOString(), ticker: "SPY", expiration: "2026-08-24",
    optionSymbol: "SPY260824C00766000", type: "call", strike: 766, contracts: 3,
    entryPrice: 1.2, currentPrice: 1.2, peakPrice: 1.2,
    model: "magnet", side: "LONG", entrySpot: 765, target: 767, stop: 763.5,
    status: "abierta", closedAt: null, closeReason: null, realizedPnl: null, ...over,
  };
}

describe("0DTE — comisiones", () => {
  it("un cierre con orden guarda entrada + salida y deja el bruto intacto", () => {
    const c = zero.closePosition(zero.reprice(zpos(), 2.0), "objetivo", NOW);
    expect(c.realizedPnl).toBe(240);   // bruto
    expect(c.fees).toBe(3.9);          // 3 × $0,65 × 2
    expect(zero.netPnlOf(c)).toBe(236.1);
  });

  it("el cierre de sesión solo paga la entrada: el contrato venció", () => {
    const c = zero.closePosition(zero.reprice(zpos(), 0), "cierre_de_sesion", NOW);
    expect(c.fees).toBe(1.95);
  });

  it("una ganancia bruta menor que la comisión es una PÉRDIDA", () => {
    // +$0,30 brutos (1 contrato, +0,003) contra $1,30 de comisiones.
    const c = zero.closePosition(zero.reprice(zpos({ contracts: 1 }), 1.203), "trailing", NOW);
    expect(c.realizedPnl).toBe(0.3);
    expect(c.status).toBe("perdida");
  });

  it("las filas anteriores sin `fees` se derivan con la misma regla", () => {
    const vieja = zpos({ status: "ganada", closeReason: "stop", realizedPnl: 50, closedAt: NOW.toISOString() });
    expect(vieja.fees).toBeUndefined();
    expect(zero.feesOf(vieja)).toBe(3.9);
    const vencida = zpos({ status: "expirada", closeReason: "cierre_de_sesion", realizedPnl: -100 });
    expect(zero.feesOf(vencida)).toBe(1.95);
  });

  it("el resumen separa bruto, comisiones y neto, y el latente descuenta la entrada", () => {
    const cerrada = zero.closePosition(zero.reprice(zpos(), 2.0), "objetivo", NOW);
    const abierta = zero.reprice(zpos({ id: "Z-2" }), 1.5); // +90 bruto
    const s = zero.summarize([cerrada], [abierta]);
    expect(s.grossPnl).toBe(240);
    expect(s.realizedPnl).toBe(236.1);
    expect(s.equity).toBe(zero.START_EQUITY + 236.1);
    expect(s.openPnl).toBe(88.05);                 // 90 − 1,95 de la entrada
    expect(s.feesPaid).toBe(5.85);                 // 3,90 + 1,95
  });

  it("el win rate con dinero cuenta por el signo del NETO", () => {
    const casi = zpos({ status: "ganada", closeReason: "trailing", realizedPnl: 1, contracts: 1 });
    const s = zero.summarize([casi], []);
    expect(s.winsMoney).toBe(0);
    expect(s.lossesMoney).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Venta de Prima
// ---------------------------------------------------------------------------

function ppos(over: Partial<prima.PrimaPosition> = {}): prima.PrimaPosition {
  return {
    id: "p1", openedAt: "2026-08-17T15:45:00Z", ticker: "SPY", sector: "Índice",
    type: "put_credit", shortStrike: 747, longStrike: 746, width: 1,
    expiration: "2026-08-21", contracts: 2, entryCredit: 0.07, currentValue: 0.07,
    peakProfitPct: 0, shortDelta: 0.12, popPct: 90, status: "abierta",
    closedAt: null, closeReason: null, realizedPnl: null, ...over,
  };
}

describe("Venta de Prima — comisiones", () => {
  it("cerrar antes de vencer paga las dos patas al abrir y al cerrar", () => {
    const c = prima.closePosition(prima.reprice(ppos(), 0.01), "suelo", new Date("2026-08-21T19:00:00Z"));
    expect(c.realizedPnl).toBe(12);
    expect(c.fees).toBe(5.2);           // 2 × 2 patas × $0,65 × 2 órdenes
    expect(prima.netPnlOf(c)).toBe(6.8);
    expect(c.status).toBe("ganada");
  });

  it("liquidar tras vencer solo paga la apertura", () => {
    const c = prima.closePosition(prima.reprice(ppos(), 0), "Venció", new Date("2026-08-24T19:00:00Z"));
    expect(c.fees).toBe(2.6);
  });

  it("un crédito que no cubre las comisiones es una pérdida", () => {
    // +$2 brutos contra $5,20.
    const c = prima.closePosition(prima.reprice(ppos(), 0.06), "suelo", new Date("2026-08-20T19:00:00Z"));
    expect(c.realizedPnl).toBe(2);
    expect(c.status).toBe("perdida");
  });

  it("las filas antiguas se derivan por calendario, no leyendo el motivo", () => {
    const vencida = ppos({ status: "ganada", realizedPnl: 14, closeReason: "texto cualquiera", closedAt: "2026-09-07T20:00:00Z" });
    expect(prima.feesOf(vencida)).toBe(2.6);
    const cerrada = ppos({ status: "perdida", realizedPnl: -8, closeReason: "Pérdida 67%", closedAt: "2026-08-19T19:00:00Z" });
    expect(prima.feesOf(cerrada)).toBe(5.2);
  });

  it("el resumen usa el neto: capital, curva, win rate y latente", () => {
    const gana = ppos({ id: "a", status: "ganada", realizedPnl: 12, closedAt: "2026-08-19T19:00:00Z" });
    const casi = ppos({ id: "b", status: "ganada", realizedPnl: 2, closedAt: "2026-08-19T19:00:00Z" });
    const abierta = prima.reprice(ppos({ id: "c" }), 0.02); // +10 bruto
    const s = prima.summarize([gana, casi], [abierta]);
    expect(s.grossPnl).toBe(14);
    expect(s.realizedPnl).toBe(3.6);           // (12 − 5,2) + (2 − 5,2)
    expect(s.equity).toBe(prima.START_EQUITY + 3.6);
    expect(s.equityCurve).toEqual([10000, 10006.8, 10003.6]);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);                  // el +$2 bruto es pérdida neta
    expect(s.unrealizedPnl).toBe(7.4);         // 10 − 2,60 de la apertura
    expect(s.feesPaid).toBe(13);               // 5,2 + 5,2 + 2,6
  });
});

// ---------------------------------------------------------------------------
// Swing
// ---------------------------------------------------------------------------

const SNOW = new Date("2026-08-03T14:30:00.000Z");

function strade(over: Partial<swing.PaperTrade> = {}): swing.PaperTrade {
  return {
    id: "t1", createdAt: "2026-08-03T13:00:00.000Z", source: "manual",
    ticker: "IWM", optionType: "call", strike: 295, expiration: "2026-08-15",
    direction: "up", trigger: 296, target: 297, stop: 295, trailing: false,
    probability: 65, note: null, contracts: 10,
    status: "activa", entryPrice: 0.91, entryAt: SNOW.toISOString(),
    exitPrice: null, exitAt: null, peakPrice: 0.91,
    currentUnderlying: null, currentPrice: null, updatedAt: null,
    closeReason: null, verdict: null, ...over,
  };
}

describe("Swing — comisiones", () => {
  it("un cierre con precio guarda entrada + salida", () => {
    const t = swing.evaluate(strade(), 297.0, 1.6, SNOW);
    expect(t.closeReason).toBe("objetivo");
    expect(t.fees).toBe(13);                 // 10 × $0,65 × 2
    expect(swing.netRealizedPnl(t)).toBeCloseTo(690 - 13, 6);
  });

  it("liquidar al vencimiento solo paga la entrada", () => {
    const t = swing.evaluate(strade(), 300, null, new Date("2026-08-18T14:30:00Z"), 300);
    expect(t.closeReason).toBe("expirada");
    expect(t.fees).toBe(6.5);
  });

  it("lo que nunca entró no paga nada, y un cierre sin precio no suma", () => {
    const pendiente = strade({ status: "pendiente", entryPrice: null, entryAt: null, peakPrice: null });
    expect(swing.feesOf(pendiente)).toBe(0);
    const caducada = swing.evaluate(pendiente, 290, null, new Date("2026-08-20T14:30:00Z"));
    expect(caducada.fees).toBeUndefined();
    const sinPrecio = strade({ status: "ganada", closeReason: "objetivo", exitPrice: null });
    expect(swing.netRealizedPnl(sinPrecio)).toBe(0);
  });

  it("el resumen y el capital van netos; el activo descuenta su entrada", () => {
    const cerrada = swing.evaluate(strade({ riskPctUsed: 0.02 }), 297.0, 1.6, SNOW);
    const activa = strade({ id: "t2", currentPrice: 1.0 }); // +90 bruto
    const s = swing.summarize([cerrada, activa]);
    expect(s.grossPnl).toBeCloseTo(690, 6);
    expect(s.closedPnl).toBeCloseTo(677, 6);
    expect(s.openUnrealized).toBeCloseTo(90 - 6.5, 6);
    expect(s.feesPaid).toBeCloseTo(13 + 6.5, 6);
    expect(s.equity).toBeCloseTo(swing.START_EQUITY + 677, 6);
  });

  it("una expirada con ganancia bruta menor que la comisión se cuenta como fallo", () => {
    const t = strade({ status: "expirada", closeReason: "expirada", exitPrice: 0.915 }); // +5 bruto
    expect(swing.feesOf(t)).toBe(6.5);
    expect(swing.outcomeOf(t)).toBe("fallo");
  });
});

// ---------------------------------------------------------------------------
// Alertas de cierre: lo que llega al móvil es el NETO
// ---------------------------------------------------------------------------

import { primaClosedText, zeroClosedText } from "./alertText";

describe("alertas de cierre — resultado neto", () => {
  it("0DTE: publica el neto y desglosa bruto y comisiones", () => {
    const c = zero.closePosition(zero.reprice(zpos(), 2.0), "objetivo", NOW);
    const txt = zeroClosedText(c, 10_000);
    expect(txt).toContain("resultado neto <b>+$236.1</b>");
    expect(txt).toContain("bruto +$240 − $3.9 de comisiones");
    // Salto de línea real antes del desglose, no la secuencia "\n" escrita.
    expect(txt).toContain("</b> (+67%)\n<i>bruto");
    expect(txt).not.toContain("\\n");
  });

  it("Venta de Prima: una ganancia bruta que no cubre comisiones sale en rojo", () => {
    const c = prima.closePosition(prima.reprice(ppos(), 0.06), "suelo", new Date("2026-08-20T19:00:00Z"));
    const txt = primaClosedText(c, 10_000);
    expect(txt).toContain("🔴");
    expect(txt).toContain("resultado neto <b>−$3.2</b>");
    expect(txt).toContain("bruto +$2 − $5.2 de comisiones");
  });
});
