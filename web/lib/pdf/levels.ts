// Soportes y resistencias — cruce de dos fuentes independientes.
//
//   1. PRECIO: dónde el mercado ya reaccionó de verdad (pivotes de las velas
//      diarias, agrupados por cercanía y pesados por cuántas veces y hace cuánto).
//   2. OPCIONES: dónde está el dinero. Según la tabla del Proceso Principal,
//      vender calls = resistencia / "muro"; vender puts = soporte. Se suma el
//      posicionamiento de la cadena (OI · nocional) y el flujo real ejecutado.
//
// Lo que hace fuerte a un nivel es la CONFLUENCIA: que el precio ya haya rebotado
// ahí Y que además haya dinero puesto. Un nivel con las dos cosas pesa mucho más
// que uno con una sola, y por eso el bonus de confluencia es explícito.

export interface LvlBar {
  time: string; // YYYY-MM-DD
  high: number;
  low: number;
  close: number;
}

export interface Pivot {
  price: number;
  time: string;
  kind: "high" | "low";
}

export type LevelKind = "soporte" | "resistencia";

export interface LevelSource {
  /** Veces que el precio reaccionó en ese nivel. */
  touches: number;
  lastTouch: string | null;
  /** Open interest y nocional de la cadena en ese strike. */
  openInterest: number;
  notional: number;
  /** Premium de flujo real que apunta a ese nivel (venta de calls / venta de puts). */
  flowPremium: number;
  /** GEX neto del strike (+ calls / − puts). */
  netGex: number;
}

export interface Level {
  price: number;
  kind: LevelKind;
  /** 0-100 — qué tan fiable es el nivel. */
  strength: number;
  /** Distancia al precio actual, en %. */
  distancePct: number;
  sources: LevelSource;
  /** true si el precio ya lo perforó antes en el otro sentido (soporte roto → resistencia). */
  flipped: boolean;
  /** Por qué existe el nivel, en lenguaje llano. */
  why: string;
}

// ---------- 1. pivotes del precio ----------

/**
 * Swing highs / lows: una vela cuyo máximo (o mínimo) manda sobre las `k` velas
 * de cada lado. Es la definición estándar de pivote y no requiere indicadores.
 */
export function findPivots(bars: LvlBar[], k = 3): Pivot[] {
  const out: Pivot[] = [];
  if (bars.length < k * 2 + 1) return out;
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ price: bars[i].high, time: bars[i].time, kind: "high" });
    if (isLow) out.push({ price: bars[i].low, time: bars[i].time, kind: "low" });
  }
  return out;
}

export interface PivotCluster {
  price: number;
  touches: number;
  lastTouch: string;
  highs: number;
  lows: number;
}

/**
 * Agrupa pivotes que caen casi en el mismo precio. Dos toques a $299 y $301 son
 * el mismo nivel, no dos: `tolerancePct` define cuánto es "casi".
 */
export function clusterPivots(pivots: Pivot[], tolerancePct = 1): PivotCluster[] {
  if (pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  let current: Pivot[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const ref = current[0].price;
    if (Math.abs(sorted[i].price - ref) / ref * 100 <= tolerancePct) current.push(sorted[i]);
    else { clusters.push(current); current = [sorted[i]]; }
  }
  clusters.push(current);

  return clusters.map((c) => ({
    price: c.reduce((s, p) => s + p.price, 0) / c.length,
    touches: c.length,
    lastTouch: c.reduce((m, p) => (p.time > m ? p.time : m), c[0].time),
    highs: c.filter((p) => p.kind === "high").length,
    lows: c.filter((p) => p.kind === "low").length,
  }));
}

// ---------- 2. entradas de opciones ----------

export interface ChainLevel {
  strike: number;
  contractType: "call" | "put";
  openInterest: number;
  notionalValue: number;
}

export interface FlowLevel {
  strike: number | null;
  type: "call" | "put" | "unknown";
  aggression: string; // "ask" = comprado · "bid" = vendido
  premium: number;
}

export interface GexLevel {
  strike: number;
  netGex: number;
}

// ---------- 3. mezcla y puntuación ----------

const DAY = 86_400_000;

/** Peso por frescura del último toque: lo de hace un año ya no manda igual. */
export function recencyFactor(lastTouch: string, now: Date): number {
  const days = (now.getTime() - new Date(`${lastTouch}T21:00:00Z`).getTime()) / DAY;
  if (!Number.isFinite(days) || days < 0) return 1;
  if (days <= 30) return 1;
  if (days <= 90) return 0.75;
  if (days <= 180) return 0.5;
  return 0.3;
}

export interface LevelsInput {
  bars: LvlBar[];
  spot: number;
  chain?: ChainLevel[];
  flows?: FlowLevel[];
  gex?: GexLevel[];
  now: Date;
  /** Ancho de agrupación en % del precio. */
  tolerancePct?: number;
  /** Solo niveles dentro de ±rangePct del spot (más allá no operan). */
  rangePct?: number;
}

export interface LevelsReport {
  spot: number;
  supports: Level[];    // más cercano primero
  resistances: Level[]; // más cercano primero
  /** El soporte y la resistencia más fuertes, para el resumen. */
  keySupport: Level | null;
  keyResistance: Level | null;
  tolerancePct: number;
}

const EMPTY: LevelsReport = {
  spot: 0, supports: [], resistances: [],
  keySupport: null, keyResistance: null, tolerancePct: 1,
};

export function findLevels(input: LevelsInput): LevelsReport {
  const {
    bars, spot, chain = [], flows = [], gex = [], now,
    tolerancePct = 1, rangePct = 25,
  } = input;
  if (!(spot > 0) || bars.length === 0) return EMPTY;

  const near = (a: number, b: number) => Math.abs(a - b) / spot * 100 <= tolerancePct;
  const clusters = clusterPivots(findPivots(bars), tolerancePct)
    .filter((c) => Math.abs(c.price - spot) / spot * 100 <= rangePct);

  // Strikes de opciones relevantes que aún no tienen pivote de precio: también
  // son niveles, aunque el precio nunca haya reaccionado ahí todavía.
  const optionStrikes = new Set<number>();
  for (const c of chain) {
    if (Math.abs(c.strike - spot) / spot * 100 <= rangePct) optionStrikes.add(c.strike);
  }

  const candidates: { price: number; cluster: PivotCluster | null }[] = clusters.map((c) => ({
    price: c.price, cluster: c,
  }));
  for (const strike of optionStrikes) {
    if (!candidates.some((c) => near(c.price, strike))) {
      candidates.push({ price: strike, cluster: null });
    }
  }

  const maxTouches = Math.max(1, ...clusters.map((c) => c.touches));

  // Umbral de tamaño para los strikes SIN rebote previo: si no, cualquier strike
  // de la cadena con OI residual se colaría como "nivel" y llenaría la lista de ruido.
  const alignedOi = candidates.map((cand) => {
    const kind: LevelKind = cand.price < spot ? "soporte" : "resistencia";
    let oi = 0;
    for (const c of chain) {
      if (!near(c.strike, cand.price)) continue;
      const aligned = kind === "resistencia" ? c.contractType === "call" : c.contractType === "put";
      if (aligned) oi += c.openInterest;
    }
    return oi;
  }).filter((v) => v > 0).sort((a, b) => a - b);
  const oiFloor = alignedOi.length
    ? alignedOi[Math.floor(alignedOi.length * 0.7)] // percentil 70
    : 0;

  const levels: Level[] = [];

  for (const cand of candidates) {
    const kind: LevelKind = cand.price < spot ? "soporte" : "resistencia";

    // --- cadena de opciones en ese nivel ---
    let oi = 0, notional = 0;
    for (const c of chain) {
      if (!near(c.strike, cand.price)) continue;
      // Vender calls sostiene una resistencia; vender puts sostiene un soporte.
      const aligned = kind === "resistencia" ? c.contractType === "call" : c.contractType === "put";
      if (!aligned) continue;
      oi += c.openInterest;
      notional += c.notionalValue;
    }

    // --- flujo real ejecutado que apunta a ese nivel ---
    let flowPremium = 0;
    for (const f of flows) {
      if (f.strike == null || !near(f.strike, cand.price)) continue;
      const sold = f.aggression === "bid";
      if (!sold) continue; // solo la VENTA construye muro
      if (kind === "resistencia" && f.type === "call") flowPremium += f.premium;
      if (kind === "soporte" && f.type === "put") flowPremium += f.premium;
    }

    // --- gamma del dealer ---
    let netGex = 0;
    for (const g of gex) if (near(g.strike, cand.price)) netGex += g.netGex;

    const touches = cand.cluster?.touches ?? 0;

    // Un strike donde el precio nunca reaccionó solo cuenta si el dinero es grande.
    if (touches === 0 && flowPremium === 0 && oi < oiFloor) continue;

    const lastTouch = cand.cluster?.lastTouch ?? null;
    const recency = lastTouch ? recencyFactor(lastTouch, now) : 0;

    // --- puntuación 0-100 ---
    const pTouch = Math.min(1, touches / Math.max(2, maxTouches)) * 35 * (0.4 + 0.6 * recency);
    const pOi = oi > 0 ? Math.min(1, Math.log10(1 + oi) / 5) * 25 : 0;
    const pFlow = flowPremium > 0 ? Math.min(1, Math.log10(1 + flowPremium) / 8) * 20 : 0;
    const pGex = Math.min(1, Math.abs(netGex) / 5e8) * 10;
    // Confluencia: precio Y opciones a la vez. Es el bonus que separa un nivel
    // real de una coincidencia.
    const confluence = touches > 0 && (oi > 0 || flowPremium > 0) ? 10 : 0;

    const strength = Math.round(Math.min(100, pTouch + pOi + pFlow + pGex + confluence));
    if (strength < 8) continue; // ruido

    // Nivel "flipeado": tocado antes como techo y ahora actúa de suelo (o al revés).
    const flipped = cand.cluster
      ? (kind === "soporte" && cand.cluster.highs > cand.cluster.lows) ||
        (kind === "resistencia" && cand.cluster.lows > cand.cluster.highs)
      : false;

    const parts: string[] = [];
    if (touches > 0) parts.push(`el precio reaccionó ${touches} ${touches === 1 ? "vez" : "veces"} aquí`);
    if (oi > 0) parts.push(`${Math.round(oi).toLocaleString("en-US")} contratos abiertos de ${kind === "resistencia" ? "calls" : "puts"}`);
    if (flowPremium > 0) parts.push(`venta de ${kind === "resistencia" ? "calls" : "puts"} por dinero real`);
    if (confluence > 0) parts.push("confluencia precio + opciones");
    if (parts.length === 0) parts.push("posicionamiento de la cadena");

    levels.push({
      price: cand.price,
      kind,
      strength,
      distancePct: ((cand.price - spot) / spot) * 100,
      sources: { touches, lastTouch, openInterest: oi, notional, flowPremium, netGex },
      flipped,
      why: parts.join(" · "),
    });
  }

  const supports = levels
    .filter((l) => l.kind === "soporte")
    .sort((a, b) => b.price - a.price); // el más cercano por debajo primero
  const resistances = levels
    .filter((l) => l.kind === "resistencia")
    .sort((a, b) => a.price - b.price); // el más cercano por encima primero

  const strongest = (xs: Level[]) =>
    xs.length ? xs.reduce((m, l) => (l.strength > m.strength ? l : m), xs[0]) : null;

  return {
    spot,
    supports: supports.slice(0, 6),
    resistances: resistances.slice(0, 6),
    keySupport: strongest(supports),
    keyResistance: strongest(resistances),
    tolerancePct,
  };
}
