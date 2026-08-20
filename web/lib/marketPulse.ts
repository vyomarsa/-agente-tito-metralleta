// ============================================================================
// PULSO DEL MERCADO — dos medidores para la barra lateral:
//   1. VIX, con las bandas de interpretación de nivel.
//   2. Sentimiento del mercado 0-100 estilo "miedo y codicia".
//
// IMPORTANTE — el sentimiento es NUESTRO, no el de CNN. El índice Fear & Greed de
// CNN no se puede consumir: su endpoint bloquea el acceso automatizado a propósito
// (responde 418 "You're a bot"). Así que en vez de copiar un número ajeno se calcula
// uno con las fuentes que el agente YA tiene, y la tarjeta enseña de qué se compone
// para que nunca sea una caja negra:
//
//   · VOLATILIDAD  — el VIX (Schwab, que sí cotiza índices).
//   · MOMENTO      — SPY contra su media de 125 sesiones (el mismo criterio de
//                    momento que usa CNN).
//   · PUT/CALL     — reparto de la PRIMA REAL ejecutada hoy en todo el mercado
//                    (MarketSnack). Mejor que un put/call de volumen pelado: aquí
//                    se sabe quién cruzó el spread.
//
// Todo aquí es PURO y testeable (tests en marketPulse.test.ts). La I/O vive en
// app/api/market-pulse/route.ts.
// ============================================================================

// ---------------------------------------------------------------------------
// VIX — bandas de interpretación de nivel
// ---------------------------------------------------------------------------

export type VixBand = "complacencia" | "normal" | "incertidumbre" | "miedo" | "crisis";

export interface VixState {
  band: VixBand;
  /** Etiqueta corta para el medidor. */
  label: string;
  /** Qué significa ese nivel, en una línea. */
  meaning: string;
}

/** Cortes de las bandas del VIX (los del cuadro de interpretación de nivel). */
export const VIX_BREAKS = [12, 20, 30, 40] as const;

/** Clasifica un nivel de VIX. PURA. */
export function vixState(vix: number): VixState {
  if (vix < VIX_BREAKS[0]) {
    return { band: "complacencia", label: "Complacencia extrema", meaning: "Nadie paga por cobertura; el mercado se confía." };
  }
  if (vix < VIX_BREAKS[1]) {
    return { band: "normal", label: "Condiciones normales", meaning: "Volatilidad dentro de lo corriente." };
  }
  if (vix < VIX_BREAKS[2]) {
    return { band: "incertidumbre", label: "Incertidumbre elevada", meaning: "El mercado empieza a pagar por protegerse." };
  }
  if (vix < VIX_BREAKS[3]) {
    return { band: "miedo", label: "Miedo alto", meaning: "Cobertura cara: hay nervios de verdad." };
  }
  return { band: "crisis", label: "Miedo extremo / crisis", meaning: "Pánico. Los movimientos diarios se disparan." };
}

/**
 * Escala del medidor del VIX: dónde cae el nivel en el arco, 0-1. El arco llega
 * hasta 50 porque por encima de ahí la aguja ya está clavada al fondo y estirar la
 * escala solo aplastaría el rango donde el VIX vive el 99% del tiempo.
 */
export const VIX_GAUGE_MAX = 50;
export function vixGaugePos(vix: number): number {
  return Math.min(1, Math.max(0, vix / VIX_GAUGE_MAX));
}

// ---------------------------------------------------------------------------
// Sentimiento 0-100 (0 = miedo extremo, 100 = codicia extrema)
// ---------------------------------------------------------------------------

export type SentimentBand = "miedo_extremo" | "miedo" | "neutral" | "codicia" | "codicia_extrema";

export interface SentimentBandInfo {
  band: SentimentBand;
  label: string;
}

/**
 * Bandas estándar del índice de miedo y codicia. OJO: circula por internet un
 * gráfico (public.com) con estas mismas cifras pero las etiquetas descolocadas
 * —pone "45-55 miedo extremo" y "0-24 miedo"—, que no tiene sentido: 0-24 es el
 * extremo, no 45-55. Aquí van en el orden correcto.
 */
export function sentimentBandOf(score: number): SentimentBandInfo {
  if (score <= 24) return { band: "miedo_extremo", label: "Miedo extremo" };
  if (score <= 44) return { band: "miedo", label: "Miedo" };
  if (score <= 55) return { band: "neutral", label: "Neutral" };
  if (score <= 75) return { band: "codicia", label: "Codicia" };
  return { band: "codicia_extrema", label: "Codicia extrema" };
}

/** Interpolación lineal sobre una tabla de anclajes ordenada por `x`. PURA. */
function interpolate(points: { x: number; y: number }[], x: number): number {
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return last.y;
}

const clamp100 = (n: number) => Math.min(100, Math.max(0, n));

/**
 * VIX → codicia 0-100. Va INVERTIDO: VIX bajo = complacencia = codicia. Los
 * anclajes son los mismos cortes del cuadro de interpretación, así que el medidor
 * de sentimiento y el del VIX nunca se contradicen.
 */
const VIX_ANCHORS = [
  { x: 10, y: 100 }, { x: 12, y: 88 }, { x: 20, y: 60 },
  { x: 30, y: 35 }, { x: 40, y: 12 }, { x: 55, y: 0 },
];
export function vixToGreed(vix: number): number {
  return clamp100(interpolate(VIX_ANCHORS, vix));
}

/**
 * Momento: cuánto se separa el precio de su media de 125 sesiones, en %.
 * −10% o peor = miedo extremo; +10% o mejor = codicia extrema; en la media, 50.
 */
export const MOMENTUM_SPAN_PCT = 10;
export function momentumToGreed(price: number, sma125: number): number | null {
  if (!(price > 0) || !(sma125 > 0)) return null;
  const deviation = ((price - sma125) / sma125) * 100;
  return clamp100(50 + (deviation / MOMENTUM_SPAN_PCT) * 50);
}

/**
 * Reparto de la prima real: qué parte del dinero ejecutado hoy se fue a PUTS.
 * Mucha prima en puts = cobertura = miedo. El punto neutro es el 50% y la banda
 * se abre ±15 puntos, que es donde este reparto se mueve en la práctica.
 */
export const PUTCALL_SPAN = 0.15;
export function putCallToGreed(callPremium: number, putPremium: number): number | null {
  const total = callPremium + putPremium;
  if (!(total > 0)) return null;
  const putShare = putPremium / total;
  // putShare 0.35 → 100 (codicia) · 0.50 → 50 · 0.65 → 0 (miedo)
  return clamp100(50 - ((putShare - 0.5) / PUTCALL_SPAN) * 50);
}

export interface PulseComponent {
  key: "volatilidad" | "momento" | "putcall";
  label: string;
  /** Aportación 0-100 en la escala de codicia (null = sin dato). */
  score: number | null;
  /** El dato crudo, para que la tarjeta pueda enseñarlo. */
  detail: string;
  weight: number;
}

export interface MarketSentiment {
  /** 0-100. null si no había NINGÚN componente. */
  score: number | null;
  band: SentimentBandInfo | null;
  components: PulseComponent[];
  /** Cuántos de los 3 componentes tenían dato. */
  available: number;
}

/** Pesos de la mezcla. La volatilidad manda porque es la señal más directa. */
export const PULSE_WEIGHTS = { volatilidad: 0.4, momento: 0.35, putcall: 0.25 } as const;

/**
 * Mezcla los componentes disponibles en un 0-100. Si falta alguno, los pesos se
 * RENORMALIZAN sobre los que sí hay — nunca se rellena un hueco con un 50 inventado,
 * que sesgaría el índice hacia el centro y taparía que falta información.
 */
export function marketSentiment(components: PulseComponent[]): MarketSentiment {
  const withData = components.filter((c) => c.score != null);
  if (withData.length === 0) {
    return { score: null, band: null, components, available: 0 };
  }
  const totalWeight = withData.reduce((s, c) => s + c.weight, 0);
  const score = Math.round(
    withData.reduce((s, c) => s + (c.score as number) * c.weight, 0) / totalWeight,
  );
  return { score, band: sentimentBandOf(score), components, available: withData.length };
}

/** Arma los 3 componentes a partir de los datos crudos. PURA. */
export function buildPulseComponents(input: {
  vix: number | null;
  spyPrice: number | null;
  spySma125: number | null;
  callPremium: number;
  putPremium: number;
}): PulseComponent[] {
  const { vix, spyPrice, spySma125, callPremium, putPremium } = input;

  const momentum = spyPrice != null && spySma125 != null
    ? momentumToGreed(spyPrice, spySma125)
    : null;
  const deviationPct = spyPrice != null && spySma125 != null && spySma125 > 0
    ? ((spyPrice - spySma125) / spySma125) * 100
    : null;

  const putCall = putCallToGreed(callPremium, putPremium);
  const total = callPremium + putPremium;
  const putShare = total > 0 ? (putPremium / total) * 100 : null;

  return [
    {
      key: "volatilidad",
      label: "Volatilidad (VIX)",
      score: vix != null ? vixToGreed(vix) : null,
      detail: vix != null ? `VIX ${vix.toFixed(2)} — ${vixState(vix).label.toLowerCase()}` : "sin dato del VIX",
      weight: PULSE_WEIGHTS.volatilidad,
    },
    {
      key: "momento",
      label: "Momento (SPY vs media 125)",
      score: momentum,
      detail: deviationPct != null
        ? `${deviationPct >= 0 ? "+" : ""}${deviationPct.toFixed(1)}% sobre su media de 125 sesiones`
        : "sin barras suficientes",
      weight: PULSE_WEIGHTS.momento,
    },
    {
      key: "putcall",
      label: "Prima put/call del mercado",
      score: putCall,
      detail: putShare != null
        ? `${putShare.toFixed(0)}% de la prima ejecutada hoy se fue a puts`
        : "sin flujo del mercado",
      weight: PULSE_WEIGHTS.putcall,
    },
  ];
}
