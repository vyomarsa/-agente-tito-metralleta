// Asequibilidad del candidato frente al efectivo del usuario.
//
// PURO y pensado para correr en el CLIENTE: recibe el saldo, que vive en
// localStorage y nunca llega al servidor. Aislado de la ruta a propósito.

import type { WheelCandidate } from "./wheel";

export interface AffordResult {
  affordable: boolean;
  /** Cuánto efectivo falta para cubrir el colateral, en $. 0 si alcanza. */
  shortfall: number;
}

export function affordOf(candidate: WheelCandidate, cash: number): AffordResult {
  const collateral = candidate.metrics?.collateral ?? Infinity;
  if (candidate.blocked || !Number.isFinite(collateral)) {
    return { affordable: false, shortfall: 0 };
  }
  const affordable = collateral <= cash;
  return { affordable, shortfall: affordable ? 0 : collateral - cash };
}

export type AffordableCandidate = WheelCandidate & { afford: AffordResult };

export function sortByAffordThenScore(candidates: WheelCandidate[], cash: number): AffordableCandidate[] {
  return candidates
    .map((c) => ({ ...c, afford: affordOf(c, cash) }))
    .sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      if (a.afford.affordable !== b.afford.affordable) return a.afford.affordable ? -1 : 1;
      return (b.score?.total ?? 0) - (a.score?.total ?? 0);
    });
}
