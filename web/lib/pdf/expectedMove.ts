// Movimiento esperado por desviación estándar + probabilidades por nivel.
//
// Reemplaza a las "burbujas" por dos cosas medibles:
//   1. Un CONO de proyección: hasta dónde puede llegar el precio a 1σ y 2σ.
//   2. Una PROBABILIDAD por nivel de precio, para pintar el heatmap.
//
// Modelo: movimiento browniano geométrico sin deriva (r = 0), que es la convención
// del mercado de opciones para el "expected move". Todo aquí es puro y testeable.

/** Días hábiles al año — el mercado anualiza la IV sobre 365 naturales. */
const DAYS_PER_YEAR = 365;

/** Aproximación de la normal acumulada N(x) (Abramowitz & Stegun 7.1.26, |ε| < 7.5e-8). */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export interface ExpectedMove {
  spot: number;
  iv: number; // decimal (0.55 = 55%)
  days: number;
  /** Desviación estándar del movimiento, en $. */
  sigma: number;
  /** Y en % del spot. */
  sigmaPct: number;
  upper1: number; lower1: number; // ~68% de probabilidad
  upper2: number; lower2: number; // ~95%
}

/**
 * Movimiento esperado a `days` días.
 * σ = S · IV · √(T/365) — la fórmula que usan los brokers para el "expected move".
 * Las bandas usan lognormal (exp) para que el suelo nunca cruce cero.
 */
export function expectedMove(spot: number, iv: number, days: number): ExpectedMove {
  const T = Math.max(days, 0) / DAYS_PER_YEAR;
  const safeIv = Math.max(iv, 0.01);
  const sd = safeIv * Math.sqrt(T); // desviación en log-espacio
  const sigma = spot * sd;
  return {
    spot, iv: safeIv, days,
    sigma,
    sigmaPct: spot > 0 ? (sigma / spot) * 100 : 0,
    upper1: spot * Math.exp(sd), lower1: spot * Math.exp(-sd),
    upper2: spot * Math.exp(2 * sd), lower2: spot * Math.exp(-2 * sd),
  };
}

export interface ConePoint {
  /** Sesiones/días desde hoy. */
  t: number;
  upper1: number; lower1: number;
  upper2: number; lower2: number;
  mid: number;
}

/** Cono de proyección: la banda se abre con √t, no en línea recta. */
export function conePoints(spot: number, iv: number, days: number, steps = 20): ConePoint[] {
  const out: ConePoint[] = [];
  const n = Math.max(1, Math.floor(steps));
  for (let i = 0; i <= n; i++) {
    const t = (days * i) / n;
    const em = expectedMove(spot, iv, t);
    out.push({
      t, mid: spot,
      upper1: em.upper1, lower1: em.lower1,
      upper2: em.upper2, lower2: em.lower2,
    });
  }
  return out;
}

/** P(S_T > K) bajo lognormal sin deriva. */
export function probAbove(spot: number, strike: number, iv: number, days: number): number {
  if (!(spot > 0) || !(strike > 0)) return 0;
  const T = Math.max(days, 0) / DAYS_PER_YEAR;
  const sd = Math.max(iv, 0.01) * Math.sqrt(T);
  if (sd <= 0) return spot > strike ? 1 : 0;
  const d2 = (Math.log(spot / strike) - 0.5 * sd * sd) / sd;
  return normCdf(d2);
}

/** P(el precio termine dentro de [low, high]) al vencimiento del horizonte. */
export function probInBand(spot: number, low: number, high: number, iv: number, days: number): number {
  const a = probAbove(spot, Math.min(low, high), iv, days);
  const b = probAbove(spot, Math.max(low, high), iv, days);
  return Math.max(0, a - b);
}

/**
 * P(el precio TOQUE el nivel en algún momento antes del horizonte).
 * Principio de reflexión: para una barrera, la probabilidad de tocarla es ~2× la
 * de terminar más allá. Por eso un muro cercano se toca mucho más de lo que
 * sugiere la probabilidad de cierre.
 */
export function probTouch(spot: number, strike: number, iv: number, days: number): number {
  if (!(spot > 0) || !(strike > 0)) return 0;
  if (Math.abs(strike - spot) < 1e-9) return 1;
  const beyond = strike > spot
    ? probAbove(spot, strike, iv, days)
    : 1 - probAbove(spot, strike, iv, days);
  return Math.min(1, 2 * beyond);
}

export interface LevelProb {
  strike: number;
  /** Probabilidad estadística de tocar el nivel (0-1). */
  touch: number;
  /** Probabilidad de cerrar en la banda de ese strike (0-1). */
  band: number;
  /** Concentración de dinero del GEX en ese strike (0-1). */
  concentration: number;
  /** Mezcla normalizada estadística × posicionamiento — el peso del heatmap (0-1). */
  magnet: number;
  side: "call" | "put";
  netGex: number;
}

export interface LevelInput {
  strike: number;
  concentration: number;
  side: "call" | "put";
  netGex: number;
}

/**
 * Probabilidad por nivel para el heatmap.
 *
 * No basta la estadística pura: un strike lejano con un muro enorme importa más que
 * uno cercano vacío. Se mezcla la probabilidad de toque con la concentración de
 * dinero (el "imán" del GEX) y se normaliza para que los niveles sumen 100%.
 */
export function levelProbabilities(
  spot: number,
  iv: number,
  days: number,
  levels: LevelInput[],
  bandWidth?: number,
): LevelProb[] {
  if (levels.length === 0 || !(spot > 0)) return [];
  const sorted = [...levels].sort((a, b) => a.strike - b.strike);
  // Ancho de banda = separación típica entre strikes.
  const gaps = sorted.slice(1).map((l, i) => l.strike - sorted[i].strike).filter((g) => g > 0);
  const width = bandWidth ?? (gaps.length ? gaps.sort((a, b) => a - b)[gaps.length >> 1] : spot * 0.01);

  const raw = sorted.map((l) => {
    const touch = probTouch(spot, l.strike, iv, days);
    const band = probInBand(spot, l.strike - width / 2, l.strike + width / 2, iv, days);
    return { ...l, touch, band, magnet: touch * Math.max(l.concentration, 0.01) };
  });

  const total = raw.reduce((s, l) => s + l.magnet, 0);
  return raw
    .map((l) => ({ ...l, magnet: total > 0 ? l.magnet / total : 0 }))
    .sort((a, b) => b.magnet - a.magnet);
}

export interface PredictionPath {
  /** Precio objetivo (nodo imán del GEX, acotado por el cono de 2σ). */
  target: number;
  /** Camino suavizado desde el spot hasta el objetivo. */
  points: { t: number; price: number }[];
  clamped: boolean;
}

/**
 * Ruta esperada hacia el objetivo. Avanza rápido al principio y se aplana al final
 * (raíz cuadrada del tiempo), igual que la difusión real de un precio.
 * Si el objetivo cae fuera del cono de 2σ se recorta: el precio no puede llegar
 * a donde la volatilidad no da.
 */
export function predictionPath(
  spot: number,
  target: number,
  iv: number,
  days: number,
  steps = 12,
): PredictionPath {
  const em = expectedMove(spot, iv, days);
  const clampedTarget = Math.min(Math.max(target, em.lower2), em.upper2);
  const clamped = Math.abs(clampedTarget - target) > 1e-9;
  const n = Math.max(1, Math.floor(steps));
  const points = Array.from({ length: n + 1 }, (_, i) => {
    const frac = i / n;
    return { t: days * frac, price: spot + (clampedTarget - spot) * Math.sqrt(frac) };
  });
  return { target: clampedTarget, points, clamped };
}
