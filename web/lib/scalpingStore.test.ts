import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { anotar, borrar, calificarEnDisco, cargar, claveDe, pendientes } from "./scalpingStore";
import type { Calificacion, Observacion } from "./scalping";

// El store escribe bajo `process.cwd()/data/scalping`. Se le da a cada test un
// directorio propio para no tocar la bitácora real del usuario.
const CWD = process.cwd();
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(CWD, "data", ".test-scalping-"));
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(CWD);
  await fs.rm(tmp, { recursive: true, force: true });
});

function obs(over: Partial<Observacion> = {}): Observacion {
  return {
    ticker: "SPY", fecha: "2026-09-03", anotadaEn: "2026-09-03T13:20:00Z",
    expiracion: "2026-09-04", spotApertura: 770, netGex: 2e9, flipStrike: 765,
    flipDistPct: 0.6, gammaFrentePct: 59, frenteDte: 1, earnings: "no_aplica", tier: "optimo",
    niveles: { piso: 765, pisoOi: 55_000, techo: 778, techoOi: 16_000, centro: 775, anchoPct: 1.7 },
    luz: "ambar", motivos: [], fueraVentana: false, ayer: null, cierre: null,
    ...over,
  };
}

const cierre: Calificacion = {
  calificadaEn: "2026-09-03T20:05:00Z", velas: 78, apertura: 770, alto: 776, bajo: 766, cierre: 774,
  piso: null, techo: null, veredicto: "no_llego", contenidoPct: 100, imanPct: 20, rangoUsadoPct: 77,
};

describe("scalpingStore", () => {
  it("guarda y relee una observación", async () => {
    const r = await anotar(obs());
    expect(r.guardada).toBe(true);
    expect(await cargar()).toHaveLength(1);
  });

  it("NO reescribe los niveles de un día ya anotado", async () => {
    await anotar(obs({ niveles: { ...obs().niveles, piso: 765 } }));
    const r = await anotar(obs({ niveles: { ...obs().niveles, piso: 700 } }));
    expect(r.guardada).toBe(false);
    expect(r.observacion.niveles.piso).toBe(765);
    expect((await cargar())[0].niveles.piso).toBe(765);
  });

  it("una fila FUERA DE VENTANA cede el sitio a la de la apertura", async () => {
    // Sin esto, mirar el semáforo a las 6 de la mañana ocupaba el hueco del día
    // con una fila que no cuenta para nada.
    await anotar(obs({ fueraVentana: true, spotApertura: 700 }));
    const r = await anotar(obs({ fueraVentana: false, spotApertura: 770 }));
    expect(r.guardada).toBe(true);
    expect(r.nota).toMatch(/fuera de ventana/);
    const todas = await cargar();
    expect(todas).toHaveLength(1);
    expect(todas[0].spotApertura).toBe(770);
  });

  it("pero NUNCA al revés: la buena no la pisa una fuera de ventana", async () => {
    await anotar(obs({ fueraVentana: false, spotApertura: 770 }));
    const r = await anotar(obs({ fueraVentana: true, spotApertura: 700 }));
    expect(r.guardada).toBe(false);
    expect((await cargar())[0].spotApertura).toBe(770);
  });

  it("una fila ya CALIFICADA no se sustituye, aunque fuera fuera de ventana", async () => {
    await anotar(obs({ fueraVentana: true }));
    await calificarEnDisco("SPY", "2026-09-03", cierre);
    const r = await anotar(obs({ fueraVentana: false }));
    expect(r.guardada).toBe(false);
    expect((await cargar())[0].cierre).not.toBeNull();
  });

  it("no sobrescribe un veredicto de cierre existente", async () => {
    await anotar(obs());
    expect(await calificarEnDisco("SPY", "2026-09-03", cierre)).toBe(true);
    expect(await calificarEnDisco("SPY", "2026-09-03", { ...cierre, veredicto: "rompio" })).toBe(false);
    expect((await cargar())[0].cierre!.veredicto).toBe("no_llego");
  });

  it("califica solo lo que existe", async () => {
    expect(await calificarEnDisco("QQQ", "2026-09-03", cierre)).toBe(false);
  });

  it("pendientes excluye la sesión de HOY, que sigue abierta", async () => {
    await anotar(obs({ fecha: "2026-09-02" }));
    await anotar(obs({ fecha: "2026-09-03" }));
    const p = await pendientes("2026-09-03");
    expect(p.map((o) => o.fecha)).toEqual(["2026-09-02"]);
  });

  it("pendientes excluye lo ya calificado", async () => {
    await anotar(obs({ fecha: "2026-09-02" }));
    await calificarEnDisco("SPY", "2026-09-02", cierre);
    expect(await pendientes("2026-09-03")).toHaveLength(0);
  });

  it("borra una fila concreta y avisa si no había nada que borrar", async () => {
    await anotar(obs());
    expect(await borrar("SPY", "2026-09-03")).toBe(true);
    expect(await cargar()).toHaveLength(0);
    expect(await borrar("SPY", "2026-09-03")).toBe(false);
  });

  it("una bitácora inexistente se lee como vacía, no como error", async () => {
    expect(await cargar()).toEqual([]);
  });

  it("la clave normaliza el ticker", () => {
    expect(claveDe(" spy ", "2026-09-03")).toBe("SPY|2026-09-03");
  });
});
