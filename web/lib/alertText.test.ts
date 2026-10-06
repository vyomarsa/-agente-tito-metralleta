import { describe, expect, it } from "vitest";
import {
  breakevenOf, esc, primaClosedText, primaExpirada, primaNotOpenedText, primaOpenedText,
  splitForTelegram, tosSymbol, tosSymbolFrom, zeroClosedText, zeroLimiteDiarioText, zeroOpenedText,
} from "./alertText";
import type { PrimaPosition } from "./primaPaper";
import type { ZeroDteTicket } from "./zerodteSignals";
import type { ZeroPaperPosition } from "./zerodtePaper";

/**
 * El aviso de "hoy NO se abrió nada" (2026-08-24). Se prueba porque el formato es
 * lo único que puede equivocarse en silencio: este mensaje se lee en el móvil y de
 * él depende distinguir "el agente decidió no operar" de "algo está roto".
 */
describe("primaNotOpenedText", () => {
  it("dice el motivo y deja claro que es simulación", () => {
    const t = primaNotOpenedText({ motivo: "No se abrió: el escaneo no encontró candidatos." });
    expect(t).toContain("hoy NO se abrió ninguna posición");
    expect(t).toContain("no encontró candidatos");
    expect(t).toContain("Paper");
  });

  it("lo accionable va con ⚠️ y lo normal no", () => {
    expect(primaNotOpenedText({ motivo: "x", accionable: true })).toContain("⚠️");
    expect(primaNotOpenedText({ motivo: "x" })).not.toContain("⚠️");
  });

  it("enseña el embudo cuando el escaneo llegó a correr", () => {
    const t = primaNotOpenedText({
      motivo: "No se abrió.", escaneados: 98, candidatos: 33,
      persistentes: 0, requeridas: 3, pasadas: 5,
    });
    expect(t).toContain("Escaneados 98 · candidatos 33");
    expect(t).toContain("hacen falta 3 de 5 pasadas");
  });

  it("NO enseña el embudo si no se escaneó: ceros que parecen un fallo de criterio", () => {
    const t = primaNotOpenedText({ motivo: "Fuera de la ventana.", escaneados: 0 });
    expect(t).not.toContain("Escaneados");
  });

  it("lista lo que no cupo, con el capital que haría falta", () => {
    const t = primaNotOpenedText({
      motivo: "No se abrió.",
      noCaben: [{ ticker: "AAPL", riesgo: 230, necesita: 7667 }],
    });
    expect(t).toContain("AAPL arriesga $230");
    expect(t).toContain("$7,667");
  });

  it("con muchos que no caben, recorta y dice cuántos faltan", () => {
    const muchos = ["A", "B", "C", "D", "E", "F"].map((ticker) => ({ ticker, riesgo: 230, necesita: 7667 }));
    const t = primaNotOpenedText({ motivo: "x", noCaben: muchos });
    expect(t).toContain("y 2 más");
    expect(t).not.toContain("F arriesga");
  });

  it("nombra los subyacentes que ya tienen posición", () => {
    // Es la explicación de por qué sus candidatos ni se consideran.
    expect(primaNotOpenedText({ motivo: "x", yaAbiertas: ["SPY", "QQQ"] })).toContain("SPY, QQQ");
  });

  it("escapa el HTML del motivo, que es texto libre", () => {
    expect(primaNotOpenedText({ motivo: "fallo <b>raro</b>" })).toContain("&lt;b&gt;raro&lt;/b&gt;");
  });

  it("esc no toca un ticker normal", () => {
    expect(esc("BRK.B")).toBe("BRK.B");
  });
});


// ---------------------------------------------------------------------------
// 0DTE — la alerta que el dueño teclea a mano en thinkorswim (2026-08-27)
// ---------------------------------------------------------------------------

function pos(over: Partial<ZeroPaperPosition> = {}): ZeroPaperPosition {
  return {
    id: "Z-1756330000000",
    openedAt: "2026-08-28T15:10:00.000Z",
    ticker: "SPY",
    expiration: "2026-08-28",
    optionSymbol: "SPY260828C00770000",
    type: "call",
    strike: 770,
    contracts: 2,
    entryPrice: 0.47,
    currentPrice: 0.47,
    peakPrice: 0.47,
    model: "magnet",
    modelVersion: 2,
    side: "LONG",
    entrySpot: 770.05,
    target: 771,
    stop: 768.51,
    status: "abierta",
    closedAt: null,
    closeReason: null,
    realizedPnl: null,
    ...over,
  };
}

function ticket(over: Partial<ZeroDteTicket> = {}): ZeroDteTicket {
  return {
    optionSymbol: "SPY260828C00770000",
    type: "call",
    strike: 770,
    delta: 0.52,
    bid: 0.45,
    ask: 0.49,
    mid: 0.47,
    spreadPct: 8.5,
    volume: 768914,
    openInterest: 7702,
    cost: 47,
    targetPrice: 0.97,
    targetGain: 50,
    stopLoss: -29,
    liquidity: "justa",
    rationale: "",
    ...over,
  };
}

describe("tosSymbol", () => {
  it("arma el símbolo que TOS entiende, sin ceros de relleno", () => {
    expect(tosSymbol("SPY260828C00770000")).toBe(".SPY260828C770");
    expect(tosSymbol("QQQ260828P00705000")).toBe(".QQQ260828P705");
  });

  it("conserva la raíz SPXW del 0DTE de SPX", () => {
    // Teclear ".SPX..." en TOS lleva al MENSUAL: otro contrato y otra liquidación.
    expect(tosSymbol("SPXW260828C07655000")).toBe(".SPXW260828C7655");
  });

  it("mantiene el medio punto de un strike fraccionario", () => {
    expect(tosSymbol("IWM260828C00298500")).toBe(".IWM260828C298.5");
  });

  it("devuelve null si el símbolo no es OCC", () => {
    expect(tosSymbol("SPY")).toBeNull();
    expect(tosSymbol("")).toBeNull();
  });
});

describe("zeroOpenedText", () => {
  it("se distingue de las demás alertas de un vistazo", () => {
    const t = zeroOpenedText(pos(), 10000, ticket());
    expect(t).toContain("🚨");
    expect(t).toContain("COPIAR EN TOS");
    expect(t).not.toContain("✂️"); // ese icono es de venta de prima
  });

  it("trae la orden completa: acción, cantidad, símbolo, límite y débito", () => {
    const t = zeroOpenedText(pos(), 10000, ticket());
    expect(t).toContain("COMPRAR PARA ABRIR");
    expect(t).toContain("<b>2</b> contratos");
    expect(t).toContain(".SPY260828C770");
    expect(t).toContain("LÍMITE <b>0.47</b>");
    expect(t).toContain("bid 0.45 / ask 0.49");
    expect(t).toContain("$94"); // 0,47 × 100 × 2
    expect(t).toContain("vence 2026-08-28");
  });

  it("avisa de que objetivo y stop son del SUBYACENTE, no de la opción", () => {
    // En TOS la tentación es colgar el stop del precio de la opción; estos
    // niveles son del subyacente y confundirlos cierra la posición donde no toca.
    const t = zeroOpenedText(pos(), 10000, ticket());
    expect(t).toContain("los niveles son del SUBYACENTE (SPY), no de la opción");
    expect(t).toContain("Objetivo SPY <b>771.00</b>");
    expect(t).toContain("Stop SPY <b>768.51</b>");
  });

  it("proyecta el valor del contrato en el objetivo, ya multiplicado por contratos", () => {
    const t = zeroOpenedText(pos(), 10000, ticket());
    expect(t).toContain("contrato ≈ 0.97 (+$100)"); // 50 × 2
    expect(t).toContain("(−$58)");                  // −29 × 2
  });

  it("sin ticket sigue sirviendo: pierde contexto, conserva la orden", () => {
    // Un aviso incompleto es mucho mejor que ninguno.
    const t = zeroOpenedText(pos(), 10000, null);
    expect(t).toContain("COPIAR EN TOS");
    expect(t).toContain("LÍMITE <b>0.47</b>");
    expect(t).toContain(".SPY260828C770");
    expect(t).not.toContain("bid");
    expect(t).not.toContain("CONTRATO");
  });

  it("un solo contrato va en singular", () => {
    const t = zeroOpenedText(pos({ contracts: 1 }), 10000, ticket());
    expect(t).toContain("<b>1</b> contrato\n");
    expect(t).not.toContain("contratos");
  });

  it("lleva la referencia para poder emparejarlo con la orden de TOS", () => {
    const t = zeroOpenedText(pos(), 10000, ticket());
    expect(t).toContain("Z-1756330000000");
  });

  it("deja claro que es simulación", () => {
    expect(zeroOpenedText(pos(), 10000, ticket())).toContain("Paper");
  });
});

describe("zeroClosedText", () => {
  const ganada = pos({
    status: "ganada", closeReason: "objetivo", currentPrice: 0.97, realizedPnl: 100,
  });

  it("repite la referencia de la apertura, que es lo que permite comparar", () => {
    const t = zeroClosedText(ganada, 10100);
    expect(t).toContain("Z-1756330000000");
    expect(t).toContain("llegó al objetivo");
    expect(t).toContain("+$100");
  });

  it("por objetivo trae la orden INVERSA completa", () => {
    const t = zeroClosedText(ganada, 10100);
    expect(t).toContain("CERRAR EN TOS");
    expect(t).toContain("VENDER PARA CERRAR · <b>2</b> contratos");
    expect(t).toContain(".SPY260828C770");
    expect(t).toContain("LÍMITE <b>0.97</b>");
    expect(t).toContain("cobras ≈ <b>$194</b>");
    expect(t).toContain("Entraste por $94");
  });

  it("enseña el retorno sobre la prima, no solo los dólares", () => {
    expect(zeroClosedText(ganada, 10100)).toContain("(+106%)");
  });

  it("por stop también es accionable, pero con el icono de pérdida", () => {
    const t = zeroClosedText(
      pos({ status: "perdida", closeReason: "stop", currentPrice: 0.18, realizedPnl: -58 }),
      9942,
    );
    expect(t).toContain("CERRAR EN TOS");
    expect(t).toContain("🔴");
    expect(t).toContain("saltó el stop");
    expect(t).toContain("LÍMITE <b>0.18</b>");
    expect(t).toContain("(−62%)");
  });

  it("al cierre de sesión NO finge una orden: el contrato ya venció", () => {
    // El aviso salta en el tick de las 16:00. Mandar al dueño a vender a esa hora
    // sería mandarlo a un mercado cerrado.
    const t = zeroClosedText(
      pos({ status: "expirada", closeReason: "cierre_de_sesion", currentPrice: 0, realizedPnl: -94 }),
      9906,
    );
    expect(t).toContain("⏳");
    expect(t).not.toContain("CERRAR EN TOS");
    expect(t).not.toContain("VENDER PARA CERRAR");
    expect(t).toContain("no hay nada que teclear");
    expect(t).toContain("liquidó al cierre de sesión");
    expect(t).toContain("(−100%)");
  });

  it("un solo contrato va en singular", () => {
    const t = zeroClosedText(pos({ contracts: 1, closeReason: "objetivo", currentPrice: 0.97, realizedPnl: 50 }), 10050);
    expect(t).toContain("<b>1</b> contrato\n");
  });
});


// ---------------------------------------------------------------------------
// Venta de prima — la orden copiable en thinkorswim (2026-08-27)
// ---------------------------------------------------------------------------

function vp(over: Partial<PrimaPosition> = {}): PrimaPosition {
  return {
    id: "VP-1756330000000-0",
    openedAt: "2026-08-31T15:45:00.000Z",
    ticker: "AAPL",
    sector: "Tecnología",
    type: "put_credit",
    shortStrike: 310,
    longStrike: 305,
    width: 5,
    expiration: "2026-09-04",
    contracts: 1,
    entryCredit: 0.62,
    currentValue: 0.62,
    peakProfitPct: 0,
    shortDelta: 0.12,
    popPct: 88,
    expert: true,
    riskPctUsed: 0.023,
    seenInPasses: 4,
    status: "abierta",
    closedAt: null,
    closeReason: null,
    realizedPnl: null,
    ...over,
  };
}

describe("tosSymbolFrom", () => {
  it("arma el símbolo desde las partes sueltas", () => {
    expect(tosSymbolFrom("AAPL", "2026-09-04", "put", 310)).toBe(".AAPL260904P310");
    expect(tosSymbolFrom("MSFT", "2026-09-04", "call", 512.5)).toBe(".MSFT260904C512.5");
  });

  it("es la misma construcción que usa tosSymbol", () => {
    expect(tosSymbol("SPY260828C00770000")).toBe(tosSymbolFrom("SPY", "2026-08-28", "call", 770));
  });

  it("devuelve null con partes inservibles", () => {
    expect(tosSymbolFrom("", "2026-09-04", "put", 310)).toBeNull();
    expect(tosSymbolFrom("AAPL", "04/09/2026", "put", 310)).toBeNull();
    expect(tosSymbolFrom("AAPL", "2026-09-04", "put", 0)).toBeNull();
  });
});

describe("breakevenOf", () => {
  it("un put spread pierde por DEBAJO del corto menos el crédito", () => {
    expect(breakevenOf({ type: "put_credit", shortStrike: 310, entryCredit: 0.62 })).toBeCloseTo(309.38, 6);
  });

  it("un call spread pierde por ENCIMA del corto más el crédito", () => {
    expect(breakevenOf({ type: "call_credit", shortStrike: 310, entryCredit: 0.62 })).toBeCloseTo(310.62, 6);
  });
});

describe("splitForTelegram", () => {
  it("un mensaje que cabe no se toca", () => {
    expect(splitForTelegram("hola\nqué tal")).toEqual(["hola\nqué tal"]);
  });

  it("corta entre líneas enteras, sin partir etiquetas", () => {
    const texto = ["<b>uno</b>", "<b>dos</b>", "<b>tres</b>"].join("\n");
    const trozos = splitForTelegram(texto, 12);
    expect(trozos.length).toBeGreaterThan(1);
    for (const t of trozos) {
      // Cada trozo tiene tantas aperturas como cierres: ninguna quedó a medias.
      expect((t.match(/<b>/g) ?? []).length).toBe((t.match(/<\/b>/g) ?? []).length);
    }
    expect(trozos.join("\n")).toBe(texto);
  });

  it("ningún trozo pasa del tope", () => {
    const texto = Array.from({ length: 400 }, (_, i) => `linea ${i}`).join("\n");
    for (const t of splitForTelegram(texto, 200)) expect(t.length).toBeLessThanOrEqual(200);
  });

  it("una línea suelta más larga que el tope se parte, en vez de perderse", () => {
    // Mutilarla es mejor que quedarse sin mensaje.
    const trozos = splitForTelegram("x".repeat(500), 200);
    expect(trozos).toHaveLength(3);
    expect(trozos.join("")).toBe("x".repeat(500));
  });
});

describe("primaOpenedText", () => {
  it("se distingue de un vistazo y dice cuántas órdenes son", () => {
    const t = primaOpenedText([vp(), vp({ id: "VP-2", ticker: "MSFT" })], 10000);
    expect(t).toContain("🚨");
    expect(t).toContain("COPIAR EN TOS");
    expect(t).toContain("2 órdenes"); // el plural lleva tilde
  });

  it("una sola orden va en singular", () => {
    expect(primaOpenedText([vp()], 10000)).toContain("· 1 orden\n");
  });

  it("trae las DOS patas, cuál se vende y cuál se compra", () => {
    const t = primaOpenedText([vp()], 10000);
    expect(t).toContain("VENDER PARA ABRIR · VERTICAL PUT");
    expect(t).toContain("VENDE  <code>.AAPL260904P310</code>");
    expect(t).toContain("COMPRA <code>.AAPL260904P305</code>");
  });

  it("el límite es el crédito NETO, que es como se manda una vertical", () => {
    const t = primaOpenedText([vp()], 10000);
    expect(t).toContain("LÍMITE crédito NETO <b>0.62</b>");
    expect(t).toContain("ancho 5.00");
    expect(t).toContain("Cobras ≈ <b>$62</b>");
    expect(t).toContain("riesgo máx $438"); // (5 − 0,62) × 100
  });

  it("enseña el punto muerto, el delta corto y el POP", () => {
    const t = primaOpenedText([vp()], 10000);
    expect(t).toContain("Punto muerto 309.38");
    expect(t).toContain("Δ corto 0.12");
    expect(t).toContain("POP 88%");
  });

  it("las reglas de gestión son las del SIMULADOR, no las del documento", () => {
    // Si el dueño cerrara al 50% mientras el simulador aguanta a vencimiento, la
    // comparación mediría dos estrategias distintas en vez de dos ejecuciones.
    const t = primaOpenedText([vp()], 10000);
    expect(t).toContain("Se aguanta a VENCIMIENTO. NO se cierra al 50%.");
    expect(t).toContain("30% del crédito, de miércoles en adelante");
    expect(t).toContain("Δ corto ≥ 0.40");
  });

  it("un call spread se rotula como VERTICAL CALL", () => {
    const t = primaOpenedText([vp({ type: "call_credit", shortStrike: 310, longStrike: 315 })], 10000);
    expect(t).toContain("VERTICAL CALL");
    expect(t).toContain(".AAPL260904C310");
    expect(t).toContain(".AAPL260904C315");
  });

  it("lleva la referencia de cada posición para emparejar con TOS", () => {
    expect(primaOpenedText([vp()], 10000)).toContain("VP-1756330000000-0");
  });

  it("sin posiciones no manda nada", () => {
    expect(primaOpenedText([], 10000)).toBe("");
  });

  it("una tanda de 5 órdenes cabe en un solo mensaje de Telegram", () => {
    // Es el tope real del ejecutor (MAX_NEW_PER_SESSION = 5). Si se pasara, el
    // troceo lo salva, pero es mejor saberlo aquí que descubrirlo en el móvil.
    const cinco = Array.from({ length: 5 }, (_, i) => vp({ id: `VP-${i}`, ticker: `TICK${i}` }));
    const t = primaOpenedText(cinco, 10000);
    expect(splitForTelegram(t)).toHaveLength(1);
  });
});

describe("primaExpirada", () => {
  it("es vencimiento solo si el cierre cae DESPUÉS del día de vencimiento", () => {
    // El suelo de ganancia también dispara el DÍA del vencimiento; lo que separa
    // los dos casos es el calendario, no el texto del motivo.
    expect(primaExpirada({ expiration: "2026-09-04", closedAt: "2026-09-07T14:00:00.000Z" })).toBe(true);
    expect(primaExpirada({ expiration: "2026-09-04", closedAt: "2026-09-04T18:00:00.000Z" })).toBe(false);
  });

  it("usa la fecha de mercado de NUEVA YORK, no la UTC", () => {
    // 2026-09-04T23:30Z son todavía las 19:30 del día 4 en Nueva York: no venció.
    expect(primaExpirada({ expiration: "2026-09-04", closedAt: "2026-09-04T23:30:00.000Z" })).toBe(false);
  });

  it("sin fecha de cierre o con una inservible, no afirma que venció", () => {
    expect(primaExpirada({ expiration: "2026-09-04", closedAt: null })).toBe(false);
    expect(primaExpirada({ expiration: "2026-09-04", closedAt: "no-es-fecha" })).toBe(false);
  });
});

describe("primaClosedText", () => {
  const porValvula = vp({
    status: "perdida",
    closedAt: "2026-09-02T19:00:00.000Z",
    closeReason: "Pérdida 31% del crédito (≥ 30%) en la revisión de miércoles.",
    currentValue: 0.81,
    realizedPnl: -19,
  });

  it("repite la referencia de la apertura", () => {
    expect(primaClosedText(porValvula, 9981)).toContain("VP-1756330000000-0");
  });

  it("cerrar un credit spread es COMPRAR la vertical de vuelta", () => {
    const t = primaClosedText(porValvula, 9981);
    expect(t).toContain("CERRAR EN TOS");
    expect(t).toContain("COMPRAR PARA CERRAR · VERTICAL PUT");
    expect(t).toContain("LÍMITE débito NETO <b>0.81</b>");
    expect(t).toContain("pagas ≈ <b>$81</b>");
  });

  it("rotula cada pata con lo que se hace AHORA y lo que se hizo al abrir", () => {
    // Mandarla del revés duplica la posición en vez de cerrarla.
    const t = primaClosedText(porValvula, 9981);
    expect(t).toContain("COMPRA <code>.AAPL260904P310</code>  (la que vendiste)");
    expect(t).toContain("VENDE  <code>.AAPL260904P305</code>  (la que compraste)");
  });

  it("el % es del CRÉDITO, la misma vara con la que decide la válvula", () => {
    expect(primaClosedText(porValvula, 9981)).toContain("perdido 31% del crédito");
  });

  it("al vencer NO finge una orden", () => {
    const vencida = vp({
      status: "ganada",
      closedAt: "2026-09-07T14:00:00.000Z",
      closeReason: "Venció el 2026-09-04: se liquida al valor final.",
      currentValue: 0,
      realizedPnl: 62,
    });
    const t = primaClosedText(vencida, 10062);
    expect(t).not.toContain("CERRAR EN TOS");
    expect(t).not.toContain("COMPRAR PARA CERRAR");
    expect(t).toContain("no hay nada que teclear");
    expect(t).toContain("Venció el 2026-09-04");
    expect(t).toContain("capturado 100% del crédito");
    expect(t).toContain("+$62");
  });
});

describe("zeroLimiteDiarioText", () => {
  it("dice que no se abre más hoy, con el P&L neto del día y sin orden que teclear", () => {
    const t = zeroLimiteDiarioText(1, -71.3, 8200);
    expect(t).toContain("límite diario alcanzado");
    expect(t).toContain("1 operación en pérdida hoy");
    expect(t).toContain("<b>−$71.3</b>");
    expect(t).toContain("no abre nada más hasta la próxima sesión");
    expect(t).toContain("tampoco abras más hoy");
    expect(t).not.toContain("🚨");
  });

  it("pluraliza", () => {
    expect(zeroLimiteDiarioText(2, -150, 8200)).toContain("2 operaciones en pérdida");
  });
});
