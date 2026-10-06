// Parseo de símbolos de opción en formato OCC, p. ej. "TSLA261120P00305000".
// Estructura: ROOT + YYMMDD + (C|P) + strike*1000 (8 dígitos).

export interface OccInfo {
  underlying: string;
  expiration: string; // YYYY-MM-DD
  type: "call" | "put";
  strike: number;
}

export function parseOcc(symbol: string): OccInfo | null {
  if (!symbol || symbol.length < 16) return null;
  const strikeRaw = symbol.slice(-8);
  const typeRaw = symbol.slice(-9, -8);
  const dateRaw = symbol.slice(-15, -9);
  const underlying = symbol.slice(0, -15);
  if (
    !/^\d{8}$/.test(strikeRaw) ||
    !/^[CP]$/.test(typeRaw) ||
    !/^\d{6}$/.test(dateRaw) ||
    !underlying
  ) {
    return null;
  }
  const expiration = `20${dateRaw.slice(0, 2)}-${dateRaw.slice(2, 4)}-${dateRaw.slice(4, 6)}`;
  return {
    underlying,
    expiration,
    type: typeRaw === "C" ? "call" : "put",
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}

/**
 * Fecha del mercado (ET) para `now`, como epoch de medianoche UTC.
 * Importante: no se puede usar la fecha UTC — después de las ~8 PM ET, UTC ya
 * pasó al día siguiente y los vencimientos se reportarían mal.
 */
/** Fecha del mercado (ET) como "YYYY-MM-DD". */
export function marketDateStr(now: Date): string {
  // en-CA formatea como YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function marketToday(now: Date): number {
  return Date.parse(`${marketDateStr(now)}T00:00:00Z`);
}

/** Días hasta el vencimiento respecto al día de mercado (ET) de `now`. */
export function daysToExpiration(expiration: string, now: Date): number {
  const exp = Date.parse(`${expiration}T00:00:00Z`);
  return Math.round((exp - marketToday(now)) / 86_400_000);
}
