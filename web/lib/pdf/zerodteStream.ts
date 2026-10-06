// Tipo compartido del feed "0DTE Live" (contratos entrantes / bursts) que
// escriben los streamers de Tastytrade — ver streamer/lib/top-trades.mjs.
// Los streamers ahora escriben directo a data/0dte/ (índice/ETF) o
// data/tastytrade-fut/ (futuros nativos), leídos por lib/zerodteFlow.ts y
// lib/futuresNative.ts respectivamente — este archivo solo aporta el tipo.

export interface TopTrade {
  ts: number;
  strike: number;
  type: "call" | "put";
  side: "buy" | "sell" | "mid";
  price: number;
  size: number;
  n: number;
  premium: number;
  delta: number | null;
  volume: number;
  oi: number;
  open: boolean;
  gamma: number | null;
  sweep: boolean;
  slKnown: boolean;
}
