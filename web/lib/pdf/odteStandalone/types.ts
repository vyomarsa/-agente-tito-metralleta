// Tipos compartidos entre los clientes de datos (Schwab/Massive), los cálculos y la UI.

export type ContractType = "call" | "put";

/** Griegos e IV reales del contrato. Los entrega Schwab; Massive no. */
export interface ContractGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  /** Volatilidad implícita en DECIMAL (0.3053), no en porcentaje. */
  iv: number | null;
}

/**
 * Contrato crudo normalizado. La forma base es la del Option Chain Snapshot de
 * Massive; `quote` y `greeks` son campos que solo llegan desde Schwab.
 */
export interface RawContract {
  break_even_price?: number;
  day?: {
    volume?: number;
    close?: number;
    vwap?: number;
  };
  details?: {
    contract_type?: string;
    expiration_date?: string;
    strike_price?: number;
    shares_per_contract?: number;
    ticker?: string;
  };
  last_trade?: {
    price?: number;
  };
  open_interest?: number;
  underlying_asset?: {
    price?: number;
    ticker?: string;
  };
  /** Quote real bid/ask (Schwab). El plan de Massive no lo entrega. */
  quote?: {
    bid?: number;
    ask?: number;
  };
  /** Griegos reales (Schwab). Evita estimarlos con Black-Scholes. */
  greeks?: ContractGreeks;
}

/**
 * De dónde salió el precio usado para Open Premium.
 * `bid` es el que pide el Proceso Principal; los demás son respaldos.
 */
export type PriceSource = "bid" | "last_trade" | "day_close" | "day_vwap" | "none";

/** Fila procesada que consume la tabla. */
export interface Row {
  optionTicker: string;
  contractType: ContractType;
  expiration: string;
  strike: number;
  openInterest: number;
  volume: number;
  price: number | null;
  priceSource: PriceSource;
  openPremium: number | null;
  notionalValue: number;
  /** Quote real. Opcional: solo viene con Schwab. */
  bid?: number | null;
  ask?: number | null;
  /** Griegos reales. Opcional: solo vienen con Schwab. */
  greeks?: ContractGreeks | null;
  /** Agresor NETO del día para este contrato (compras agresivas − ventas
   *  agresivas, en contratos). Ajusta el OI —viejo, de ayer— por el
   *  posicionamiento NUEVO de hoy en el GEX. Solo con flujo en vivo. */
  intradayNet?: number | null;
}

export interface ChainMeta {
  ticker: string;
  underlyingPrice: number | null;
  contractCount: number;
  expirationCount: number;
  pages: number;
  truncated: boolean;
  /** Proveedor que sirvió la cadena. */
  source?: "schwab" | "massive";
  /** Los datos vienen con retraso (Schwab los marca así). */
  delayed?: boolean;
}

/** Información y stats de la empresa (se muestra antes de la tabla). */
export interface CompanyInfo {
  ticker: string;
  name: string | null;
  exchange: string | null;
  marketCap: number | null;
  homepageUrl: string | null;
  employees: number | null;
  listDate: string | null;
  sector: string | null; // sic_description
  description: string | null;
  hasLogo: boolean;
  // stats de precio (stock snapshot)
  price: number | null;
  change: number | null;
  changePercent: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  prevClose: number | null;
}

/** Barra diaria del subyacente para la gráfica (formato lightweight-charts). */
export interface DailyBar {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Barra con tiempo UNIX (segundos) — sirve para diario e intradía. */
export interface TfBar {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

// ---- Eventos SSE ----
export interface StepEvent {
  type: "step";
  label: string;
  detail?: string;
}
export interface CompanyEvent {
  type: "company";
  company: CompanyInfo;
}
export interface DoneEvent {
  type: "done";
  rows: Row[];
  meta: ChainMeta;
}
export interface ErrorEvent {
  type: "error";
  message: string;
}
export type ChainEvent = StepEvent | CompanyEvent | DoneEvent | ErrorEvent;
