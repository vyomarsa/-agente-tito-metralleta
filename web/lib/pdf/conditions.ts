// Catálogo de condiciones de transacción de OPRA (via MarketSnack /api/trade_conditions).
// Sirve para saber si un trade fue single leg o multi leg SIN adivinar por timestamp.

export interface TradeCondition {
  id: number;
  code: string;
  name: string;
}

export const TRADE_CONDITIONS: TradeCondition[] = [
  { id: 201, code: "CANC", name: "Canceled" },
  { id: 202, code: "OSEQ", name: "Late and Out Of Sequence" },
  { id: 203, code: "CNCL", name: "Last and Canceled" },
  { id: 204, code: "LATE", name: "Late" },
  { id: 205, code: "CNCO", name: "Opening Trade and Canceled" },
  { id: 206, code: "OPEN", name: "Opening Trade, Late, and Out Of Sequence" },
  { id: 207, code: "CNOL", name: "Only Trade and Canceled" },
  { id: 208, code: "OPNL", name: "Opening Trade and Late" },
  { id: 209, code: "AUTO", name: "Automatic Execution" },
  { id: 210, code: "REOP", name: "Reopening Trade" },
  { id: 219, code: "ISOI", name: "Intermarket Sweep Order" },
  { id: 227, code: "SLAN", name: "Single Leg Auction Non ISO" },
  { id: 228, code: "SLAI", name: "Single Leg Auction ISO" },
  { id: 229, code: "SLCN", name: "Single Leg Cross Non ISO" },
  { id: 230, code: "SLCI", name: "Single Leg Cross ISO" },
  { id: 231, code: "SLFT", name: "Single Leg Floor Trade" },
  { id: 232, code: "MLET", name: "Multi Leg auto-electronic trade" },
  { id: 233, code: "MLAT", name: "Multi Leg Auction" },
  { id: 234, code: "MLCT", name: "Multi Leg Cross" },
  { id: 235, code: "MLFT", name: "Multi Leg floor trade" },
  { id: 236, code: "MESL", name: "Multi Leg auto-electronic trade against single leg(s)" },
  { id: 237, code: "TLAT", name: "Stock Options Auction" },
  { id: 238, code: "MASL", name: "Multi Leg Auction against single leg(s)" },
  { id: 239, code: "MFSL", name: "Multi Leg floor trade against single leg(s)" },
  { id: 240, code: "TLET", name: "Stock Options auto-electronic trade" },
  { id: 241, code: "TLCT", name: "Stock Options Cross" },
  { id: 242, code: "TLFT", name: "Stock Options floor trade" },
  { id: 243, code: "TESL", name: "Stock Options auto-electronic trade against single leg(s)" },
  { id: 244, code: "TASL", name: "Stock Options Auction against single leg(s)" },
  { id: 245, code: "TFSL", name: "Stock Options floor trade against single leg(s)" },
  { id: 246, code: "CBMO", name: "Multi Leg Floor Trade of Proprietary Products" },
  { id: 247, code: "MCTP", name: "Multilateral Compression Trade of Proprietary Products" },
  { id: 248, code: "EXHT", name: "Extended Hours Trade" },
];

const BY_ID = new Map(TRADE_CONDITIONS.map((c) => [c.id, c]));

/**
 * Códigos que MarketSnack clasifica como MULTI LEG (su filtro "Filter by Multi-Leg").
 * Todo lo demás cuenta como single leg — incluidos MESL/MFSL/MASL, que se ejecutan
 * "against single leg(s)" y MarketSnack lista en el filtro Single-Leg.
 */
export const MULTI_LEG_CODES = new Set(["MLET", "MLAT", "MLCT", "MLFT", "CBMO", "MCTP"]);

/**
 * Condiciones de transacción CANCELADA: la operación se anuló, así que no debe
 * contar en ningún análisis ni puntaje.
 *  CANC = cancelada · CNCL = última y cancelada · CNCO = apertura y cancelada
 *  CNOL = única del día y cancelada
 */
export const CANCELED_CODES = new Set(["CANC", "CNCL", "CNCO", "CNOL"]);

export function conditionOf(id: number | null | undefined): TradeCondition | null {
  return id == null ? null : BY_ID.get(id) ?? null;
}

/** ¿La transacción fue cancelada? Esas se descartan del flujo. */
export function isCanceledCondition(id: number | null | undefined): boolean {
  const c = conditionOf(id);
  return c != null && CANCELED_CODES.has(c.code);
}

/** ¿El trade fue multi leg? Se decide por el código real de la condición, no por heurística. */
export function isMultiLegCondition(id: number | null | undefined): boolean {
  const c = conditionOf(id);
  return c != null && MULTI_LEG_CODES.has(c.code);
}
