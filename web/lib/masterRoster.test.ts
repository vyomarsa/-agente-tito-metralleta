import { describe, expect, it } from "vitest";
import { splitMasterMessage } from "./masterRoster";

// Mensaje real del master (2026-08-03): UN mensaje con varias compañías, cada análisis
// rotulado con "‹Compañía› 4H", secciones separadas por ⚠️, y una noticia macro al final.
const COMBINADO = `Para mantenernos optimistas recuperar los 312 es ideal (promedio móvil 200)

⚠️Netflix 4H, se levanta optimista el día de hoy, la idea es recuperar los niveles de 72.5.

Cotizar por encima de 72.5 la
Idea aquí.

⚠️Google 4H. Explosivo, recuperando bastante luego de esa corrección reciente.

⚠️Meta 4H, tras sus reportes de resultados y gran gasto, meta tuvo una gran caída.

⚠️Microsoft 4H, rompiendo aparentemte su doble techo ahí, superando los 471.

⚠️Tesla 4H, continua bajista, buscando los 420 cómo próximo nivel.

⚠️SOXX 4H. ETF de semis, no se ve muy bien, validando su patrón bajista hoy.

⚠️Nvidia 4H, fue a buscar los niveles de (200) el pasado viernes.

⚠️UNH 4H, tras el rebote de los semis la semana pasada, el sector defensivo se debilita.

⚠️Irán señaló que no tiene interés en reanudar las negociaciones con EE.UU.`;

// El brief matutino: noticias generales con el análisis del QQQ INCRUSTADO al final,
// introducido a media frase por "Comenzando con el QQQ 4H".
const BRIEF = `Buenos días, team. Hoy es lunes 3 de agosto.

Durante el fin de semana vimos volatilidad en semis y geopolítica.

_Esta información es únicamente con fines educativos_

Pasando a la parte técnica. Comenzando con el QQQ 4H

Aún tenemos una tendencia bajista, con un hueco abierto entre los 690 y 684.

Para estar más optimistas deberíamos romper los niveles encima de 700`;

describe("splitMasterMessage", () => {
  it("parte un mensaje combinado en una sección por compañía", () => {
    const segs = splitMasterMessage(COMBINADO);
    const tickers = segs.filter((s) => s.ticker).map((s) => s.ticker);
    expect(tickers).toEqual(["NFLX", "GOOGL", "META", "MSFT", "TSLA", "SOXX", "NVDA", "UNH"]);
  });

  it("el preámbulo sin '4H' y la noticia macro van a UNA entrada de noticias", () => {
    const segs = splitMasterMessage(COMBINADO);
    const news = segs.filter((s) => s.ticker === null);
    expect(news).toHaveLength(1);
    expect(news[0].text).toContain("312"); // preámbulo suelto, sin encabezado 4H
    expect(news[0].text).toContain("Irán"); // noticia geopolítica del final
  });

  it("cada sección de compañía conserva su texto completo", () => {
    const segs = splitMasterMessage(COMBINADO);
    const nflx = segs.find((s) => s.ticker === "NFLX");
    expect(nflx?.text).toContain("Netflix 4H");
    expect(nflx?.text).toContain("Cotizar por encima de 72.5"); // párrafo sin ⚠️ se queda
  });

  it("extrae el QQQ incrustado a media frase en el brief matutino", () => {
    const segs = splitMasterMessage(BRIEF);
    const qqq = segs.find((s) => s.ticker === "QQQ");
    expect(qqq).toBeTruthy();
    expect(qqq?.text).toContain("QQQ 4H");
    expect(qqq?.text).toContain("690 y 684"); // el análisis técnico del QQQ
    expect(qqq?.text).toContain("encima de 700");
  });

  it("el resto del brief (antes del QQQ) queda como noticias, no dentro del QQQ", () => {
    const segs = splitMasterMessage(BRIEF);
    const qqq = segs.find((s) => s.ticker === "QQQ");
    expect(qqq?.text).not.toContain("Buenos días"); // el saludo NO cae en el QQQ
    const news = segs.find((s) => s.ticker === null);
    expect(news?.text).toContain("Buenos días");
    expect(news?.text).toContain("fines educativos");
  });

  it("reconoce las erratas del master para Netflix ('Netlfix'/'Netlix')", () => {
    // El master escribe mal Netflix a menudo; sin estos alias su análisis caía en noticias.
    const segs = splitMasterMessage("Netlfix 4H, muy buen impulso, sin romper el nivel de 72.5.");
    expect(segs.find((s) => s.ticker === "NFLX")?.text).toContain("Netlfix 4H");
  });

  it("una mención suelta ('a diferencia del QQQ el spy…') NO crea sección de QQQ", () => {
    const segs = splitMasterMessage("⚠️SPY 4H. A diferencia del QQQ el spy muestra solidez.");
    const tickers = segs.filter((s) => s.ticker).map((s) => s.ticker);
    expect(tickers).toEqual(["SPY"]); // solo SPY; "del QQQ" no lleva 4H
  });

  it("un mensaje de una sola compañía produce una sola sección (retrocompatible)", () => {
    const segs = splitMasterMessage("⚠️Tesla 4H, continua bajista, buscando los 420.");
    expect(segs).toHaveLength(1);
    expect(segs[0].ticker).toBe("TSLA");
  });

  it("un mensaje sin análisis (resumen de fin de semana) es una sola noticia", () => {
    const finde = "⚠️Buenos días, team.\n\n⚠️Hoy sábado no hay mercado.\n\n⚠️Agenda cargada.";
    const segs = splitMasterMessage(finde);
    expect(segs).toHaveLength(1);
    expect(segs[0].ticker).toBeNull();
  });

  it("no rompe con texto vacío", () => {
    expect(splitMasterMessage("")).toEqual([]);
    expect(splitMasterMessage("   ")).toEqual([]);
  });
});
