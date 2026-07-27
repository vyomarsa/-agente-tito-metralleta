// Normalizador PURO de la "Option Chain 2.0" de MarketSnack.
// Endpoint: /api/assets/{TICKER}/option_chain_extended?expiration_date=YYYY-MM-DD
// A diferencia de Massive, ESTA fuente sí trae greeks reales (delta/gamma/theta/vega),
// IV real (en decimal) y el MID ya calculado por contrato. Ver marketsnack.ts para el fetch.
// Tests en optionChain2.test.ts.

/** Contrato crudo tal como lo devuelve MarketSnack (un elemento del array). */
export interface Chain2RawContract {
  exercise_style?: string;
  expiration: string;
  greeks?: {
    delta?: number | null;
    gamma?: number | null;
    theta?: number | null;
    vega?: number | null;
  };
  implied_volatility?: number | null; // DECIMAL (0.168 = 16.8%), no porcentaje
  last_quote?: {
    bid?: number | null;
    ask?: number | null;
    mid?: number | null;
  };
  last_unusual_trade?: unknown | null;
  legs_premium?: { single?: number; multi?: number; other?: number };
  open_interest?: number | null;
  premium_breakdown?: { bid?: number; mid?: number; ask?: number };
  premium_traded?: number | null;
  price?: number | null;
  price_change?: { percentage?: number | null; absolute?: number | null };
  settlement_type?: string;
  shares_per_contract?: number;
  strike: number;
  symbol: string;
  type: "call" | "put";
  volume?: number | null;
}

/** Contrato normalizado: nombres cortos, nulls saneados, listo para el resto de `lib/`. */
export interface Chain2Contract {
  symbol: string;
  type: "call" | "put";
  strike: number;
  expiration: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** delta ya firmado por MarketSnack (call +, put −). null si no hay datos. */
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** IV en decimal (0.168 = 16.8%). null si el contrato no tiene datos. */
  iv: number | null;
  openInterest: number;
  volume: number;
  premiumTraded: number;
  lastPrice: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nonNeg(v: unknown): number {
  const n = num(v);
  return n != null && n >= 0 ? n : 0;
}

/**
 * Normaliza un contrato crudo. `greeks` puede llegar como `{}` (deep ITM / sin datos):
 * en ese caso delta/gamma/theta/vega quedan en null y el consumidor decide si lo descarta.
 */
export function normalizeChain2Contract(raw: Chain2RawContract): Chain2Contract {
  const g = raw.greeks ?? {};
  const q = raw.last_quote ?? {};
  return {
    symbol: raw.symbol,
    type: raw.type,
    strike: raw.strike,
    expiration: raw.expiration,
    bid: num(q.bid),
    ask: num(q.ask),
    mid: num(q.mid),
    delta: num(g.delta),
    gamma: num(g.gamma),
    theta: num(g.theta),
    vega: num(g.vega),
    iv: num(raw.implied_volatility),
    openInterest: nonNeg(raw.open_interest),
    volume: nonNeg(raw.volume),
    premiumTraded: nonNeg(raw.premium_traded),
    lastPrice: num(raw.price),
  };
}

/** Normaliza el array completo, descartando entradas sin symbol/strike válidos. */
export function normalizeChain2(raw: Chain2RawContract[]): Chain2Contract[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.symbol === "string" && typeof c.strike === "number")
    .map(normalizeChain2Contract);
}

export interface StrikeGex {
  strike: number;
  /** GEX neto del strike (calls +, puts −), en $ por 1% de movimiento. */
  gex: number;
  callGamma: number;
  putGamma: number;
}

/**
 * Gamma Exposure REAL por strike, usando la gamma de MarketSnack (no Black-Scholes).
 * GEX = Σ gamma × OI × 100 × spot² × 0.01, con signo + para calls y − para puts.
 * Es la misma fórmula que `lib/gex.ts` pero anclada a gamma real en TODOS los strikes,
 * no solo donde hubo trade. Devuelve los strikes ordenados de menor a mayor.
 */
export function gexByStrike(contracts: Chain2Contract[], spot: number): StrikeGex[] {
  if (!(spot > 0)) return [];
  const factor = 100 * spot * spot * 0.01;
  const byStrike = new Map<number, StrikeGex>();
  for (const c of contracts) {
    if (c.gamma == null || c.openInterest <= 0) continue;
    const contribution = c.gamma * c.openInterest * factor;
    const entry =
      byStrike.get(c.strike) ??
      { strike: c.strike, gex: 0, callGamma: 0, putGamma: 0 };
    if (c.type === "call") {
      entry.gex += contribution;
      entry.callGamma += c.gamma * c.openInterest;
    } else {
      entry.gex -= contribution;
      entry.putGamma += c.gamma * c.openInterest;
    }
    byStrike.set(c.strike, entry);
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

/** GEX total de la cadena (suma de todos los strikes). >0 = régimen γ+ (revierte). */
export function totalGex(strikes: StrikeGex[]): number {
  return strikes.reduce((sum, s) => sum + s.gex, 0);
}

/** Greek real por contrato (gamma + IV en decimal), tal como lo consumen gex.ts / gexHeatmap.ts. */
export interface RealGreek {
  gamma: number;
  iv: number;
}

/**
 * Construye el mapa de greeks REALES por contrato que `gexAnalysis`/`gexHeatmap`
 * esperan como override de la estimación Black-Scholes. La clave es
 * `${strike}|${expiration}|${type}` (idéntica a `schwabKey` de gex.ts) para que la
 * cadena de MarketSnack entre por el mismo carril que la de Schwab. Solo incluye
 * contratos con gamma o IV utilizable (los `greeks: {}` deep-OTM se descartan).
 */
export function realGreeksMap(contracts: Chain2Contract[]): Record<string, RealGreek> {
  const out: Record<string, RealGreek> = {};
  for (const c of contracts) {
    const gamma = c.gamma != null && c.gamma > 0 ? c.gamma : null;
    const iv = c.iv != null && c.iv > 0 ? c.iv : null;
    if (gamma == null && iv == null) continue;
    out[`${c.strike}|${c.expiration}|${c.type}`] = { gamma: gamma ?? 0, iv: iv ?? 0 };
  }
  return out;
}

// ---------- superficie de IV de la cadena completa (para el Contexto IV) ----------

/** IV agregada de un vencimiento a partir de TODA la cadena (no solo lo que operó). */
export interface ChainIvExpStat {
  expiration: string;
  dte: number | null;
  /** Contratos con IV utilizable en ese vencimiento. */
  contracts: number;
  /** IV media simple, en PORCENTAJE (0.17 → 17). */
  avgIv: number;
  /** IV máxima del vencimiento, en porcentaje. */
  maxIv: number;
  /** Prima abierta usada como peso (Σ OI × mid). */
  premium: number;
}

/**
 * Superficie de IV de la cadena completa, en las mismas unidades (%) que usa
 * `ivContextScore`. A diferencia del flujo (solo contratos que OPERARON hoy),
 * esto mira TODA la cadena, así que la IV por vencimiento es mucho más estable.
 */
export interface ChainIvSurface {
  /** IV representativa ponderada por prima abierta (OI × mid), en porcentaje. */
  current: number | null;
  byExpiration: ChainIvExpStat[];
}

/**
 * Calcula la superficie de IV a partir de contratos normalizados de la cadena.
 * `now` sirve solo para el DTE de cada vencimiento. La IV sale en PORCENTAJE para
 * encajar directamente en el motor de Contexto IV (que trabaja en %).
 */
/**
 * Tope de cordura para la IV de un contrato (decimal). Por encima de esto es
 * ruido del solver, no volatilidad real: pasa en 0DTE y en contratos deep-OTM
 * casi sin bid. 300% es holgado incluso para memes en earnings.
 */
export const MAX_SANE_IV = 3.0;

export function chainIvSurface(contracts: Chain2Contract[], now: Date = new Date()): ChainIvSurface {
  // Filtra: (1) sin IV utilizable; (2) IV absurda (ruido del solver); (3) el
  // vencimiento de HOY o ya expirado — al no quedar tiempo, la IV del 0DTE se
  // dispara (se vieron 300%+ en MSFT) y, como pesa por prima abierta, contaminaba
  // la IV representativa de TODA la cadena. Aplica a cualquier ticker.
  const withIv = contracts.filter(
    (c) => c.iv != null && c.iv > 0 && c.iv <= MAX_SANE_IV && dteOf(c.expiration, now) > 0,
  );
  if (withIv.length === 0) return { current: null, byExpiration: [] };

  // Peso = prima abierta (OI × mid). Emphasiza los strikes líquidos, que es
  // donde de verdad vive la IV de referencia de la cadena.
  const weightOf = (c: Chain2Contract) =>
    Math.max(c.openInterest * (c.mid ?? 0), 1);

  // ATM = cerca del dinero (|delta| ~ 0.5). La IV "de referencia" de un subyacente
  // es la ATM; las alas OTM cotizan con skew (IV muy alta) e inflan cualquier
  // promedio simple. Usamos el delta (no el spot, que el payload no trae) para
  // centrar el cálculo. Si ningún contrato trae delta, cae a toda la cadena.
  const isAtm = (c: Chain2Contract) =>
    c.delta != null && Math.abs(c.delta) >= 0.35 && Math.abs(c.delta) <= 0.65;
  const atmPool = withIv.filter(isAtm);
  const pool = atmPool.length > 0 ? atmPool : withIv;

  // IV representativa (current): ponderada por prima abierta sobre el pool ATM.
  let wSum = 0, wIv = 0;
  for (const c of pool) {
    const w = weightOf(c);
    wSum += w; wIv += (c.iv as number) * 100 * w;
  }

  // Por vencimiento: la IV media también se toma cerca del dinero (atmIvs) para
  // que la fila refleje el ATM, no el skew de las alas; maxIv y el conteo siguen
  // sobre TODA la cadena de ese vencimiento.
  const byExpMap = new Map<string, { atmIvs: number[]; allIvs: number[]; premium: number }>();
  for (const c of withIv) {
    const ivPct = (c.iv as number) * 100;
    const e = byExpMap.get(c.expiration) ?? { atmIvs: [], allIvs: [], premium: 0 };
    e.allIvs.push(ivPct);
    if (isAtm(c)) e.atmIvs.push(ivPct);
    e.premium += c.openInterest * (c.mid ?? 0);
    byExpMap.set(c.expiration, e);
  }

  const byExpiration: ChainIvExpStat[] = [...byExpMap.entries()]
    .map(([expiration, e]) => {
      const ivs = e.atmIvs.length > 0 ? e.atmIvs : e.allIvs;
      return {
        expiration,
        dte: dteOf(expiration, now),
        contracts: e.allIvs.length,
        avgIv: ivs.reduce((s, v) => s + v, 0) / ivs.length,
        maxIv: Math.max(...e.allIvs),
        premium: e.premium,
      };
    })
    .sort((a, b) => (a.dte ?? 1e9) - (b.dte ?? 1e9));

  return { current: wSum > 0 ? wIv / wSum : null, byExpiration };
}

/** Días naturales entre hoy (UTC) y una fecha "YYYY-MM-DD". Puede ser 0 o negativo. */
export function dteOf(date: string, now: Date): number {
  const [y, m, d] = date.split("-").map(Number);
  const exp = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((exp - today) / 86_400_000);
}

/**
 * Devuelve las `n` fechas de vencimiento más cercanas que aún no han expirado
 * (DTE ≥ 0), en orden ascendente. Para el heatmap de GEX (8 vencimientos).
 */
export function nearestExpirations(dates: string[], n: number, now: Date = new Date()): string[] {
  return dates
    .filter((d) => dteOf(d, now) >= 0)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, Math.max(0, n));
}

/**
 * Filtra las fechas cuyo DTE cae en [minDte, maxDte] inclusive. Para credit spreads
 * (5-7 DTE) y ventanas similares. Orden ascendente.
 */
export function expirationsInDteWindow(
  dates: string[],
  minDte: number,
  maxDte: number,
  now: Date = new Date(),
): string[] {
  return dates
    .filter((d) => {
      const dte = dteOf(d, now);
      return dte >= minDte && dte <= maxDte;
    })
    .sort((a, b) => a.localeCompare(b));
}
