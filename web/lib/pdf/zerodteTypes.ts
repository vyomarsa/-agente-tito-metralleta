// Tipos propios del Agente 0DTE. Aislados de lib/types.ts a propósito: `Row`/
// `RawContract` reales no cargan bid/ask/griegos (el resto del proyecto no los
// necesita), pero 0DTE sí — la cadena del día trae los griegos reales de Schwab.
// Ver plan de port: humble-tumbling-puzzle.md.

import type { ContractType } from "./types";

export type { ContractType };

export interface ZContractGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** IV decimal (0.30 = 30%). */
  iv: number | null;
}

/** Fila de la cadena 0DTE: como `Row`, más bid/ask/griegos reales de Schwab. */
export interface ZRow {
  optionTicker: string;
  contractType: ContractType;
  expiration: string;
  strike: number;
  openInterest: number;
  volume: number;
  bid: number | null;
  ask: number | null;
  greeks: ZContractGreeks | null;
}
