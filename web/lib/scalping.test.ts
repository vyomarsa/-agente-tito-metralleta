import { describe, expect, it } from "vitest";
import {
  NET_GEX_VERDE, SESIONES_FASE_1,
  calificar, earningsDeFecha, fueraDeVentana, faseDelDia, niveles, regimen, resumen, semaforo,
  tierDe, velasDeSesion,
  type Niveles, type Observacion,
} from "./scalping";
import type { Chain2Contract } from "./optionChain2";
import type { TfBar } from "./types";

const AHORA = new Date("2026-09-03T21:00:00Z");

function contrato(
  strike: number,
  type: "call" | "put",
  openInterest: number,
  gamma: number | null = 0.02,
): Chain2Contract {
  return {
    symbol: `O:${type}${strike}`, type, strike, expiration: "2026-09-04",
    bid: 1, ask: 1.1, mid: 1.05, delta: null, gamma, theta: null, vega: null, iv: 0.2,
    openInterest, volume: 0, premiumTraded: 0, lastPrice: 1,
  };
}

function vela(open: number, high: number, low: number, close: number, time = 0): TfBar {
  return { time, open, high, low, close };
}

/** Cadena de MSFT del caso de estudio: put wall 500, call wall 512.5, imán 510. */
function cadenaMsft(): Chain2Contract[] {
  return [
    contrato(500, "put", 9_000, 0.03),
    contrato(505, "put", 2_000, 0.01),
    contrato(510, "put", 1_000, 0.05),
    contrato(510, "call", 3_000, 0.05),
    contrato(512.5, "call", 8_000, 0.02),
    contrato(515, "call", 1_500, 0.01),
  ];
}

describe("tierDe", () => {
  it("clasifica según la tabla del manual", () => {
    expect(tierDe("spy")).toBe("optimo");
    expect(tierDe("MSFT")).toBe("funciona");
    expect(tierDe("INTC")).toBe("depende");
    expect(tierDe("KO")).toBe("prohibido");
  });

  it("trata al desconocido como 'depende', no como prohibido", () => {
    expect(tierDe("ZZZZ")).toBe("depende");
  });
});

describe("niveles", () => {
  it("saca piso, techo e imán de la cadena", () => {
    const n = niveles(cadenaMsft(), 507);
    expect(n.piso).toBe(500);
    expect(n.techo).toBe(512.5);
    expect(n.centro).toBe(510);
    expect(n.anchoPct).toBeCloseTo(((512.5 - 500) / 507) * 100, 4);
  });

  it("NO toma como techo un strike de calls por debajo del precio", () => {
    // El OI gordo de calls (8.000) queda ABAJO: no es techo, es lo ya roto.
    const chain = [contrato(500, "call", 8_000), contrato(515, "call", 900), contrato(495, "put", 4_000)];
    const n = niveles(chain, 510);
    expect(n.techo).toBe(515);
  });

  it("el imán NO se pega al piso aunque ahí esté el mayor |gamma|", () => {
    // El put wall de 500 tiene la mayor gamma neta de toda la ventana; si el imán
    // se buscara sin acotar, el centro y el piso serían el mismo número.
    const n = niveles(cadenaMsft(), 507);
    expect(n.centro).toBe(510);
    expect(n.centro!).toBeGreaterThan(n.piso!);
    expect(n.centro!).toBeLessThan(n.techo!);
  });

  it("sin las dos paredes no hay centro que situar", () => {
    const chain = [contrato(500, "put", 9_000, 0.03), contrato(505, "put", 2_000, 0.01)];
    const n = niveles(chain, 507);
    expect(n.techo).toBeNull();
    expect(n.centro).toBeNull();
  });

  it("ignora strikes fuera de la ventana del ±5%", () => {
    const chain = [...cadenaMsft(), contrato(600, "call", 99_000, 0.9)];
    expect(niveles(chain, 507).techo).toBe(512.5);
  });

  it("devuelve nulos con spot inválido o cadena vacía", () => {
    expect(niveles(cadenaMsft(), 0).piso).toBeNull();
    expect(niveles([], 507).techo).toBeNull();
  });
});

describe("regimen", () => {
  it("suma el GEX y sitúa el flip por debajo del precio", () => {
    // Puts abajo (acumulada negativa) y un muro de calls que la devuelve a positivo
    // EN 500, bastante por debajo del precio: eso es un régimen γ+ limpio.
    const chain = [
      contrato(490, "put", 10_000, 0.05),
      contrato(495, "put", 8_000, 0.04),
      contrato(500, "call", 25_000, 0.05),
      contrato(510, "call", 12_000, 0.05),
    ];
    const r = regimen(chain, 508);
    expect(r.netGex).toBeGreaterThan(0);
    expect(r.flipStrike!).toBeGreaterThan(495);
    expect(r.flipStrike!).toBeLessThan(500);
    expect(r.flipDistPct!).toBeGreaterThan(0);
  });

  it("el flip sale de la gamma ACUMULADA, no de un strike suelto a contracorriente", () => {
    // 500 es put-pesado y 505 call-pesado, así que un cruce POR STRIKE caería
    // entre ambos (~502,5) aunque la gamma acumulada siga muy negativa ahí: los
    // puts de abajo pesan mucho más y no se compensan hasta bien arriba.
    const chain = [
      contrato(480, "put", 40_000, 0.05),
      contrato(500, "put", 30_000, 0.05),
      contrato(505, "call", 1_000, 0.05),
      contrato(520, "call", 90_000, 0.05),
    ];
    const r = regimen(chain, 510);
    expect(r.flipStrike!).toBeGreaterThan(505);
    expect(r.flipStrike!).toBeLessThanOrEqual(520);
  });

  it("sin cruce de la acumulada no hay flip que situar", () => {
    // Solo calls: la acumulada nace positiva y nunca vuelve a cero.
    const chain = [contrato(500, "call", 9_000, 0.05), contrato(510, "call", 8_000, 0.04)];
    expect(regimen(chain, 505).flipStrike).toBeNull();
  });

  it("sin gamma real no hay régimen que medir", () => {
    const chain = [contrato(500, "put", 9_000, null), contrato(510, "call", 9_000, null)];
    const r = regimen(chain, 505);
    expect(r.netGex).toBe(0);
    expect(r.flipStrike).toBeNull();
  });
});

describe("semaforo", () => {
  const base = {
    ticker: "MSFT",
    netGex: NET_GEX_VERDE * 2,
    flipDistPct: 2.5,
    niveles: { piso: 500, pisoOi: 9_000, techo: 512.5, techoOi: 8_000, centro: 510, anchoPct: 2.4 } as Niveles,
    earnings: "fuera" as const,
    gammaFrentePct: 77,
    frenteDte: 1,
  };

  it("da verde cuando todas las condiciones del manual se cumplen", () => {
    expect(semaforo(base).luz).toBe("verde");
  });

  it("el Net GEX negativo es bloqueo, no ámbar", () => {
    const s = semaforo({ ...base, netGex: -50_000_000 });
    expect(s.luz).toBe("rojo");
    expect(s.bloqueos[0]).toMatch(/NEGATIVO/);
  });

  it("earnings dentro del vencimiento bloquea sin excepción", () => {
    expect(semaforo({ ...base, earnings: "dentro" }).luz).toBe("rojo");
  });

  it("un ticker de la lista prohibida bloquea", () => {
    expect(semaforo({ ...base, ticker: "KO" }).luz).toBe("rojo");
  });

  it("sin una de las dos paredes no hay rango", () => {
    const s = semaforo({ ...base, niveles: { ...base.niveles, techo: null } });
    expect(s.luz).toBe("rojo");
  });

  it("el flip por encima del precio es ÁMBAR, no rojo", () => {
    // El manual solo pinta de rojo el Net GEX negativo. Bloquear aquí era ser más
    // severo que la fuente, y dejaba a 8 de 10 tickers sin poder salir verde nunca.
    const s = semaforo({ ...base, flipDistPct: -0.5 });
    expect(s.luz).toBe("ambar");
    expect(s.bloqueos).toHaveLength(0);
    expect(s.motivos.join(" ")).toMatch(/POR ENCIMA del precio/);
  });

  it("Net GEX por debajo del umbral baja a ámbar, no a rojo", () => {
    const s = semaforo({ ...base, netGex: 60_000_000 });
    expect(s.luz).toBe("ambar");
    expect(s.bloqueos).toHaveLength(0);
  });

  it("el precio pegado al flip baja a ámbar", () => {
    expect(semaforo({ ...base, flipDistPct: 0.3 }).luz).toBe("ambar");
  });

  it("la gamma del frente se lee igual con vencimiento semanal que diario", () => {
    // El caso que motivó el cambio: con la versión literal "0–1 DTE", una acción
    // un lunes daba SIEMPRE 0% —su frente es el viernes— y arrastraba un ámbar
    // permanente. Medido sobre el vencimiento del frente, un 77% es un 77% tenga
    // ese vencimiento 0 días o 4.
    expect(semaforo({ ...base, frenteDte: 4 }).luz).toBe("verde");
    expect(semaforo({ ...base, frenteDte: 0 }).luz).toBe("verde");
  });

  it("la concentración de gamma se APUNTA pero no decide la luz", () => {
    // Sin umbral calibrado, una puerta aquí solo añadiría el mismo ámbar a todos:
    // medido el 2026-09-07, los diez tickers daban entre 4% y 30%.
    const bajo = semaforo({ ...base, gammaFrentePct: 4, frenteDte: 2 });
    expect(bajo.luz).toBe("verde");
    expect(bajo.motivos.join(" ")).toMatch(/4% de la gamma en el vencimiento del frente \(vence en 2 días\)/);
  });

  it("sin medida de concentración tampoco se baja la luz, pero se dice", () => {
    const s = semaforo({ ...base, gammaFrentePct: null, frenteDte: null });
    expect(s.luz).toBe("verde");
    expect(s.motivos.join(" ")).toMatch(/Sin medida de la concentración/);
  });

  it("un ticker 'depende del día' nunca llega a verde solo", () => {
    expect(semaforo({ ...base, ticker: "INTC" }).luz).toBe("ambar");
  });

  it("sin dato de earnings en una ACCIÓN avisa y no da verde", () => {
    const s = semaforo({ ...base, earnings: "no_aplica" });
    expect(s.luz).toBe("ambar");
    expect(s.motivos.join(" ")).toMatch(/Verifícalo tú/);
  });

  it("en un ETF de índice, 'no_aplica' es la verdad y no baja la luz", () => {
    // SPY no reporta resultados: penalizarlo dejaría fuera de verde justo a los
    // dos tickers que el manual llama óptimos.
    const s = semaforo({ ...base, ticker: "SPY", earnings: "no_aplica" });
    expect(s.luz).toBe("verde");
    expect(s.motivos.join(" ")).not.toMatch(/Verifícalo tú/);
  });
});

describe("earningsDeFecha", () => {
  const HOY = "2026-09-07";
  const VENCE = "2026-09-11";

  it("una fecha PASADA es 'fuera': ya reportó", () => {
    // El caso real que lo destapó: Tastytrade devolvía el ÚLTIMO reporte y el
    // ticker salía en rojo por unos earnings de julio.
    expect(earningsDeFecha("2026-07-29", VENCE, HOY)).toBe("fuera");
    expect(earningsDeFecha("2026-08-26", VENCE, HOY)).toBe("fuera");
  });

  it("una fecha futura DENTRO del vencimiento sigue bloqueando", () => {
    expect(earningsDeFecha("2026-09-09", VENCE, HOY)).toBe("dentro");
  });

  it("una fecha futura MÁS ALLÁ del vencimiento es 'fuera'", () => {
    expect(earningsDeFecha("2026-10-29", VENCE, HOY)).toBe("fuera");
  });

  it("el mismo día del vencimiento cuenta como dentro", () => {
    expect(earningsDeFecha(VENCE, VENCE, HOY)).toBe("dentro");
  });

  it("sin fecha, no se sabe: 'no_aplica'", () => {
    expect(earningsDeFecha(null, VENCE, HOY)).toBe("no_aplica");
  });

  it("una acción con earnings ya reportados NO se pinta de rojo", () => {
    const s = semaforo({
      ticker: "MSFT", netGex: NET_GEX_VERDE * 2, flipDistPct: 2.5,
      niveles: { piso: 500, pisoOi: 9_000, techo: 512.5, techoOi: 8_000, centro: 510, anchoPct: 2.4 },
      earnings: earningsDeFecha("2026-07-29", VENCE, HOY),
      gammaFrentePct: 77, frenteDte: 1,
    });
    expect(s.luz).not.toBe("rojo");
    expect(s.bloqueos).toHaveLength(0);
  });
});

describe("calificar", () => {
  const obs = (n: Partial<Niveles> = {}): Observacion => ({
    ticker: "MSFT", fecha: "2026-09-03", anotadaEn: "2026-09-03T13:20:00Z",
    expiracion: "2026-09-04", spotApertura: 507, netGex: 2e8, flipStrike: 495,
    flipDistPct: 2.4, gammaFrentePct: 77, frenteDte: 1, earnings: "fuera", tier: "funciona",
    niveles: { piso: 500, pisoOi: 9_000, techo: 512.5, techoOi: 8_000, centro: 510, anchoPct: 2.4, ...n },
    luz: "verde", motivos: [], fueraVentana: false, ayer: null, cierre: null,
  });

  it("tocar y aguantar el piso es respeto", () => {
    const bars = [vela(507, 508, 500.2, 503), vela(503, 511, 502, 510)];
    const c = calificar(obs(), bars, AHORA)!;
    expect(c.piso!.toco).toBe(true);
    expect(c.piso!.rompio).toBe(false);
    expect(c.piso!.respeto).toBe(true);
    expect(c.veredicto).toBe("respeto");
  });

  it("una MECHA por debajo del piso no es rotura si la vela cierra dentro", () => {
    const bars = [vela(505, 506, 496, 502)];
    const c = calificar(obs(), bars, AHORA)!;
    expect(c.piso!.rompio).toBe(false);
    expect(c.piso!.excursionPct).toBeGreaterThan(0);
  });

  it("un CIERRE por debajo del piso sí es rotura", () => {
    const bars = [vela(505, 506, 496, 497)];
    const c = calificar(obs(), bars, AHORA)!;
    expect(c.piso!.rompio).toBe(true);
    expect(c.piso!.respeto).toBe(false);
    expect(c.veredicto).toBe("rompio");
  });

  it("un día que nunca llega a los niveles es 'no_llego', NO un acierto", () => {
    const bars = [vela(506, 507, 505, 506), vela(506, 508, 505, 507)];
    const c = calificar(obs(), bars, AHORA)!;
    expect(c.piso!.respeto).toBeNull();
    expect(c.techo!.respeto).toBeNull();
    expect(c.veredicto).toBe("no_llego");
  });

  it("si rompe un lado el día es rotura aunque el otro aguante", () => {
    const bars = [vela(507, 500.1, 500.1, 507), vela(507, 514, 507, 514)];
    const c = calificar(obs(), bars, AHORA)!;
    expect(c.techo!.rompio).toBe(true);
    expect(c.veredicto).toBe("rompio");
  });

  it("mide contención, imán y uso del rango", () => {
    const bars = [vela(507, 508, 506, 510), vela(510, 511, 509, 510), vela(510, 511, 505, 506)];
    const c = calificar(obs(), bars, AHORA)!;
    expect(c.contenidoPct).toBe(100);
    expect(c.imanPct).toBeCloseTo((2 / 3) * 100, 4);
    expect(c.rangoUsadoPct).toBeCloseTo(((511 - 505) / 12.5) * 100, 4);
    expect(c.velas).toBe(3);
  });

  it("sin velas no se califica", () => {
    expect(calificar(obs(), [], AHORA)).toBeNull();
  });

  it("un nivel ausente no se califica y no rompe el resto", () => {
    const c = calificar(obs({ techo: null }), [vela(505, 506, 499, 498)], AHORA)!;
    expect(c.techo).toBeNull();
    expect(c.piso!.rompio).toBe(true);
    expect(c.contenidoPct).toBeNull();
  });
});

describe("faseDelDia / fueraDeVentana", () => {
  it("nombra las cuatro fases por hora ET", () => {
    expect(faseDelDia(7 * 60)).toBe("temprano");
    expect(faseDelDia(8 * 60)).toBe("anotar");
    expect(faseDelDia(9 * 60 + 34)).toBe("anotar");
    expect(faseDelDia(9 * 60 + 35)).toBe("sesion");
    expect(faseDelDia(16 * 60)).toBe("calificar");
  });

  it("sin hora ET asume sesión: es el caso conservador", () => {
    expect(faseDelDia(null)).toBe("sesion");
    expect(fueraDeVentana(null)).toBe(false);
  });

  it("marca lo anotado fuera de la ventana, por los DOS bordes", () => {
    expect(fueraDeVentana(9 * 60)).toBe(false);
    // Demasiado pronto: el único spot disponible es el cierre de ayer.
    expect(fueraDeVentana(7 * 60 + 59)).toBe(true);
    expect(fueraDeVentana(4 * 60)).toBe(true);
    // Demasiado tarde: los niveles se elegirían viendo el precio.
    expect(fueraDeVentana(9 * 60 + 35)).toBe(true);
    expect(fueraDeVentana(14 * 60)).toBe(true);
  });
});

describe("velasDeSesion", () => {
  /** Epoch de una hora ET del 3-sep-2026 (verano: ET = UTC−4). */
  const et = (h: number, m: number) => Math.floor(Date.UTC(2026, 8, 3, h + 4, m) / 1000);

  it("se queda solo con 9:30–16:00 del día pedido", () => {
    const bars = [
      vela(1, 1, 1, 1, et(8, 0)),    // pre-mercado
      vela(2, 2, 2, 2, et(9, 30)),   // apertura, entra
      vela(3, 3, 3, 3, et(15, 55)),  // última, entra
      vela(4, 4, 4, 4, et(16, 0)),   // cierre exacto, fuera
      vela(5, 5, 5, 5, et(17, 0)),   // post-mercado
    ];
    expect(velasDeSesion(bars, "2026-09-03").map((b) => b.open)).toEqual([2, 3]);
  });

  it("descarta las velas de otros días", () => {
    const bars = [vela(1, 1, 1, 1, et(10, 0)), vela(2, 2, 2, 2, et(10, 0) + 86_400)];
    expect(velasDeSesion(bars, "2026-09-03")).toHaveLength(1);
  });

  it("devuelve las velas ordenadas por tiempo", () => {
    const bars = [vela(2, 2, 2, 2, et(11, 0)), vela(1, 1, 1, 1, et(10, 0))];
    expect(velasDeSesion(bars, "2026-09-03").map((b) => b.open)).toEqual([1, 2]);
  });
});

describe("resumen", () => {
  function dia(
    fecha: string,
    luz: "verde" | "ambar" | "rojo",
    veredicto: "respeto" | "rompio" | "no_llego" | null,
    ticker = "MSFT",
  ): Observacion {
    return {
      ticker, fecha, anotadaEn: `${fecha}T13:20:00Z`, expiracion: fecha,
      spotApertura: 507, netGex: 2e8, flipStrike: 495, flipDistPct: 2.4,
      gammaFrentePct: 77, frenteDte: 1, earnings: "fuera", tier: "funciona",
      niveles: { piso: 500, pisoOi: 1, techo: 512.5, techoOi: 1, centro: 510, anchoPct: 2.4 },
      luz, motivos: [], fueraVentana: false, ayer: null,
      cierre: veredicto == null ? null : {
        calificadaEn: `${fecha}T20:05:00Z`, velas: 78, apertura: 507, alto: 512, bajo: 501, cierre: 510,
        piso: null, techo: null, veredicto, contenidoPct: 90, imanPct: 30, rangoUsadoPct: 88,
      },
    };
  }

  it("los días 'no llegó' quedan fuera de la tasa de respeto", () => {
    const r = resumen([dia("2026-09-01", "verde", "respeto"), dia("2026-09-02", "verde", "no_llego")]);
    expect(r.total.tasaRespeto).toBe(100);
    expect(r.total.noLlego).toBe(1);
    expect(r.total.calificadas).toBe(2);
  });

  it("las sesiones sin calificar no cuentan como nada", () => {
    const r = resumen([dia("2026-09-01", "verde", null)]);
    expect(r.total.sesiones).toBe(1);
    expect(r.total.calificadas).toBe(0);
    expect(r.total.tasaRespeto).toBeNull();
  });

  it("parte las estadísticas por luz y por ticker", () => {
    const r = resumen([
      dia("2026-09-01", "verde", "respeto", "SPY"),
      dia("2026-09-02", "rojo", "rompio", "MSFT"),
    ]);
    expect(r.porLuz.verde.respeto).toBe(1);
    expect(r.porLuz.rojo.rompio).toBe(1);
    expect(r.porTicker.map((t) => t.ticker)).toEqual(["MSFT", "SPY"]);
  });

  it("cuenta sesiones distintas, no filas", () => {
    const r = resumen([
      dia("2026-09-01", "verde", "respeto", "SPY"),
      dia("2026-09-01", "verde", "respeto", "QQQ"),
    ]);
    expect(r.sesionesDistintas).toBe(1);
    expect(r.faseCompleta).toBe(false);
  });

  it("no concluye nada antes de las 10 sesiones", () => {
    const r = resumen([dia("2026-09-01", "verde", "respeto")]);
    expect(r.lectura).toMatch(/Aún es pronto/);
  });

  it("con la fase completa y buen contraste, recomienda pasar a la fase 2", () => {
    const obs: Observacion[] = [];
    for (let d = 1; d <= SESIONES_FASE_1; d++) {
      const fecha = `2026-09-${String(d).padStart(2, "0")}`;
      // 8 verdes que aguantan, 2 rojos que rompen.
      obs.push(d <= 8 ? dia(fecha, "verde", "respeto") : dia(fecha, "rojo", "rompio"));
    }
    const r = resumen(obs);
    expect(r.faseCompleta).toBe(true);
    expect(r.lectura).toMatch(/fase 2/);
  });

  it("si los días verdes tampoco aguantan, dice que NO se pase a la fase 2", () => {
    const obs: Observacion[] = [];
    for (let d = 1; d <= SESIONES_FASE_1; d++) {
      const fecha = `2026-09-${String(d).padStart(2, "0")}`;
      obs.push(dia(fecha, "verde", d <= 3 ? "respeto" : "rompio"));
    }
    expect(resumen(obs).lectura).toMatch(/NO se sostiene/);
  });

  it("con la fase completa pero sin días verdes decididos, pide alargar", () => {
    const obs: Observacion[] = [];
    for (let d = 1; d <= SESIONES_FASE_1; d++) {
      obs.push(dia(`2026-09-${String(d).padStart(2, "0")}`, "verde", "no_llego"));
    }
    expect(resumen(obs).lectura).toMatch(/alarga la observación/);
  });

  it("sin nada calificado lo dice y no inventa lectura", () => {
    expect(resumen([]).lectura).toMatch(/Todavía no hay ninguna sesión calificada/);
  });

  it("una fila TARDÍA queda fuera de las estadísticas pero se cuenta aparte", () => {
    // Unos niveles dibujados a media sesión ya se eligieron viendo el precio:
    // mezclarlos con los del amanecer mediría otra cosa.
    const tarde = { ...dia("2026-09-02", "verde", "respeto"), fueraVentana: true };
    const r = resumen([dia("2026-09-01", "verde", "rompio"), tarde]);
    expect(r.total.calificadas).toBe(1);
    expect(r.total.respeto).toBe(0);
    expect(r.fueraDeVentanaCount).toBe(1);
    expect(r.sesionesDistintas).toBe(1);
  });
});
