// Temporalidades de la pestaña BTC — mismo patrón que `lib/timeframeBars.ts`
// (Grandes Empresas 2.0), pero con su propia lista: BTC opera 24/7, así que el
// mismo rango de días trae ~3-4x más velas que un activo que solo cotiza en
// horario de mercado — las ventanas de abajo son más chicas a propósito.
// No se toca `CHART_TIMEFRAMES` para no agregarle temporalidades a Grandes
// Empresas sin que se haya pedido.

export type BtcTimeframeId = "1w" | "1d" | "4h" | "1h" | "30m" | "15m" | "5m" | "1m";

// Misma forma que `ChartTimeframeConfig` (lib/timeframeBars.ts) — no se reusa
// ese tipo tal cual porque su `id` está fijo a la unión de Grandes Empresas.
export interface BtcTimeframeConfig {
  id: BtcTimeframeId;
  label: string;
  multiplier: number;
  timespan: "week" | "day" | "hour" | "minute";
  days: number;
  aggregateHours?: number;
}

export const BTC_CHART_TIMEFRAMES: BtcTimeframeConfig[] = [
  { id: "1w", label: "1 semana", multiplier: 1, timespan: "week", days: 5 * 365 },
  { id: "1d", label: "1 día", multiplier: 1, timespan: "day", days: 2 * 365 },
  { id: "4h", label: "4 horas", multiplier: 1, timespan: "hour", days: 180, aggregateHours: 4 },
  { id: "1h", label: "1 hora", multiplier: 1, timespan: "hour", days: 90 },
  { id: "30m", label: "30 min", multiplier: 30, timespan: "minute", days: 45 },
  { id: "15m", label: "15 min", multiplier: 15, timespan: "minute", days: 20 },
  { id: "5m", label: "5 min", multiplier: 5, timespan: "minute", days: 10 },
  { id: "1m", label: "1 min", multiplier: 1, timespan: "minute", days: 2 },
];

export const DEFAULT_BTC_TIMEFRAME: BtcTimeframeId = "4h";

export function btcTimeframeConfig(id: string): BtcTimeframeConfig {
  return (
    BTC_CHART_TIMEFRAMES.find((tf) => tf.id === id) ??
    BTC_CHART_TIMEFRAMES.find((tf) => tf.id === DEFAULT_BTC_TIMEFRAME)!
  );
}
