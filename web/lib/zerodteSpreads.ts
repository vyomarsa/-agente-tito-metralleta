// ============================================================================
// Spreads del 0DTE — la MISMA tesis del GEX, con riesgo definido. PURO.
//
// Portado (y adaptado a los tipos de Tito) de `strategySuggestions.ts` del agente
// "Visionary Trades – Prueba de Fuego" de un compañero (oct 2026). Tres ideas:
//
//   1. Vertical de débito → misma dirección y objetivo que el GEX Trade activo,
//      pero con la pata corta EN el objetivo: no se paga por recorrido que el
//      propio motor no espera. Es la respuesta directa a la auditoría del
//      2026-09-17: la opción suelta acierta ~56% pero su pago está invertido
//      (stop −54% de la prima vs objetivo +38%). El vertical cambia la FORMA del
//      pago sin tocar la señal; `breakevenWinPct` deja las dos comparables.
//   2. Credit spreads en los muros de gamma (call wall arriba, put wall abajo),
//      buscados FUERA del cono de 1σ. El original los buscaba pegados al spot y,
//      como la gamma de un 0DTE se concentra en el dinero, el "muro" salía ATM
//      (SPY 774,94 → call wall 775, verificado el 2026-10-05): un credit spread
//      que necesita ~94% de aciertos para empatar. Mismo criterio que Venta de
//      Prima: la pata corta va más allá de lo que da la volatilidad.
//   3. Iron condor = los dos credit spreads a la vez, el rango entre muros.
//   2 y 3 solo en γ+: ahí el dealer frena el precio en los muros; en γ− los rompe.
//
// Precio CONSERVADOR, igual que `creditSpread.ts`: se compra al ASK y se vende al
// BID, nunca al mid. Si falta un bid/ask real de alguna pata, la idea sale null
// con su nota en vez de inventar un número. Los $ son por spread (×100) y NETOS
// de comisiones (`commissions.ts`).
//
// Nada de esto es una orden ni un consejo: el agente calcula y muestra.
// ============================================================================

import type { ZeroDteAnalysis, ZeroDteLeg, ZeroDteStrike } from "./zerodte";
import type { ZeroDteTrade } from "./zerodteSignals";
import { commissionOf, round2 } from "./commissions";
import { MIN_CREDIT } from "./creditSpread";

const MULT = 100;

export interface ZeroDteVertical {
  kind: "bull_call" | "bear_put";
  type: "call" | "put";
  longStrike: number;
  shortStrike: number;
  width: number;
  /** Débito por acción: ask de la larga − bid de la corta. */
  debit: number;
  /** Ganancia máxima por spread a vencimiento, neta de comisiones ($). */
  maxGain: number;
  /** Pérdida máxima por spread, comisiones incluidas ($, positiva). */
  maxLoss: number;
  /** Precio del subyacente a vencimiento en el que el spread empata (sin comisiones). */
  breakeven: number;
  /** % de aciertos necesario para empatar si se gana el máximo o se pierde el máximo. */
  breakevenWinPct: number;
  rationale: string;
}

export interface ZeroDteCreditSpread {
  side: "call" | "put";
  shortStrike: number;
  longStrike: number;
  width: number;
  /** Crédito por acción: bid de la corta − ask de la larga. */
  credit: number;
  /** Ganancia máxima si vence OTM (no hay orden de cierre), neta de comisiones ($). */
  maxGain: number;
  /** Pérdida máxima por spread, comisiones incluidas ($, positiva). */
  maxLoss: number;
  breakeven: number;
  breakevenWinPct: number;
  /** El crédito no llega al mínimo de Venta de Prima: las comisiones se comen >20%. */
  belowMinCredit: boolean;
  rationale: string;
}

export interface ZeroDteIronCondor {
  put: ZeroDteCreditSpread;
  call: ZeroDteCreditSpread;
  credit: number;
  maxGain: number;
  maxLoss: number;
  beLow: number;
  beHigh: number;
  breakevenWinPct: number;
  rationale: string;
}

export interface ZeroDteSpreads {
  callWall: number | null;
  putWall: number | null;
  vertical: ZeroDteVertical | null;
  verticalNote: string;
  creditCall: ZeroDteCreditSpread | null;
  creditPut: ZeroDteCreditSpread | null;
  creditNote: string;
  ironCondor: ZeroDteIronCondor | null;
  ironCondorNote: string;
}

/**
 * % de aciertos con el que una apuesta binaria (gana `gain` o pierde `loss`)
 * empata. Sirve igual para la opción suelta del GEX Ticket que para un spread.
 * null si los números no forman una apuesta (ganancia ≤ 0 o pérdida ≤ 0).
 */
export function breakevenWinPct(gain: number, loss: number): number | null {
  const g = gain, l = Math.abs(loss);
  if (!(g > 0) || !(l > 0)) return null;
  return round2((l / (g + l)) * 100);
}

/**
 * Muros de GAMMA (no de OI) fuera del cono de 1σ: el strike en o sobre el techo
 * con más gamma·OI de calls y el strike en o bajo el suelo con más gamma·OI de
 * puts. Es donde el dealer más frena entre lo que la volatilidad no alcanza.
 */
export function gammaWalls(a: ZeroDteAnalysis): { callWall: number | null; putWall: number | null } {
  const hi = Math.max(a.spot, a.expectedRange.high);
  const lo = Math.min(a.spot, a.expectedRange.low);
  let callWall: number | null = null, cMax = 0;
  let putWall: number | null = null, pMax = 0;
  for (const s of a.strikes) {
    const c = gammaOi(s.call);
    const p = gammaOi(s.put);
    if (s.strike > a.spot && s.strike >= hi && c > cMax) { cMax = c; callWall = s.strike; }
    if (s.strike < a.spot && s.strike <= lo && p > pMax) { pMax = p; putWall = s.strike; }
  }
  return { callWall, putWall };
}

/** Las tres ideas de spread sobre la misma cadena y el mismo trade del ticket. */
export function zeroDteSpreads(a: ZeroDteAnalysis, trade: ZeroDteTrade | null): ZeroDteSpreads {
  const { callWall, putWall } = gammaWalls(a);
  const v = debitVertical(a, trade);

  let creditCall: ZeroDteCreditSpread | null = null;
  let creditPut: ZeroDteCreditSpread | null = null;
  let creditNote = "";
  if (a.regime !== "positive") {
    creditNote = "γ− : el dealer acelera y los muros se rompen; vender prima en ellos no tiene respaldo.";
  } else {
    const notes: string[] = [];
    const cc = creditSpread(a, "call", callWall);
    const cp = creditSpread(a, "put", putWall);
    creditCall = cc.spread;
    creditPut = cp.spread;
    if (!cc.spread) notes.push(cc.note);
    if (!cp.spread) notes.push(cp.note);
    creditNote = notes.join(" ");
  }

  let ironCondor: ZeroDteIronCondor | null = null;
  let ironCondorNote = "";
  if (a.regime !== "positive") {
    ironCondorNote = "γ− : sin pin que contenga el rango, no hay iron condor.";
  } else if (!creditCall || !creditPut) {
    ironCondorNote = "Hace falta un credit spread válido en CADA muro para armar el rango.";
  } else {
    ironCondor = condor(creditPut, creditCall);
  }

  return {
    callWall, putWall,
    vertical: v.vertical, verticalNote: v.note,
    creditCall, creditPut, creditNote,
    ironCondor, ironCondorNote,
  };
}

// ---------------------------------------------------------------------------
// 1. Vertical de débito
// ---------------------------------------------------------------------------

function debitVertical(
  a: ZeroDteAnalysis,
  trade: ZeroDteTrade | null,
): { vertical: ZeroDteVertical | null; note: string } {
  if (!trade) return { vertical: null, note: "Sin trade activo — no hay dirección para el vertical." };
  const type: "call" | "put" = trade.side === "LONG" ? "call" : "put";
  const up = type === "call";
  const strikes = withLeg(a.strikes, type);
  const longS = nearest(strikes, trade.entry);
  const shortS = nearest(strikes, trade.target);
  if (!longS || !shortS) return { vertical: null, note: `La cadena no trae ${type}s para armar el vertical.` };
  const width = up ? shortS.strike - longS.strike : longS.strike - shortS.strike;
  if (!(width > 0)) {
    return {
      vertical: null,
      note: `El objetivo ${fmt(trade.target)} cae en el mismo strike que la entrada: no hay ancho para un vertical.`,
    };
  }
  const longAsk = quote(leg(longS, type), "ask");
  const shortBid = quote(leg(shortS, type), "bid");
  if (longAsk == null || shortBid == null) {
    return { vertical: null, note: "Falta bid/ask real en alguna pata del vertical — no se inventa el precio." };
  }
  const debit = round2(longAsk - shortBid);
  if (!(debit > 0) || debit >= width) {
    return { vertical: null, note: `Precio incoherente (débito $${debit.toFixed(2)} sobre ancho ${width}): cotización rota.` };
  }
  // Se cierra antes del vencimiento (2 patas × apertura + cierre).
  const fees = commissionOf(1, 2, true);
  const maxGain = round2((width - debit) * MULT - fees);
  const maxLoss = round2(debit * MULT + fees);
  const breakeven = round2(up ? longS.strike + debit : longS.strike - debit);
  const label = type === "call" ? "CALL" : "PUT";
  return {
    vertical: {
      kind: up ? "bull_call" : "bear_put",
      type,
      longStrike: longS.strike,
      shortStrike: shortS.strike,
      width,
      debit,
      maxGain,
      maxLoss,
      breakeven,
      breakevenWinPct: breakevenWinPct(maxGain, maxLoss) ?? 100,
      rationale: `Compra ${label} ${fmt(longS.strike)} y vende ${label} ${fmt(shortS.strike)} (el objetivo del GEX Trade): misma tesis que el ticket, riesgo tope $${maxLoss.toFixed(0)}. Cobra el máximo si a vencimiento el subyacente está ${up ? "por encima" : "por debajo"} de ${fmt(shortS.strike)}.`,
    },
    note: "",
  };
}

// ---------------------------------------------------------------------------
// 2. Credit spread en un muro de gamma
// ---------------------------------------------------------------------------

function creditSpread(
  a: ZeroDteAnalysis,
  side: "call" | "put",
  wall: number | null,
): { spread: ZeroDteCreditSpread | null; note: string } {
  const name = side === "call" ? "call wall" : "put wall";
  if (wall == null) {
    return { spread: null, note: `Sin ${name} de gamma ${side === "call" ? "sobre el techo" : "bajo el suelo"} de 1σ.` };
  }
  const strikes = withLeg(a.strikes, side);
  const i = strikes.findIndex((s) => s.strike === wall);
  // La protección es el strike siguiente hacia AFUERA del muro.
  const longS = i < 0 ? null : side === "call" ? strikes[i + 1] : strikes[i - 1];
  if (i < 0 || !longS) return { spread: null, note: `No hay strike de protección más allá del ${name} ${fmt(wall)}.` };
  const shortBid = quote(leg(strikes[i], side), "bid");
  const longAsk = quote(leg(longS, side), "ask");
  if (shortBid == null || longAsk == null) {
    return { spread: null, note: `Falta bid/ask real en el spread del ${name} — no se inventa el precio.` };
  }
  const credit = round2(shortBid - longAsk);
  const width = Math.abs(longS.strike - wall);
  if (!(credit > 0) || credit >= width) {
    return { spread: null, note: `El spread del ${name} ${fmt(wall)} no paga crédito con precio conservador.` };
  }
  // Si vence OTM no hay orden de cierre: solo la de apertura.
  const maxGain = round2(credit * MULT - commissionOf(1, 2, false));
  const maxLoss = round2((width - credit) * MULT + commissionOf(1, 2, false));
  return {
    spread: {
      side,
      shortStrike: wall,
      longStrike: longS.strike,
      width,
      credit,
      maxGain,
      maxLoss,
      breakeven: round2(side === "call" ? wall + credit : wall - credit),
      breakevenWinPct: breakevenWinPct(maxGain, maxLoss) ?? 100,
      belowMinCredit: credit < MIN_CREDIT,
      rationale: `Vende el ${name} ${fmt(wall)} (más gamma ${side === "call" ? "sobre el techo" : "bajo el suelo"} de 1σ): gana el crédito si el cierre queda ${side === "call" ? "por debajo" : "por encima"} de ${fmt(wall)}.`,
    },
    note: "",
  };
}

// ---------------------------------------------------------------------------
// 3. Iron condor
// ---------------------------------------------------------------------------

function condor(put: ZeroDteCreditSpread, call: ZeroDteCreditSpread): ZeroDteIronCondor {
  const credit = round2(put.credit + call.credit);
  const fees = commissionOf(1, 4, false);
  const maxGain = round2(credit * MULT - fees);
  // Solo un lado puede perder al vencimiento: el peor es el de más ancho.
  const maxLoss = round2((Math.max(put.width, call.width) - credit) * MULT + fees);
  return {
    put, call, credit, maxGain, maxLoss,
    beLow: round2(put.shortStrike - credit),
    beHigh: round2(call.shortStrike + credit),
    breakevenWinPct: breakevenWinPct(maxGain, maxLoss) ?? 100,
    rationale: `Vende el rango ${fmt(put.shortStrike)}–${fmt(call.shortStrike)} entre los muros de gamma: gana el crédito si el cierre queda dentro.`,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function gammaOi(l: ZeroDteLeg | null): number {
  return l && l.gamma != null && l.gamma > 0 && l.openInterest > 0 ? l.gamma * l.openInterest : 0;
}

function leg(s: ZeroDteStrike, type: "call" | "put"): ZeroDteLeg | null {
  return type === "call" ? s.call : s.put;
}

/** Strikes con la pata pedida, ordenados de menor a mayor. */
function withLeg(strikes: ZeroDteStrike[], type: "call" | "put"): ZeroDteStrike[] {
  return strikes.filter((s) => leg(s, type) != null).sort((x, y) => x.strike - y.strike);
}

function nearest(strikes: ZeroDteStrike[], target: number): ZeroDteStrike | null {
  let best: ZeroDteStrike | null = null;
  for (const s of strikes) {
    if (!best || Math.abs(s.strike - target) < Math.abs(best.strike - target)) best = s;
  }
  return best;
}

/** Precio real de una pata (> 0) o null: nunca se rellena con el mid. */
function quote(l: ZeroDteLeg | null, side: "bid" | "ask"): number | null {
  const v = l?.[side];
  return v != null && v > 0 ? v : null;
}

function fmt(n: number): string {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toFixed(2);
}
