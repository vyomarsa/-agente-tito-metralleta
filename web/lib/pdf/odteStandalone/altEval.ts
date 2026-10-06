// Evaluación comparativa: original vs alterna del "next 5 min". Se registra el
// lean de las dos en cada refresco (con el spot del momento); ~5 min después se
// compara contra el movimiento REAL para ver cuál acertó la dirección. PURA.

export type L = "alcista" | "bajista" | "lateral";

/** Un snapshot registrado (claves cortas para achicar el archivo). */
export interface AltSnap {
  sec: number;   // epoch en segundos
  spot: number;
  ol: L;         // lean original (GEX)
  al: L;         // lean alterna (GEX + flujo)
  w?: number;    // peso del flujo en ese momento
}

/** Dirección real entre dos precios, con umbral en puntos (dentro = lateral). */
export function actualMove(from: number, to: number, thresh: number): L {
  const d = to - from;
  return d > thresh ? "alcista" : d < -thresh ? "bajista" : "lateral";
}

export interface AltEvalResult {
  n: number;                 // predicciones maduradas (con par a ~horizonte)
  origHits: number;
  altHits: number;
  origRate: number | null;   // % acierto direccional original
  altRate: number | null;    // % acierto direccional alterna
  bothActive: number;        // veces donde la alterna difirió de la original (w tuvo efecto)
  altBetterWhenActive: number; // de esas, cuántas la alterna acertó y la original no
}

/**
 * Evalúa la serie: por cada snapshot busca el que esté ~`horizonSec` después
 * (± `tolSec`) y compara su spot. Puntúa cada lean contra el movimiento real.
 */
export function evalSnaps(
  snaps: AltSnap[],
  horizonSec = 300,
  tolSec = 90,
  threshFrac = 0.0004, // 0.04% del spot (~3 pts en SPX) para separar lateral de direccional
): AltEvalResult {
  const s = [...snaps].sort((a, b) => a.sec - b.sec);
  let origHits = 0, altHits = 0, n = 0, bothActive = 0, altBetterWhenActive = 0;
  for (let i = 0; i < s.length; i++) {
    const target = s[i].sec + horizonSec;
    let best: AltSnap | null = null, bestDiff = Infinity;
    for (let j = i + 1; j < s.length; j++) {
      const diff = Math.abs(s[j].sec - target);
      if (diff < bestDiff) { bestDiff = diff; best = s[j]; }
      if (s[j].sec > target + tolSec) break;
    }
    if (!best || bestDiff > tolSec) continue;
    const thresh = s[i].spot * threshFrac;
    const actual = actualMove(s[i].spot, best.spot, thresh);
    n++;
    const oOk = s[i].ol === actual, aOk = s[i].al === actual;
    if (oOk) origHits++;
    if (aOk) altHits++;
    if (s[i].al !== s[i].ol) { // la alterna se apartó de la original (el flujo cambió la lectura)
      bothActive++;
      if (aOk && !oOk) altBetterWhenActive++;
    }
  }
  return {
    n, origHits, altHits,
    origRate: n ? (origHits / n) * 100 : null,
    altRate: n ? (altHits / n) * 100 : null,
    bothActive, altBetterWhenActive,
  };
}
