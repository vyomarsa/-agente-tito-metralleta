import type { ZeroDteAnalysis, AggressorRead } from "@/lib/zerodte";
import type { ZeroDteReview } from "@/lib/zerodteStore";

export interface ZeroDteExpiration {
  date: string; // YYYY-MM-DD
  dte: number;  // días naturales al vencimiento (0 = hoy)
}

export interface ZeroDteResponse {
  ticker: string;
  expiration: string;
  isToday: boolean;
  selectedDte: number;
  available: ZeroDteExpiration[];
  minutesLeft: number;
  spot: number;
  spotSource: "quote" | "paridad";
  change: number | null;
  changePercent: number | null;
  contractCount: number;
  analysis: ZeroDteAnalysis;
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
