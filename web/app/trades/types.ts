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
    /** Cruzaron su propio stop antes del gatillo: la idea murió sin probarse. */
    invalidadas: number;
    expiradas: number;
    ganadas: number;
    perdidas: number;
    /** Cruzaron el gatillo pero ni un contrato cabía en la banda 2–3%. */
    sinTamano: number;
  };
  caducadasTickers?: string[];
  invalidadasTickers?: string[];
  /** Detalle de los `sinTamano`: ticker y lo que costaba el contrato. */
  noCaben?: string[];
  /** Capital con el que se dimensionó esta pasada. */
  equity?: number;
  warnings?: { unquoted: string[] };
  trades: import("@/lib/paperTrade").PaperTrade[];
  summary: import("@/lib/paperTrade").PaperSummary;
}
