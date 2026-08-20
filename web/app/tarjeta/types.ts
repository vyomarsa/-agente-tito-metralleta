// Tipos del canal SSE de /api/tarjeta y de la página /tarjeta.

import type { DecisionCard } from "@/lib/decisionCard";

export interface TarjetaMeta {
  ticker: string;
  horizonDays: number;
  /** Fuente de los greeks del GEX: reales o estimados. */
  greeksSource: "marketsnack" | "schwab" | "estimated";
  /** De dónde salió el spot. */
  spot: number;
  /** Resumen en lenguaje llano de la predicción (contexto). */
  predictionSummary: string;
  generatedAt: string;
}

export type TarjetaSseEvent =
  | { type: "step"; label: string; detail?: string }
  | { type: "done"; card: DecisionCard; meta: TarjetaMeta }
  | { type: "error"; message: string };
