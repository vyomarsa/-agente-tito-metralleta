// Parseo PURO del option chain crudo de Schwab (GET /marketdata/v1/chains) a un mapa
// de griegos reales por strike+vencimiento+tipo. Sin red, sin disco — testeable.
//
// Formato de Schwab: { callExpDateMap: { "2026-07-27:1": { "738.0": [ {...} ] } }, putExpDateMap: {...} }
// El ":N" del expKey es el DTE que Schwab ya trae calculado; se descarta porque
// daysToExpiration (lib/occ.ts) lo recalcula desde la fecha para todo el proyecto.
// Los griegos vienen en -999 cuando Schwab no pudo calcularlos (0 DTE, IV que no
// resuelve) — ese centinela se trata como "sin dato", no como un griego real de -999.

export interface SchwabGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** IV decimal (Schwab manda "volatility" en % — 29 = 29%). */
  iv: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  openInterest: number;
}

export type SchwabGreeksMap = Record<string, SchwabGreeks>;

const SENTINEL = -999;

function clean(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v !== SENTINEL ? v : null;
}

/** Clave del mapa: strike (número tal cual), vencimiento YYYY-MM-DD y tipo. */
export function greeksKey(strike: number, expiration: string, type: "call" | "put"): string {
  return `${strike}|${expiration}|${type}`;
}

interface RawSchwabContract {
  strikePrice?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  volatility?: number;
  bid?: number;
  ask?: number;
  last?: number;
  openInterest?: number;
}

type ExpDateMap = Record<string, Record<string, RawSchwabContract[]>>;

export interface ParsedSchwabChain {
  underlyingPrice: number | null;
  greeks: SchwabGreeksMap;
}

export function parseSchwabChain(raw: unknown): ParsedSchwabChain {
  const json = (raw ?? {}) as {
    underlyingPrice?: number;
    callExpDateMap?: ExpDateMap;
    putExpDateMap?: ExpDateMap;
  };
  const greeks: SchwabGreeksMap = {};

  const walk = (expDateMap: ExpDateMap | undefined, type: "call" | "put") => {
    if (!expDateMap) return;
    for (const [expKey, strikesObj] of Object.entries(expDateMap)) {
      const expiration = expKey.split(":")[0];
      if (!strikesObj) continue;
      for (const contracts of Object.values(strikesObj)) {
        for (const c of contracts ?? []) {
          const strike = clean(c.strikePrice);
          if (strike == null) continue;
          const ivPct = clean(c.volatility);
          greeks[greeksKey(strike, expiration, type)] = {
            delta: clean(c.delta),
            gamma: clean(c.gamma),
            theta: clean(c.theta),
            vega: clean(c.vega),
            iv: ivPct != null && ivPct > 0 ? ivPct / 100 : null,
            bid: clean(c.bid),
            ask: clean(c.ask),
            last: clean(c.last),
            openInterest: typeof c.openInterest === "number" ? c.openInterest : 0,
          };
        }
      }
    }
  };

  walk(json.callExpDateMap, "call");
  walk(json.putExpDateMap, "put");

  return { underlyingPrice: clean(json.underlyingPrice), greeks };
}
