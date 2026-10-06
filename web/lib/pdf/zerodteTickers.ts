// Config de tickers seleccionables en "Agente ODTE". /ES y /NQ son FUTUROS
// NATIVOS con datos reales propios — porte fiel del motor del proyecto
// standalone Agente 0DTE (streamer de Tastytrade sobre el futuro activo real,
// ver lib/futuresNative.ts + streamer/tastytrade-futures-stream.mjs), NO la
// infraestructura de Contratos vecinos 2.0 (lib/futuresChain.ts) — son motores
// distintos a propósito, pedido explícito. CME cotiza casi 24/5, así
// que siguen dando señal real de noche cuando el mercado de acciones/índice
// está cerrado.

export type ZeroDteTickerId = "SPX" | "SPY" | "QQQ" | "ES" | "NQ";

export interface ZeroDteTickerConfig {
  id: ZeroDteTickerId;
  label: string;
  sublabel?: string;
  /** Ticker real que se pide a Schwab y con el que se guarda el estado en disco.
   *  Para ES/NQ (futuro nativo) no se usa para pedir datos — solo queda como
   *  identificador de archivo/journal, ver `nativeFuture` abajo. */
  underlying: string;
  /** Código de producto CME real (sin "/") si es un futuro nativo — dispara la
   *  ruta de datos de lib/futuresChain.ts en vez de Schwab/MarketSnack. */
  nativeFuture?: "ES" | "NQ";
}

export const ZERO_DTE_TICKERS: ZeroDteTickerConfig[] = [
  { id: "SPX", label: "SPX", underlying: "SPX" },
  { id: "SPY", label: "SPY", underlying: "SPY" },
  { id: "QQQ", label: "QQQ", underlying: "QQQ" },
  { id: "ES", label: "/ES", sublabel: "futuro CME · datos reales", underlying: "ES", nativeFuture: "ES" },
  { id: "NQ", label: "/NQ", sublabel: "futuro CME · datos reales", underlying: "NQ", nativeFuture: "NQ" },
];

export const DEFAULT_ZERO_DTE_TICKER: ZeroDteTickerId = "SPX";

/** Índices reales que necesitan el prefijo "$" en Schwab (las ETF no). */
export const INDEX_UNDERLYINGS = new Set(["SPX", "NDX"]);

export function zeroDteTickerConfig(id: string | null): ZeroDteTickerConfig {
  const found = ZERO_DTE_TICKERS.find((t) => t.id === (id ?? "").toUpperCase());
  return found ?? ZERO_DTE_TICKERS.find((t) => t.id === DEFAULT_ZERO_DTE_TICKER)!;
}
