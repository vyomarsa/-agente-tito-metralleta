export type { PaperTrade, PaperSummary, PaperStatus, OptionType, Direction } from "@/lib/paperTrade";

export interface TradesResponse {
  ok: boolean;
  error?: string;
  kind?: string;
  changed?: number;
  /** Solo lo devuelve /api/trades/refresh: desglose de lo que pasó en esta pasada. */
  revisados?: number;
  tally?: {
    activadas: number;
    caducadas: number;
    expiradas: number;
    ganadas: number;
    perdidas: number;
  };
  caducadasTickers?: string[];
  warnings?: { unquoted: string[] };
  trades: import("@/lib/paperTrade").PaperTrade[];
  summary: import("@/lib/paperTrade").PaperSummary;
}
