// Geometría de las gráficas de predicción.
//
// Todo el "dónde va cada píxel" vive aquí, puro y testeable: dominio de precio,
// escalas x/y, rectángulos de las velas y anti-colisión de las etiquetas. El
// componente de dibujo (`PriceChart`) no calcula nada, solo pinta lo que sale de
// estas tres funciones.
//
// Existe porque antes había DOS sistemas de coordenadas peleándose —el canvas de
// lightweight-charts y un overlay HTML que cazaba píxeles con `priceToCoordinate`—
// y de ahí venían el futuro comprimido y los targets encimados.

import type { TfBar } from "./types";

/** Un target por debajo de este peso no deforma el encuadre: es ruido. */
const MIN_TARGET_WEIGHT = 0.02;
/** Las velas nunca ocupan menos de esta fracción del alto, o dejan de leerse. */
const MIN_CANDLE_SHARE = 0.45;
/** Aire arriba y abajo del dominio, en fracción del rango. */
const DOMAIN_PAD = 0.03;

/** Ancho mínimo del cuerpo de una vela para que siga siendo legible. */
const MIN_CANDLE_W = 3;
/** Ancho máximo: con pocas velas, sin tope quedan como columnas de barras. */
const MAX_CANDLE_W = 18;
/** Fracción del slot que ocupa el cuerpo; el resto es separación. */
const BODY_RATIO = 0.7;
/** Alto mínimo del cuerpo, para que un doji no desaparezca. */
const MIN_BODY_H = 1;

// ---------- 1. dominio de precio ----------

export interface PriceDomain {
  min: number;
  max: number;
  /** true si el 2σ no cabía entero y se recortó (el cono se desvanece en el borde). */
  clampedTo2Sigma: boolean;
}

export interface DomainInput {
  bars: TfBar[];
  spot: number;
  sigma1?: { lower: number; upper: number };
  sigma2?: { lower: number; upper: number };
  targets?: { price: number; weight: number }[];
  levels?: { price: number }[];
}

/**
 * Encuadre inteligente.
 *
 * Cubre siempre velas + spot + 1σ + todo nivel que se vaya a dibujar, y luego
 * estira hacia el 2σ solo hasta donde las velas conserven `MIN_CANDLE_SHARE` del
 * alto. Sin ese tope, un ticker volátil deja las velas como una línea plana.
 */
export function smartDomain(input: DomainInput): PriceDomain {
  const { bars, spot, sigma1, sigma2, targets = [], levels = [] } = input;

  let candleMin = Infinity;
  let candleMax = -Infinity;
  for (const b of bars) {
    if (b.low < candleMin) candleMin = b.low;
    if (b.high > candleMax) candleMax = b.high;
  }
  if (!Number.isFinite(candleMin) || !Number.isFinite(candleMax)) {
    // Sin velas nos anclamos al spot para no devolver un dominio degenerado.
    const s = spot > 0 ? spot : 1;
    candleMin = s * 0.95;
    candleMax = s * 1.05;
  }
  const candleRange = Math.max(candleMax - candleMin, 1e-9);

  let min = candleMin;
  let max = candleMax;
  const include = (v: number | undefined) => {
    if (v == null || !Number.isFinite(v) || v <= 0) return;
    if (v < min) min = v;
    if (v > max) max = v;
  };

  include(spot > 0 ? spot : undefined);
  include(sigma1?.lower);
  include(sigma1?.upper);
  for (const t of targets) if (t.weight >= MIN_TARGET_WEIGHT) include(t.price);
  for (const l of levels) include(l.price);

  // Estirar hacia el 2σ, pero solo lo que el tope de legibilidad permita.
  if (sigma2) {
    const maxRange = candleRange / MIN_CANDLE_SHARE;
    const room = Math.max(0, maxRange - (max - min));
    const wantDown = Math.max(0, min - sigma2.lower);
    const wantUp = Math.max(0, sigma2.upper - max);
    const want = wantDown + wantUp;
    if (want > 0) {
      const factor = Math.min(1, room / want);
      min -= wantDown * factor;
      max += wantUp * factor;
    }
  }

  const pad = Math.max((max - min) * DOMAIN_PAD, 1e-9);
  min -= pad;
  max += pad;

  const clampedTo2Sigma = sigma2
    ? min > sigma2.lower + 1e-6 || max < sigma2.upper - 1e-6
    : false;

  return { min, max, clampedTo2Sigma };
}

// ---------- 2. escalas ----------

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Candle {
  /** Borde izquierdo del cuerpo. */
  x: number;
  w: number;
  /** Centro del slot — por donde pasa la mecha. */
  cx: number;
  yOpen: number;
  yClose: number;
  yHigh: number;
  yLow: number;
  up: boolean;
  bar: TfBar;
}

export interface Scales {
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  /** Frontera entre histórico y proyección. */
  xNow: number;
  /** x del centro de la vela `i` del histórico visible. */
  xOfIndex: (i: number) => number;
  /** x de `t` días en el futuro (0 → xNow, horizonDays → plotRight). */
  xOfFuture: (t: number) => number;
  yOfPrice: (p: number) => number;
  /** Precio de una y — para el tooltip del crosshair. */
  priceOfY: (y: number) => number;
  candles: Candle[];
  /** Las barras que realmente se dibujan (las más recientes que caben). */
  visibleBars: TfBar[];
  domain: PriceDomain;
}

export interface ScalesInput {
  bars: TfBar[];
  domain: PriceDomain;
  horizonDays: number;
  width: number;
  height: number;
  padding: Padding;
  /** Fracción del ancho útil reservada al futuro. */
  futureRatio?: number;
}

/**
 * Reparte el lienzo. El `padding.right` no es decoración: es el gutter donde
 * viven los chips de target y el eje de precio. Sin él los chips se dibujaban
 * encima del eje, que era la mitad del amontonamiento.
 */
export function buildScales(input: ScalesInput): Scales {
  const { bars, domain, horizonDays, width, height, padding } = input;
  const futureRatio = Math.min(0.9, Math.max(0, input.futureRatio ?? 0.4));

  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;
  const usableW = Math.max(1, plotRight - plotLeft);
  const usableH = Math.max(1, plotBottom - plotTop);
  const xNow = plotLeft + usableW * (1 - futureRatio);

  const span = Math.max(domain.max - domain.min, 1e-9);
  const yOfPrice = (p: number) => {
    const raw = plotBottom - ((p - domain.min) / span) * usableH;
    return Math.min(plotBottom, Math.max(plotTop, raw));
  };
  const priceOfY = (y: number) =>
    domain.min + ((plotBottom - y) / usableH) * span;

  // Recorte del histórico: solo caben las velas que conserven ancho legible.
  const histW = Math.max(1, xNow - plotLeft);
  const minSlot = MIN_CANDLE_W / BODY_RATIO;
  const maxBars = Math.max(1, Math.floor(histW / minSlot));
  const visibleBars = bars.length > maxBars ? bars.slice(bars.length - maxBars) : bars;

  const n = Math.max(1, visibleBars.length);
  const slot = histW / n;
  const w = Math.min(MAX_CANDLE_W, Math.max(MIN_CANDLE_W, slot * BODY_RATIO));
  const xOfIndex = (i: number) => plotLeft + slot * (i + 0.5);

  const candles: Candle[] = visibleBars.map((bar, i) => {
    const cx = xOfIndex(i);
    let yOpen = yOfPrice(bar.open);
    let yClose = yOfPrice(bar.close);
    if (Math.abs(yClose - yOpen) < MIN_BODY_H) {
      const mid = (yOpen + yClose) / 2;
      yOpen = mid + MIN_BODY_H / 2;
      yClose = mid - MIN_BODY_H / 2;
    }
    return {
      x: cx - w / 2,
      w,
      cx,
      yOpen,
      yClose,
      yHigh: yOfPrice(bar.high),
      yLow: yOfPrice(bar.low),
      up: bar.close >= bar.open,
      bar,
    };
  });

  const futureW = Math.max(0, plotRight - xNow);
  const days = horizonDays > 0 ? horizonDays : 1;
  const xOfFuture = (t: number) =>
    xNow + (Math.min(Math.max(t, 0), days) / days) * futureW;

  return {
    plotLeft, plotRight, plotTop, plotBottom, xNow,
    xOfIndex, xOfFuture, yOfPrice, priceOfY,
    candles, visibleBars, domain,
  };
}

// ---------- 3. anti-colisión de etiquetas ----------

export interface PackOptions {
  top: number;
  bottom: number;
  labelH: number;
  gap: number;
}

export type PackedLabel<T> = T & { y: number; yAnchor: number };

/**
 * Coloca los chips sin que se solapen ni se salgan del área.
 *
 * Dos barridas: la primera empuja hacia abajo lo que colisiona, la segunda
 * recoge desde el fondo en cascada lo que se salió. `yAnchor` guarda el precio
 * real para poder trazar la guía punteada del chip a su nivel.
 */
export function packLabels<T extends { y: number }>(
  items: T[],
  opts: PackOptions,
): PackedLabel<T>[] {
  const { top, bottom, labelH, gap } = opts;
  if (items.length === 0) return [];

  const pitch = labelH + gap;
  const minY = top + labelH / 2;
  const maxY = bottom - labelH / 2;

  const work = items
    .map((item, idx) => ({ idx, y: item.y, yAnchor: item.y }))
    .sort((a, b) => a.y - b.y);

  // Hacia abajo: nadie pisa al anterior.
  for (let i = 0; i < work.length; i++) {
    const floor = i === 0 ? minY : work[i - 1].y + pitch;
    if (work[i].y < floor) work[i].y = floor;
  }

  // Hacia arriba: lo que se pasó del fondo arrastra a los de encima.
  for (let i = work.length - 1; i >= 0; i--) {
    if (work[i].y > maxY) work[i].y = maxY;
    if (i > 0 && work[i - 1].y > work[i].y - pitch) {
      work[i - 1].y = work[i].y - pitch;
    }
  }

  // Si ni así cabe (más chips que alto), al menos no salirse por arriba.
  for (const w of work) w.y = Math.max(minY, w.y);

  const out = new Array<PackedLabel<T>>(items.length);
  for (const w of work) {
    out[w.idx] = { ...items[w.idx], y: w.y, yAnchor: w.yAnchor };
  }
  return out;
}
