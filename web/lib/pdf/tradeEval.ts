// Evaluación comparativa de TRADES: el "Mejor trade ahora" (original, fade al
// pin en γ+) vs el "Trade alterno" (γ+ = igual; γ− = momentum). Cada minuto se
// registra la señal activa de cada uno (dirección + target + stop). Después
// se RESUELVE cada trade siguiendo el spot hacia adelante: gana si toca el
// target antes que el stop, pierde si toca el stop primero. Las dos solo
// difieren en γ− (momentum). PURA.

export type Dir = "long" | "short";

/** Señal de trade en un snapshot (o null si no hay setup ese minuto). */
export interface TradeSig {
  d: Dir;
  tgt: number;
  stop: number;
  m?: boolean; // true = trade de momentum γ− (solo la alterna lo toma)
}

/** Un snapshot del minuto: spot + la señal de cada lado. */
export interface TradeSnap {
  sec: number;
  spot: number;
  o: TradeSig | null; // original (fade al pin, γ+)
  a: TradeSig | null; // alterna (γ+ = o; γ− = momentum)
}

interface OpenTrade { openSec: number; d: Dir; tgt: number; stop: number; m: boolean }

// ¿Es la MISMA señal que la previa? (misma dirección y target ≈ igual). Un
// cambio de target/dirección o que aparezca tras un null = trade NUEVO.
function sameSig(a: TradeSig | null, b: TradeSig | null): boolean {
  return !!a && !!b && a.d === b.d && Math.abs(a.tgt - b.tgt) <= 1;
}

/** Extrae los trades distintos de un lado: uno por cada racha de señal igual. */
function extractTrades(snaps: TradeSnap[], side: "o" | "a"): OpenTrade[] {
  const out: OpenTrade[] = [];
  let prev: TradeSig | null = null;
  for (const s of snaps) {
    const sig = s[side];
    if (sig && !sameSig(prev, sig)) out.push({ openSec: s.sec, d: sig.d, tgt: sig.tgt, stop: sig.stop, m: !!sig.m });
    prev = sig;
  }
  return out;
}

/** Resuelve un trade siguiendo el spot hacia adelante: win (target) / loss (stop) / open (sin resolver). */
function resolve(t: OpenTrade, snaps: TradeSnap[]): "win" | "loss" | "open" {
  for (const s of snaps) {
    if (s.sec <= t.openSec) continue; // solo hacia adelante
    if (t.d === "long") {
      if (s.spot >= t.tgt) return "win";
      if (s.spot <= t.stop) return "loss";
    } else {
      if (s.spot <= t.tgt) return "win";
      if (s.spot >= t.stop) return "loss";
    }
  }
  return "open";
}

export interface TradeEvalResult {
  origResolved: number; origWins: number; origRate: number | null;
  altResolved: number;  altWins: number;  altRate: number | null;
  differed: number;     // trades de momentum γ− (que la original NO tomó) resueltos
  differedWon: number;  // de esos, cuántos ganaron
}

export function evalTrades(snaps: TradeSnap[]): TradeEvalResult {
  const s = [...snaps].sort((a, b) => a.sec - b.sec);
  const score = (side: "o" | "a") => {
    let resolved = 0, wins = 0, differed = 0, differedWon = 0;
    for (const t of extractTrades(s, side)) {
      const r = resolve(t, s);
      if (r === "open") continue;
      resolved++;
      if (r === "win") wins++;
      if (side === "a" && t.m) { differed++; if (r === "win") differedWon++; }
    }
    return { resolved, wins, differed, differedWon };
  };
  const o = score("o"), a = score("a");
  return {
    origResolved: o.resolved, origWins: o.wins, origRate: o.resolved ? (o.wins / o.resolved) * 100 : null,
    altResolved: a.resolved,  altWins: a.wins,  altRate: a.resolved ? (a.wins / a.resolved) * 100 : null,
    differed: a.differed, differedWon: a.differedWon,
  };
}
