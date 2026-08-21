// Tipos del evento SSE del escáner de Credit Spreads. Ver app/api/spreads/route.ts.

import type { Bias, SpreadScan } from "@/lib/creditSpread";

/** Fuente de la cadena: MarketSnack (default) o Schwab (greeks de bróker). */
export type Source = "tastytrade" | "marketsnack" | "schwab";

export interface SpreadStepEvent {
  type: "step";
  label: string;
}

export interface SpreadDoneEvent {
  type: "done";
  bias: Bias;
  /** Un escaneo por ticker (candidatos + descartes con su motivo). */
  scans: SpreadScan[];
  meta: {
    bias: Bias;
    /** Fuente que realmente se usó (puede diferir de la pedida si hubo fallback). */
    source: Source;
    scanned: number;
    failed: number;
    /** Tickers con al menos un candidato válido. */
    withCandidates: number;
    /** Tickers descartados o no elegibles (con motivo). */
    discarded: number;
    /** true si falló más de la mitad del universo. */
    degraded: boolean;
    /** Calendario macro servido de cache viejo (FRED falló). */
    macroStale: boolean;
    /** Modo experto activo: filtros DUROS degradados a avisos. */
    expert: boolean;
  };
}

export interface SpreadErrorEvent {
  type: "error";
  message: string;
  /**
   * "marketsnack" → falta la cookie de MarketSnack; "macro" → falta calendario.
   * ("schwab" queda por compatibilidad de la UI vieja.)
   */
  kind?: "marketsnack" | "schwab" | "macro" | "generic";
}

export type SpreadSseEvent = SpreadStepEvent | SpreadDoneEvent | SpreadErrorEvent;
