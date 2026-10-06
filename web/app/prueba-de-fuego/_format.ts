// Formateadores compartidos por los componentes del dashboard.

export const int = new Intl.NumberFormat("en-US");
export const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});
export const money0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
export const px = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const pct = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

export function timeOf(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return ts;
  }
}
export function dateOf(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

const ET = "America/New_York";
/** Hora del mercado (ET) desde un ISO string. */
export function timeET(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", { timeZone: ET, hour12: false });
  } catch {
    return ts;
  }
}
/** Fecha del mercado (ET) desde un ISO string. */
export function dateET(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
/** HH:MM en ET desde un timestamp UNIX en segundos (para el eje de la gráfica). */
export function hmET(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString("en-US", {
    timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
