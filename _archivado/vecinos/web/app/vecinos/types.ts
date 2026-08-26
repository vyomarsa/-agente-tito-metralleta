import type { VecinosSignal, NeighborStrike, VecinoTarget } from "@/lib/vecinos";

export interface VecinosExpiration {
  date: string; // YYYY-MM-DD
  dte: number;  // 0 = vence hoy
}

export interface VecinosResponse {
  ticker: string;
  expiration: string;
  isToday: boolean;
  selectedDte: number;
  available: VecinosExpiration[];
  minutesLeft: number;
  spot: number;
  spotSource: "quote" | "paridad";
  change: number | null;
  changePercent: number | null;
  contractCount: number;
  /** Operaciones del vencimiento con agresor identificable. */
  flowTrades: number;
  /** Strikes con net premium real utilizable. */
  flowStrikes: number;
  /** false = MarketSnack no devolvió flujo (la señal cayó al respaldo estructural). */
  flowAvailable: boolean;
  updatedAt: string;
  signal: VecinosSignal;
}

export type { VecinosSignal, NeighborStrike, VecinoTarget };
