import { describe, expect, it } from "vitest";
import { esc, primaNotOpenedText } from "./alertText";

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
