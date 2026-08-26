// Cadena de opciones COMPLETA en el formato `RawContract` que consume el panel de
// Ticker (`lib/compute.ts` → `toRow`).
//
// Orden de fuentes: Tastytrade → MarketSnack → Schwab → Massive.
// Solo servidor.

import { fetchTastytradeChain, type QuoteToken, type TtContract } from "./tastytrade";
import { fetchExpirations, fetchOptionChain2 } from "./marketsnack";
import { normalizeChain2, nearestExpirations, type Chain2Contract } from "./optionChain2";
import { estimateSpotFromChain } from "./zerodte";
import { fetchOptionChain as fetchSchwabChain, schwabStatus, type SchwabContract } from "./schwab";
import { schwabKey, type SchwabGreek } from "./gex";
import { withChainCache, chainKey } from "./chainCache";
import type { RawContract } from "./types";

/** Vencimientos más cercanos que se piden. 8 es el régimen ya verificado del streamer. */
export const CHAIN_EXPIRATIONS = 8;

/**
 * Símbolo OCC: ROOT + YYMMDD + (C|P) + strike×1000 en 8 dígitos.
 * Se construye aquí porque Tastytrade entrega los campos sueltos y `toRow` espera
 * el símbolo montado (es el identificador que la tabla enseña). Formato espejo del
 * que parsea `parseOcc` en `lib/occ.ts`.
 */
export function occSymbol(ticker: string, expiration: string, type: "call" | "put", strike: number): string {
  const [y, m, d] = expiration.split("-");
  const fecha = `${y.slice(2)}${m}${d}`;
  const strikeRaw = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${ticker.toUpperCase()}${fecha}${type === "call" ? "C" : "P"}${strikeRaw}`;
}

/**
 * TtContract → RawContract.
 *
 * `contractPrice` (en `compute.ts`) busca `last_trade.price → day.close → day.vwap`.
 * Tastytrade da el último operado, y cuando no hay (strike sin negociar hoy) se pone
 * el MID de la horquilla como `day.close`: es un precio real de mercado y evita que
 * el Open Premium salga en cero para media cadena. Queda declarado aquí porque no es
 * el mismo criterio que traía Massive.
 */
export function ttToRawContract(c: TtContract, ticker: string, spot: number | null): RawContract {
  const mid = c.bid != null && c.ask != null && c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : undefined;
  return {
    details: {
      contract_type: c.type,
      expiration_date: c.expiration,
      strike_price: c.strike,
      shares_per_contract: 100,
      ticker: occSymbol(ticker, c.expiration, c.type, c.strike),
    },
    open_interest: c.openInterest,
    day: { volume: c.volume, close: mid },
    last_trade: c.last != null && c.last > 0 ? { price: c.last } : undefined,
    underlying_asset: { price: spot ?? undefined, ticker: ticker.toUpperCase() },
  };
}

export interface RawChainResult {
  contracts: RawContract[];
  underlyingPrice: number | null;
  expirations: number;
}

/**
 * Greeks REALES por contrato a partir de la MISMA cadena que ya se bajó.
 *
 * `ttToRawContract` tiene que tirar gamma/IV porque `RawContract` es el formato de
 * Massive y allí no hay hueco para greeks. Quien los necesite (el GEX) los pedía
 * después con `fetchTastytradeGreeks`, que abre un SEGUNDO WebSocket por los mismos
 * vencimientos: medido, hasta +9 s por tarjeta (el snapshot se come su tope duro
 * cuando los contratos no tickean, típico en pre-market). Aquí salen gratis.
 *
 * Clave = `schwabKey` (`strike|expiration|type`), la que consume `gexAnalysis`.
 */
export function ttGreeksMap(contracts: TtContract[]): Map<string, SchwabGreek> {
  const out = new Map<string, SchwabGreek>();
  for (const c of contracts) {
    const gamma = c.gamma != null && c.gamma > 0 ? c.gamma : null;
    const iv = c.iv != null && c.iv > 0 ? c.iv : null;
    if (gamma == null && iv == null) continue;
    out.set(schwabKey(c.strike, c.expiration, c.type), { gamma: gamma ?? 0, iv: iv ?? 0 });
  }
  return out;
}

// --- MarketSnack → RawContract ---

function chain2ToRawContract(c: Chain2Contract, ticker: string, spot: number | null): RawContract {
  const mid = c.mid ?? (c.bid != null && c.ask != null ? (c.bid + c.ask) / 2 : undefined);
  return {
    details: {
      contract_type: c.type,
      expiration_date: c.expiration,
      strike_price: c.strike,
      shares_per_contract: 100,
      ticker: c.symbol,
    },
    open_interest: c.openInterest,
    day: { volume: c.volume, close: mid ?? undefined },
    last_trade: c.lastPrice != null && c.lastPrice > 0 ? { price: c.lastPrice } : undefined,
    underlying_asset: { price: spot ?? undefined, ticker: ticker.toUpperCase() },
  };
}

export async function fetchChainFromMarketSnack(
  ticker: string,
  opts: { expirations?: number } = {},
): Promise<RawChainResult> {
  const clean = ticker.trim().toUpperCase();
  const maxExp = opts.expirations ?? CHAIN_EXPIRATIONS;

  const expList = await fetchExpirations(clean);
  const dates = nearestExpirations(expList.map((e) => e.date), maxExp, new Date());
  if (dates.length === 0) return { contracts: [], underlyingPrice: null, expirations: 0 };

  const allMs: Chain2Contract[] = [];
  await Promise.all(
    dates.map(async (date) => {
      try {
        const raw = await fetchOptionChain2(clean, date);
        allMs.push(...normalizeChain2(raw));
      } catch {
        // vencimiento no disponible — seguimos con los demás
      }
    }),
  );

  const spot = estimateSpotFromChain(allMs);
  const contracts = allMs.map((c) => chain2ToRawContract(c, clean, spot));
  const expSet = new Set(allMs.map((c) => c.expiration)).size;
  return { contracts, underlyingPrice: spot, expirations: expSet };
}

// --- Schwab → RawContract ---

function schwabToRawContract(c: SchwabContract, ticker: string, spot: number | null): RawContract {
  const mid = c.bid != null && c.ask != null ? (c.bid + c.ask) / 2 : undefined;
  return {
    details: {
      contract_type: c.contractType,
      expiration_date: c.expiration,
      strike_price: c.strike,
      shares_per_contract: 100,
      ticker: c.symbol,
    },
    open_interest: c.openInterest,
    day: { volume: c.volume, close: mid },
    last_trade: c.last != null && c.last > 0 ? { price: c.last } : undefined,
    underlying_asset: { price: spot ?? undefined, ticker: ticker.toUpperCase() },
  };
}

export async function fetchChainFromSchwab(ticker: string): Promise<RawChainResult> {
  const clean = ticker.trim().toUpperCase();
  const status = await schwabStatus();
  if (!status.connected) throw new Error("Schwab no conectado");

  const result = await fetchSchwabChain(clean);
  const spot = result.underlyingPrice;
  const contracts = result.contracts.map((c) => schwabToRawContract(c, clean, spot));
  const expirations = new Set(result.contracts.map((c) => c.expiration)).size;
  return { contracts, underlyingPrice: spot, expirations };
}

/**
 * Cadena desde Tastytrade en formato Massive. Trae también el spot del subyacente
 * por la misma conexión, así que quien llame no necesita pedirlo aparte.
 *
 * Devuelve los `CHAIN_EXPIRATIONS` vencimientos más cercanos, no la cadena entera:
 * es lo que el panel de Ticker usa y lo que el streamer sostiene en ~3 s.
 *
 * `greeks` viaja aparte de `contracts` porque el formato de Massive no los admite:
 * quien calcule GEX debe usarlos en vez de volver a abrir el streamer (ver
 * `ttGreeksMap`).
 */
export async function fetchChainFromTastytrade(
  ticker: string,
  opts: { expirations?: number; quoteToken?: QuoteToken; timeoutMs?: number; now?: Date } = {},
): Promise<RawChainResult & { greeks: Map<string, SchwabGreek> }> {
  const clean = ticker.trim().toUpperCase();
  const vencimientos = opts.expirations ?? CHAIN_EXPIRATIONS;

  // El cache va AQUÍ y no en cada ruta: `/api/chain` y `/api/tarjeta` piden esta
  // misma foto, y así ninguna de las dos tiene que acordarse de pedirla.
  return withChainCache(
    chainKey(clean, vencimientos),
    async () => {
      const { contracts: tt, spot } = await fetchTastytradeChain(clean, {
        expirations: vencimientos,
        quoteToken: opts.quoteToken,
        timeoutMs: opts.timeoutMs,
      });
      const contracts = tt.map((c) => ttToRawContract(c, clean, spot));
      const expirations = new Set(tt.map((c) => c.expiration)).size;
      return { contracts, underlyingPrice: spot, expirations, greeks: ttGreeksMap(tt) };
    },
    opts.now,
  );
}
