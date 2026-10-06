// ============================================================================
// Agresor acumulado del Agente 0DTE — quién compró y quién vendió cada strike.
//
// El problema que resuelve: `side` (ask/bid) es el único dato que distingue
// compra de venta, y sin él la tabla del Proceso Principal §4 no se puede
// aplicar. Pero el feed de la fuente de datos es una ventana estrechísima: 40 páginas
// cubren ~1 minuto de cinta. Medido el 24-jul-2026, dos lecturas separadas por
// un minuto daban resultados OPUESTOS en el mismo strike (7445 call pasó de
// COMPRA 58% a VENTA 77%).
//
// Por eso una foto no vale y hay que ACUMULAR: cada ciclo de 5 minutos suma su
// minuto de cinta al total del día. A media sesión hay ~30 muestras repartidas,
// que es una base sólida en vez de un instante arbitrario.
//
// Solo servidor (usa fs).
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { isCanceledCondition } from "./conditions";
import { aggressionOf, type RawTrade } from "./flow";
import { marketDateStr, parseOcc } from "./occ";
import type { ContractGreeks, ContractType, Row } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "pdf", "odte-standalone", "flow");

/**
 * Cuántos ids recientes se recuerdan para no contar un trade dos veces.
 * Los ciclos no deberían solaparse (1 min de cinta cada 5 min), pero un
 * refresco manual sí puede repetir tramo, y contar doble sesga el ratio.
 */
export const SEEN_LIMIT = 5_000;

/** Mínimo de trades para que el porcentaje de agresor signifique algo. */
export const MIN_TRADES = 5;

export interface AggBucket {
  strike: number;
  type: ContractType;
  /** Contratos ejecutados contra el ASK — comprador agresivo. */
  ask: number;
  /** Contra el BID — vendedor agresivo. */
  bid: number;
  mid: number;
  trades: number;
  // --- Foto más reciente del contrato, para reconstruir la cadena EN TIEMPO
  // REAL (Schwab retrasa las opciones 15 min; la fuente de datos va a ~30 s). ---
  /** Volumen del día del contrato (el mayor visto — es acumulado y monótono). */
  volume: number;
  /** Open Interest (el mayor visto). */
  oi: number;
  /** Gamma del trade más reciente. null si nunca vino. */
  gamma: number | null;
  delta: number | null;
  iv: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  /** ms del trade más reciente considerado (para quedarse con la última foto). */
  ts: number;
}

export interface FlowAccumulator {
  ticker: string;
  /** Fecha de mercado (ET). El acumulado es del día: no se arrastra. */
  date: string;
  updatedAt: string;
  /** Ciclos de acumulación aplicados. */
  cycles: number;
  /** Clave "call:7450". */
  buckets: Record<string, AggBucket>;
  seenIds: number[];
}

export function emptyAccumulator(ticker: string, date: string): FlowAccumulator {
  return {
    ticker: ticker.toUpperCase(),
    date,
    updatedAt: new Date(0).toISOString(),
    cycles: 0,
    buckets: {},
    seenIds: [],
  };
}

export function bucketKey(type: ContractType, strike: number): string {
  return `${type}:${strike}`;
}

/**
 * Suma un lote de trades al acumulado. PURA: devuelve uno nuevo.
 *
 * Descarta los cancelados (la orden se anuló, no existió) y todo lo que no
 * venza en `expiration`, porque el feed trae la cadena entera del subyacente.
 */
export function accumulate(
  acc: FlowAccumulator,
  trades: RawTrade[],
  expiration: string,
  now: Date = new Date(),
): FlowAccumulator {
  const seen = new Set(acc.seenIds);
  const buckets: Record<string, AggBucket> = { ...acc.buckets };
  const fresh: number[] = [];

  for (const t of trades) {
    if (seen.has(t.id)) continue;
    if (isCanceledCondition(t.trade_condition_id)) continue;
    const occ = parseOcc(t.symbol);
    if (!occ || occ.expiration !== expiration) continue;

    seen.add(t.id);
    fresh.push(t.id);

    const key = bucketKey(occ.type, occ.strike);
    // Cada campo con default explícito: así un bucket guardado con formato viejo
    // (sin los griegos) no rompe la captura — Math.max(undefined,..)=NaN y
    // `ts >= undefined`=false se evitan al coercer todo a un valor válido.
    const p = buckets[key] as Partial<AggBucket> | undefined;
    const b: AggBucket = {
      strike: occ.strike,
      type: occ.type,
      ask: p?.ask ?? 0,
      bid: p?.bid ?? 0,
      mid: p?.mid ?? 0,
      trades: p?.trades ?? 0,
      volume: p?.volume ?? 0,
      oi: p?.oi ?? 0,
      gamma: p?.gamma ?? null,
      delta: p?.delta ?? null,
      iv: p?.iv ?? null,
      bidPrice: p?.bidPrice ?? null,
      askPrice: p?.askPrice ?? null,
      ts: p?.ts ?? 0,
    };
    const size = Number(t.size) || 0;
    const side = aggressionOf(t.side);
    // `unknown` se cuenta en trades pero no en ningún lado: inflar `mid` con
    // ejecuciones sin clasificar diluiría el ratio sin motivo.
    if (side === "ask") b.ask += size;
    else if (side === "bid") b.bid += size;
    else if (side === "mid") b.mid += size;
    b.trades += 1;

    // Foto del contrato: volumen/OI son acumulados (mayor visto); los griegos y
    // las quotes se quedan con los del trade más reciente.
    if (Number.isFinite(t.volume)) b.volume = Math.max(b.volume, t.volume);
    if (Number.isFinite(t.open_interest)) b.oi = Math.max(b.oi, t.open_interest);
    const ts = Date.parse(t.timestamp) || 0;
    if (ts >= b.ts) {
      b.ts = ts;
      if (typeof t.gamma === "number") b.gamma = t.gamma;
      if (Number.isFinite(t.delta)) b.delta = t.delta;
      if (Number.isFinite(t.implied_volatility)) b.iv = t.implied_volatility;
      if (Number.isFinite(t.bid_price)) b.bidPrice = t.bid_price;
      if (Number.isFinite(t.ask_price)) b.askPrice = t.ask_price;
    }
    buckets[key] = { ...b };
  }

  return {
    ...acc,
    updatedAt: now.toISOString(),
    cycles: acc.cycles + 1,
    buckets,
    // Los ids nuevos van al final; se recorta por delante para no crecer sin fin.
    seenIds: [...acc.seenIds, ...fresh].slice(-SEEN_LIMIT),
  };
}

export type AggressorSide = "compra" | "venta" | "mixto" | "mid";

export interface AggressorRead {
  side: AggressorSide;
  /** Porcentaje del lado dominante (0-1). */
  pct: number;
  trades: number;
  contracts: number;
  /** Lectura de dominio según el Proceso Principal §4. */
  meaning: string;
}

/**
 * Lectura del agresor de un contrato. PURA.
 * Devuelve null si no hay muestra suficiente — mejor sin dato que con un 100%
 * salido de un solo trade.
 */
export function readAggressor(
  acc: FlowAccumulator,
  type: ContractType,
  strike: number,
  minTrades: number = MIN_TRADES,
): AggressorRead | null {
  const b = acc.buckets[bucketKey(type, strike)];
  if (!b || b.trades < minTrades) return null;
  const total = b.ask + b.bid + b.mid;
  if (total <= 0) return null;

  const pAsk = b.ask / total;
  const pBid = b.bid / total;
  const pMid = b.mid / total;

  if (pAsk >= 0.55) {
    return {
      side: "compra", pct: pAsk, trades: b.trades, contracts: total,
      meaning: type === "call" ? "direccional alcista" : "cobertura o bajista",
    };
  }
  if (pBid >= 0.55) {
    return {
      side: "venta", pct: pBid, trades: b.trades, contracts: total,
      meaning: type === "call" ? "resistencia / muro" : "soporte",
    };
  }
  if (pMid >= 0.55) {
    return { side: "mid", pct: pMid, trades: b.trades, contracts: total, meaning: "sin agresor claro" };
  }
  return {
    side: "mixto", pct: Math.max(pAsk, pBid), trades: b.trades, contracts: total, meaning: "",
  };
}

// ----------------------------------------------- superposición en tiempo real

export interface OverlayResult {
  rows: Row[];
  /** Cuántas filas quedaron con datos frescos de la fuente de datos. */
  realtimeStrikes: number;
  /** ms del trade más reciente en el acumulado (frescura del overlay). */
  newestTs: number;
}

/**
 * Superpone la foto en tiempo real de la fuente de datos sobre las filas de Schwab. PURA.
 *
 * La cadena de Schwab está completa pero retrasada 15 min; la fuente de datos es fresco
 * (~30 s) pero solo cubre los contratos que operaron. Aquí se combinan: cada
 * fila de Schwab cuyo contrato haya visto la fuente de datos recibe su gamma, OI,
 * volumen, delta, IV y quotes frescos. Las demás se quedan con Schwab (relleno).
 * Así el GEX y los muros cerca del dinero pasan a tiempo real sin perder la
 * cobertura completa de la cadena.
 *
 * Solo se pisa un campo si la fuente de datos lo trae; nunca se degrada un dato bueno
 * de Schwab por un hueco de la fuente de datos.
 */
export function overlayRealtime(rows: Row[], acc: FlowAccumulator | null): OverlayResult {
  if (!acc || !acc.buckets) return { rows, realtimeStrikes: 0, newestTs: 0 };
  let realtimeStrikes = 0;
  let newestTs = 0;

  const out = rows.map((r) => {
    const b = acc.buckets[bucketKey(r.contractType, r.strike)];
    if (!b || b.gamma == null) return r; // sin foto útil de MS: se queda Schwab
    realtimeStrikes += 1;
    if (b.ts > newestTs) newestTs = b.ts;

    const greeks: ContractGreeks = {
      ...(r.greeks ?? { delta: null, gamma: null, theta: null, vega: null, rho: null, iv: null }),
      gamma: b.gamma,
      delta: b.delta ?? r.greeks?.delta ?? null,
      iv: b.iv ?? r.greeks?.iv ?? null,
    };
    return {
      ...r,
      openInterest: b.oi > 0 ? b.oi : r.openInterest,
      volume: Math.max(b.volume, r.volume), // ambos son acumulado del día; MS más fresco
      bid: b.bidPrice ?? r.bid ?? null,
      ask: b.askPrice ?? r.ask ?? null,
      // agresor neto del día = compras (ask) − ventas (bid) agresivas, en contratos
      intradayNet: (Number(b.ask) || 0) - (Number(b.bid) || 0),
      greeks,
    };
  });

  return { rows: out, realtimeStrikes, newestTs };
}

// ------------------------------------------------------------------ persistencia

function fileFor(ticker: string, date: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}-${date}.json`);
}

export async function loadFlow(ticker: string, date: string): Promise<FlowAccumulator> {
  try {
    const raw = await fs.readFile(fileFor(ticker, date), "utf8");
    const parsed = JSON.parse(raw) as FlowAccumulator;
    // Un acumulado de otro día no sirve: el volumen y el agresor son intradía.
    if (parsed.date !== date || typeof parsed.buckets !== "object") {
      return emptyAccumulator(ticker, date);
    }
    return { ...emptyAccumulator(ticker, date), ...parsed };
  } catch {
    return emptyAccumulator(ticker, date);
  }
}

export async function saveFlow(acc: FlowAccumulator): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(acc.ticker, acc.date), JSON.stringify(acc), "utf8");
}

/** Fecha de mercado de hoy — reexportada para que las rutas no dupliquen la lógica. */
export const flowDate = marketDateStr;
