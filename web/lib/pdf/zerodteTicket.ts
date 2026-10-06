// ============================================================================
// GEX Ticket: traduce la TESIS del GEX Trade (dirección + target/stop en el
// ÍNDICE) a un CONTRATO concreto que comprar, con stop/target en $ de la
// opción. PURA (sin fs/servidor). Se alimenta del trade activo (el "Mejor
// trade ahora" listo, o el "Trade alterno" de momentum en γ−) y de la cadena
// (griegas + quote por strike, ya presentes en `data.lines`).
//
// Traducción a $ de la opción por griegas (aprox. local, buena dentro de
// ~1-1.5σ):
//   precioOpción(ΔS) ≈ mid + delta·ΔS + ½·gamma·ΔS²   (delta con signo: call +, put −)
// La gamma engorda la ganancia al target Y amortigua la pérdida al stop, así
// que el R:B de la OPCIÓN suele superar al lineal del índice.
// ============================================================================

import type { EntryDecision } from "./zerodteStrategy";

/** Fila mínima del chain que necesita el ticket (call o put por strike). */
export interface TicketChainRow {
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  delta: number | null; // firmado por la fuente (put negativo)
  gamma: number | null;
  iv: number | null;
  volume: number;
  oi: number;
}

export interface TicketParams {
  deltaMin: number;      // banda de |delta| baja
  deltaMax: number;      // banda de |delta| alta
  deltaTarget: number;   // |delta| ideal para elegir (centro de la banda)
  minVol: number;        // volumen mínimo del contrato
  minOi: number;         // OI mínimo
  maxSpreadPct: number;  // (ask−bid)/mid máximo
  maxRisk: number;       // pérdida al stop máxima, en $/contrato
}

// Defaults: delta 0.40–0.60 (centro 0.50). 0DTE: el OI es de AYER; las
// posiciones de hoy aún no cuentan, así que en el ATM el OI es bajo aunque el
// volumen sea enorme. El volumen es el mejor filtro de liquidez para 0DTE; el
// OI solo descarta strikes muertos → piso bajo.
export const TICKET_DEFAULTS: TicketParams = {
  deltaMin: 0.40, deltaMax: 0.60, deltaTarget: 0.50,
  minVol: 2000, minOi: 250, maxSpreadPct: 0.08, maxRisk: 600,
};

export interface Ticket {
  strike: number;
  type: "call" | "put";
  mid: number;
  bid: number;
  ask: number;
  delta: number;   // |delta|
  gamma: number;
  iv: number | null;
  volume: number;
  oi: number;
  spreadPct: number;
  targetPx: number;   // precio de la opción al target del índice
  stopPx: number;     // precio de la opción al stop del índice
  rbOption: number;   // R:B sobre la opción (con gamma)
  cost: number;       // mid·100
  risk: number;       // (mid−stopPx)·100
  gainPct: number;    // (targetPx−mid)/mid
  lossPct: number;    // (mid−stopPx)/mid
}

/** Proyecta el precio de la opción a un nivel del índice (delta+gamma). Piso 0.05. */
function projectPx(mid: number, deltaSigned: number, gamma: number, dS: number): number {
  return Math.max(0.05, mid + deltaSigned * dS + 0.5 * gamma * dS * dS);
}

/**
 * Elige el mejor contrato para expresar `trade` (el trade activo, ya LISTO).
 * Devuelve null si ningún strike pasa los filtros (→ el card muestra "sin contrato").
 */
export function pickTicket(
  trade: EntryDecision,
  spot: number,
  chain: TicketChainRow[],
  params: TicketParams = TICKET_DEFAULTS,
): Ticket | null {
  if (!(spot > 0) || !(trade.target > 0) || !(trade.stop > 0)) return null;
  const long = trade.direction === "long";
  const wantType: "call" | "put" = long ? "call" : "put";
  const dST = trade.target - spot; // desplazamiento del índice al target
  const dSS = trade.stop - spot;   // al stop

  let best: Ticket | null = null;
  let bestScore = Infinity;
  for (const r of chain) {
    if (r.type !== wantType) continue;
    if (r.bid == null || r.ask == null || !(r.ask > 0) || !(r.bid >= 0)) continue;
    if (r.delta == null || r.gamma == null || !(r.gamma >= 0)) continue;
    const ad = Math.abs(r.delta);
    if (ad < params.deltaMin || ad > params.deltaMax) continue;
    if (r.volume < params.minVol || r.oi < params.minOi) continue;
    const mid = (r.bid + r.ask) / 2;
    if (!(mid > 0)) continue;
    const spreadPct = (r.ask - r.bid) / mid;
    if (spreadPct > params.maxSpreadPct) continue;

    const deltaSigned = r.type === "call" ? ad : -ad;
    const targetPx = projectPx(mid, deltaSigned, r.gamma, dST);
    const stopPx = projectPx(mid, deltaSigned, r.gamma, dSS);
    const gain = targetPx - mid, loss = mid - stopPx;
    if (!(gain > 0) || !(loss > 0)) continue; // proyección incoherente
    const risk = loss * 100;
    if (risk > params.maxRisk) continue;

    // Score: |delta| más cercano al objetivo, desempate por spread más apretado.
    const score = Math.abs(ad - params.deltaTarget) + spreadPct * 0.1;
    if (score < bestScore) {
      bestScore = score;
      best = {
        strike: r.strike, type: r.type, mid, bid: r.bid, ask: r.ask,
        delta: ad, gamma: r.gamma, iv: r.iv, volume: r.volume, oi: r.oi,
        spreadPct, targetPx, stopPx, rbOption: gain / loss,
        cost: mid * 100, risk, gainPct: gain / mid, lossPct: loss / mid,
      };
    }
  }
  return best;
}
