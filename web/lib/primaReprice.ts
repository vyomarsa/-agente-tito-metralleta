// Re-cotización de posiciones de venta de prima contra la cadena real.
//
// Para gestionar hay que saber CUÁNTO CUESTA CERRAR el spread hoy: se recompra la
// pata corta y se vende la larga, así que el débito de cierre = mid(corto) − mid(largo).
// Ese número es el que alimenta las reglas (pérdida del 30%, suelo del 50%).
//
// Vive aparte de `primaPaper.ts` porque aquello es PURO y esto necesita la cadena.
// Aquí no hay red: se le pasan los contratos ya normalizados y devuelve el precio.
// Tests en `primaReprice.test.ts`.

import type { Chain2Contract } from "./optionChain2";
import type { PrimaPosition } from "./primaPaper";

export interface RepriceResult {
  /** Débito por acción para cerrar. null si la cadena no da precio utilizable. */
  currentValue: number | null;
  /** |Δ| de la pata corta ahora, para el aviso de gamma. null si no hay dato. */
  shortDelta: number | null;
  /** Por qué no se pudo cotizar (null si fue bien). */
  problem: string | null;
}

/** Mid utilizable de un contrato: mid → (bid+ask)/2 → último. */
function midOf(c: Chain2Contract): number | null {
  if (c.mid != null && c.mid >= 0) return c.mid;
  if (c.bid != null && c.ask != null && c.ask > 0) return (c.bid + c.ask) / 2;
  if (c.lastPrice != null && c.lastPrice >= 0) return c.lastPrice;
  return null;
}

/**
 * Calcula el coste de cerrar la posición con la cadena dada.
 *
 * Los contratos deben ser del MISMO vencimiento que la posición: si no, se estaría
 * cotizando otro contrato con el mismo strike y el número saldría plausible pero
 * falso, que es peor que no tener número.
 */
export function repriceFromChain(pos: PrimaPosition, contracts: Chain2Contract[]): RepriceResult {
  const tipo = pos.type === "put_credit" ? "put" : "call";
  const delVencimiento = contracts.filter(
    (c) => c.type === tipo && c.expiration === pos.expiration,
  );
  if (delVencimiento.length === 0) {
    return { currentValue: null, shortDelta: null, problem: `sin cadena de ${tipo} para ${pos.expiration}` };
  }

  const corto = delVencimiento.find((c) => c.strike === pos.shortStrike);
  const largo = delVencimiento.find((c) => c.strike === pos.longStrike);
  if (!corto || !largo) {
    return { currentValue: null, shortDelta: null, problem: "no aparecen los strikes de la posición en la cadena" };
  }

  const mc = midOf(corto);
  const ml = midOf(largo);
  if (mc == null || ml == null) {
    return { currentValue: null, shortDelta: null, problem: "sin cotización utilizable en alguna pata" };
  }

  // El débito de cierre nunca es negativo ni mayor que el ancho: fuera de esa banda
  // el dato está roto (quotes rancias o cruzadas) y es mejor no usarlo.
  const bruto = mc - ml;
  const acotado = Math.min(Math.max(bruto, 0), pos.width);
  return {
    currentValue: Math.round(acotado * 10000) / 10000,
    shortDelta: corto.delta != null ? Math.abs(corto.delta) : null,
    problem: null,
  };
}
