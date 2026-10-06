// Idioma de la interfaz y de los textos generados por el agente.
// Inglés por defecto; español opcional. El usuario lo elige en la página y se
// guarda en el navegador; el idioma viaja al API por ?lang= para que la PROSA
// del servidor (panorama, escenarios, mejor trade, cierre) venga ya traducida.

export type Lang = "en" | "es";

export const LANGS: Lang[] = ["en", "es"];

/** Normaliza un valor arbitrario a un Lang válido (inglés por defecto). */
export function asLang(v: string | null | undefined): Lang {
  return v === "es" ? "es" : "en";
}
