import { describe, expect, it } from "vitest";
import {
  evaluate,
  summarize,
  realizedPnl,
  unrealizedPnl,
  securedGain,
  trailStopPrice,
  isPriced,
  intrinsicValue,
  outcomeOf,
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

/**
 * Regresión del "P&L en cero" (2026-08-24).
 *
 * Con el criterio viejo, un cierre sin prima fresca salía al precio de ENTRADA
 * (P&L exactamente $0) y, como el win rate contaba por el signo del P&L, ese
 * acierto desaparecía del marcador. Había 12 operaciones decididas en el libro
 * (11 objetivos y 1 stop) y la pantalla decía "0W · 0L · win rate —".
 */
describe("cierre sin prima fresca — no se inventa el precio de salida", () => {
  const active = trade({
    status: "activa", entryPrice: 0.91, entryAt: NOW.toISOString(),
    peakPrice: 0.91, currentPrice: 0.91, trailing: false,
  });

  it("cierra por el subyacente pero deja la salida SIN precio", () => {
    const t = evaluate(active, 297.0, null, NOW); // objetivo tocado, cadena sin cotización
    expect(t.status).toBe("ganada");
    expect(t.closeReason).toBe("objetivo");
    expect(t.exitPrice).toBeNull();       // antes: 0.91, la prima de entrada
    expect(isPriced(t)).toBe(false);
  });

  it("ese acierto SÍ cuenta en el win rate aunque no haya P&L", () => {
    const t = evaluate(active, 297.0, null, NOW);
    const s = summarize([t]);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(0);
    expect(s.winRatePct).toBe(100);
    expect(s.unpriced).toBe(1);
    expect(s.priced).toBe(0);
    expect(s.closedPnl).toBe(0); // no se conoce, y no se inventa
  });

  it("un stop sin prima cuenta como fallo", () => {
    const t = evaluate(active, 295.0, null, NOW);
    expect(t.status).toBe("perdida");
    expect(t.exitPrice).toBeNull();
    expect(summarize([t]).losses).toBe(1);
  });

  it("con prima fresca todo sigue igual: precio real y P&L real", () => {
    const t = evaluate(active, 297.0, 1.6, NOW);
    expect(t.exitPrice).toBe(1.6);
    const s = summarize([t]);
    expect(s.priced).toBe(1);
    expect(s.unpriced).toBe(0);
    expect(s.closedPnl).toBeCloseTo((1.6 - 0.91) * 100 * 10, 6);
  });
});

describe("outcomeOf — el acierto lo decide el plan, no el signo del P&L", () => {
  it("objetivo alcanzado es acierto aunque la prima no se moviera", () => {
    const t = trade({ status: "ganada", closeReason: "objetivo", entryPrice: 2, exitPrice: 2 });
    expect(outcomeOf(t)).toBe("acierto");
    expect(summarize([t]).wins).toBe(1);
  });

  it("stop es fallo aunque la prima no se moviera", () => {
    const t = trade({ status: "perdida", closeReason: "stop", entryPrice: 2, exitPrice: 2 });
    expect(outcomeOf(t)).toBe("fallo");
  });

  it("el trailing siempre asegura ganancia, así que es acierto", () => {
    const t = trade({ status: "ganada", closeReason: "trailing", entryPrice: 1, exitPrice: 1.3 });
    expect(outcomeOf(t)).toBe("acierto");
  });

  it("lo que nunca entró no cuenta: ni acierto ni fallo", () => {
    const caducada = trade({ status: "expirada", closeReason: "caducada", entryPrice: null, exitPrice: null });
    expect(outcomeOf(caducada)).toBe("sin_decidir");
    const s = summarize([caducada]);
    expect(s.wins + s.losses).toBe(0);
    expect(s.unpriced).toBe(0); // no entró: no es un cierre sin precio, es un no-trade
  });

  it("una expirada estando dentro la decide el dinero, y solo si lo hay", () => {
    const conPrecio = trade({ status: "expirada", closeReason: "expirada", entryPrice: 2, exitPrice: 0.5 });
    expect(outcomeOf(conPrecio)).toBe("fallo");
    const sinPrecio = trade({ status: "expirada", closeReason: "expirada", entryPrice: 2, exitPrice: null });
    expect(outcomeOf(sinPrecio)).toBe("sin_decidir");
  });
});

describe("liquidación a valor intrínseco al vencimiento", () => {
  // NOW = 2026-08-03 ET, así que un contrato del 2026-08-01 ya venció.
  const vencido = { expiration: "2026-08-01", status: "activa" as const, entryPrice: 2.0, entryAt: NOW.toISOString(), peakPrice: 2.0, currentPrice: 2.0 };

  it("una call que muere DENTRO del dinero vale lo que cuesta ejercerla", () => {
    // call 295 con el subyacente cerrando en 298 → 3.00 por acción
    const t = evaluate(trade(vencido), 298, null, NOW, 298);
    expect(t.status).toBe("expirada");
    expect(t.exitPrice).toBe(3);
    expect(realizedPnl(t)).toBeCloseTo((3 - 2) * 100 * 10, 6);
  });

  it("una call que muere FUERA del dinero vale 0, y eso es una pérdida real", () => {
    const t = evaluate(trade(vencido), 290, null, NOW, 290);
    expect(t.exitPrice).toBe(0);
    expect(realizedPnl(t)).toBeCloseTo(-2 * 100 * 10, 6); // se pierde toda la prima
    expect(outcomeOf(t)).toBe("fallo"); // antes salía "sin_decidir" y no contaba
  });

  it("un put se liquida por el otro lado", () => {
    const put = trade({ ...vencido, optionType: "put", strike: 295 });
    expect(evaluate(put, 290, null, NOW, 290).exitPrice).toBe(5);
    expect(evaluate(put, 300, null, NOW, 300).exitPrice).toBe(0);
  });

  it("se liquida con el cierre del DÍA DEL VENCIMIENTO, no con el precio de hoy", () => {
    // Murió fuera del dinero (293), aunque hoy el subyacente esté en 305.
    const t = evaluate(trade(vencido), 305, null, NOW, 293);
    expect(t.exitPrice).toBe(0);
  });

  it("el intrínseco manda sobre una cotización rancia del contrato vencido", () => {
    const t = evaluate(trade(vencido), 298, 1.75, NOW, 298);
    expect(t.exitPrice).toBe(3); // no 1.75
  });

  it("sin precio de liquidación se cierra SIN precio, no se adivina", () => {
    const t = evaluate(trade(vencido), 298, null, NOW, null);
    expect(t.status).toBe("expirada");
    expect(t.exitPrice).toBeNull();
    expect(outcomeOf(t)).toBe("sin_decidir");
  });

  it("un PENDIENTE que vence sin entrar no se liquida: nunca pagó prima", () => {
    const t = evaluate(trade({ ...vencido, status: "pendiente", entryPrice: null, peakPrice: null }), 298, null, NOW, 298);
    expect(t.status).toBe("expirada");
    expect(t.entryPrice).toBeNull();
    expect(t.exitPrice).toBeNull();
    expect(outcomeOf(t)).toBe("sin_decidir");
  });

  it("después de vencer, el vencimiento manda sobre el objetivo", () => {
    // El subyacente está por encima del objetivo (297), pero el contrato murió el
    // 2026-08-01: no se puede cobrar un objetivo con un contrato que ya no existe.
    const t = evaluate(trade(vencido), 300, null, NOW, 293);
    expect(t.closeReason).toBe("expirada");
    expect(t.exitPrice).toBe(0);
  });

  it("el DÍA del vencimiento el objetivo sigue mandando", () => {
    // NOW es 2026-08-03 ET; un contrato que vence HOY todavía se puede cerrar al objetivo.
    const hoy = trade({ ...vencido, expiration: "2026-08-03" });
    const t = evaluate(hoy, 297.5, 3.4, NOW, 297.5);
    expect(t.status).toBe("ganada");
    expect(t.closeReason).toBe("objetivo");
    expect(t.exitPrice).toBe(3.4);
  });

  it("intrinsicValue nunca es negativo", () => {
    expect(intrinsicValue("call", 100, 90)).toBe(0);
    expect(intrinsicValue("put", 100, 110)).toBe(0);
    expect(intrinsicValue("call", 100, 110)).toBe(10);
    expect(intrinsicValue("put", 100, 90)).toBe(10);
  });
});

/**
 * Invariantes de las que depende la PASADA DE FECHAS de `/api/trades/refresh?modo=fechas`,
 * que corre sin datos de mercado (también en fin de semana) para que un plan muerto no
 * siga reservando su ticker hasta el lunes.
 */
describe("sin datos de mercado: qué puede y qué NO puede decidirse", () => {
  const viejo = { expiration: "2026-12-18", trigger: 296, stop: 200, status: "pendiente" as const };
  const DIA7 = new Date("2026-08-10T13:00:00.000Z");

  it("un pendiente que cumple 7 días se caduca igual, sin precios", () => {
    const t = evaluate(trade(viejo), null, null, DIA7);
    expect(t.status).toBe("expirada");
    expect(t.closeReason).toBe("caducada");
  });

  it("un pendiente que vence sin entrar también se cierra sin precios", () => {
    const t = evaluate(trade({ ...viejo, expiration: "2026-08-01" }), null, null, NOW);
    expect(t.closeReason).toBe("expirada");
    expect(t.entryPrice).toBeNull();
  });

  it("un pendiente joven se queda EXACTAMENTE igual (ni se le toca el estado)", () => {
    const t = trade({ ...viejo, status: "pendiente" });
    const out = evaluate(t, null, null, new Date("2026-08-09T12:00:00.000Z"));
    expect(out.status).toBe("pendiente");
  });

  it("sin precios NO puede activarse, aunque el gatillo estuviera cruzado", () => {
    // Por eso la pasada de fechas no se pierde ninguna entrada: no hay ninguna que dar.
    expect(evaluate(trade(viejo), null, null, NOW).status).toBe("pendiente");
  });

  it("una ACTIVA vencida se cerraría SIN precio — por eso la pasada de fechas no la toca", () => {
    const activa = trade({ status: "activa", expiration: "2026-08-01", entryPrice: 2, peakPrice: 2, currentPrice: 2 });
    const t = evaluate(activa, null, null, NOW);
    expect(t.status).toBe("expirada");
    expect(t.exitPrice).toBeNull(); // sin liquidar a intrínseco: le falta el cierre del día
  });
});

/**
 * Regresión del "64% junto a −$12.023" (2026-08-26).
 *
 * El win rate puntuaba TODO lo decidido y el P&L solo lo que tenía precio de
 * salida: dos poblaciones distintas enseñadas juntas, imposibles de reconciliar
 * de un vistazo. El criterio de acierto no cambia; lo que se añade es el mismo
 * porcentaje sobre las operaciones que SÍ suman al dinero.
 */
describe("win rate con dinero vs por plan", () => {
  const cerradaConPrecio = (over: Partial<PaperTrade> = {}) =>
    trade({
      status: "ganada", closeReason: "objetivo",
      entryPrice: 1, exitPrice: 2, contracts: 1, ...over,
    });
  const cerradaSinPrecio = (over: Partial<PaperTrade> = {}) =>
    trade({
      status: "ganada", closeReason: "objetivo",
      entryPrice: 1, exitPrice: null, contracts: 1, ...over,
    });

  it("las dos coinciden cuando TODAS tienen precio", () => {
    const s = summarize([
      cerradaConPrecio({ id: "a" }),
      cerradaConPrecio({ id: "b", status: "perdida", closeReason: "stop", exitPrice: 0.5 }),
    ]);
    expect(s.winRatePct).toBe(50);
    expect(s.winRatePricedPct).toBe(50);
    expect(s.unpriced).toBe(0);
  });

  it("un acierto SIN precio infla el 'por plan' y no toca el 'con dinero'", () => {
    const s = summarize([
      cerradaConPrecio({ id: "a", status: "perdida", closeReason: "stop", exitPrice: 0.5 }),
      cerradaSinPrecio({ id: "b" }), // acierto por plan, sin un dólar medido
    ]);
    expect(s.winRatePct).toBe(50);        // 1 de 2 decididas
    expect(s.winRatePricedPct).toBe(0);   // 0 de 1 con dinero
    expect(s.unpriced).toBe(1);
    expect(s.priced).toBe(1);
  });

  it("reproduce la forma del caso real: muchos aciertos sin precio", () => {
    const libro = [
      ...Array.from({ length: 11 }, (_, i) => cerradaSinPrecio({ id: `sp${i}` })),
      ...Array.from({ length: 10 }, (_, i) => cerradaConPrecio({ id: `p${i}` })),
      ...Array.from({ length: 11 }, (_, i) =>
        cerradaConPrecio({ id: `l${i}`, status: "perdida", closeReason: "stop", exitPrice: 0.5 })),
    ];
    const s = summarize(libro);
    expect(s.wins + s.losses).toBe(32);       // el "por plan" puntúa 32…
    expect(s.winsPriced + s.lossesPriced).toBe(21); // …y solo 21 tienen dinero
    expect(s.winRatePct).toBeGreaterThan(s.winRatePricedPct!);
  });

  it("sin ningún cierre con precio, el 'con dinero' es null en vez de un 0% falso", () => {
    const s = summarize([cerradaSinPrecio({ id: "a" })]);
    expect(s.winRatePricedPct).toBeNull();
    expect(s.winRatePct).toBe(100);
  });

  it("las caducadas no entran en ninguno de los dos", () => {
    const s = summarize([trade({ id: "c", status: "expirada", closeReason: "caducada", entryPrice: null, exitPrice: null })]);
    expect(s.winRatePct).toBeNull();
    expect(s.winRatePricedPct).toBeNull();
  });
});
