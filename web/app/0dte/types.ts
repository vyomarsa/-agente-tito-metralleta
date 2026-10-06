import type { ZeroDteAnalysis, AggressorRead } from "@/lib/zerodte";
import type { ZeroDteReview } from "@/lib/zerodteStore";
import type {
  ZeroDteBias, ZeroDtePinning, ZeroDteTicket, ZeroDteTradeCard,
} from "@/lib/zerodteSignals";
import type { ZeroDteSpreads } from "@/lib/zerodteSpreads";
import type { ZeroDteClose } from "@/lib/zerodteClose";
import type { ZeroDteTape } from "@/lib/zerodteTape";
import type { ZeroDteScoreboard } from "@/lib/zerodteLiveStore";

export interface ZeroDteExpiration {
  date: string; // YYYY-MM-DD
  dte: number;  // días naturales al vencimiento (0 = hoy)
}

/** Bloque de señales tácticas que acompaña a la cadena en cada refresco. */
export interface ZeroDteSignals {
  trade: ZeroDteTradeCard;
  tradeAlt: ZeroDteTradeCard;
  ticket: ZeroDteTicket | null;
  ticketNote: string;
  spreads: ZeroDteSpreads;
  bias: ZeroDteBias;
  biasAlt: ZeroDteBias;
  pinning: ZeroDtePinning;
  /** Cierre de la última hora (Max Pain + charm). null fuera del vencimiento de hoy. */
  close: ZeroDteClose | null;
}

export interface ZeroDteResponse {
  ticker: string;
  expiration: string;
  isToday: boolean;
  selectedDte: number;
  available: ZeroDteExpiration[];
  minutesLeft: number;
  /** true solo dentro de 9:30-16:00 ET y con el vencimiento de HOY. */
  sessionOpen: boolean;
  etMinute: number | null;
  spot: number;
  spotSource: "tastytrade" | "quote" | "paridad";
  /** Fuente de la cadena: Tastytrade primero, MarketSnack de respaldo. */
  chainSource: "tastytrade" | "marketsnack";
  change: number | null;
  changePercent: number | null;
  contractCount: number;
  analysis: ZeroDteAnalysis;
  signals: ZeroDteSignals;
  tape: ZeroDteTape;
  flow: { reads: AggressorRead[]; summary: { bullish: number; bearish: number } };
  score: ZeroDteScoreboard | null;
}

export interface ZeroDteFlowResponse {
  ticker: string;
  expiration: string;
  updatedAt: string;
  trades: number;
  reads: AggressorRead[];
  summary: { bullish: number; bearish: number };
}

export interface ZeroDteEvalResponse {
  ticker: string;
  review: ZeroDteReview | null;
  snapshots: number;
}

export type { ZeroDteAnalysis, AggressorRead, ZeroDteReview };
export type { ZeroDteStrike, ZeroDteLeg, ZeroDteWall, ZeroDteScenario } from "@/lib/zerodte";
export type {
  ZeroDteBias, ZeroDtePinning, ZeroDteTicket, ZeroDteTradeCard,
} from "@/lib/zerodteSignals";
export type { ZeroDteClose, ZeroDteCharm } from "@/lib/zerodteClose";
export type { ZeroDteTape, ZeroDteBlock } from "@/lib/zerodteTape";
export type { ZeroDteScoreboard, BiasScore, TradeScore } from "@/lib/zerodteLiveStore";
