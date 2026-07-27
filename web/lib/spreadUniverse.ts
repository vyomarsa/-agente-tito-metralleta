// Universo curado del escáner de Credit Spreads. Se edita A MANO.
//
// Reglas del mandato (Sección 1 y 3 del prompt del operador):
//   1. SOLO acciones individuales. ETFs/ETNs/fondos cotizados PROHIBIDOS
//      (por eso NO se reutiliza WHEEL_UNIVERSE tal cual: hay que sacar SPY/QQQ/…).
//   2. Deben ser plausiblemente elegibles: cap ≥ $10B, precio ≥ $30, volumen 20d
//      ≥ 5M, con vencimientos semanales y cadena muy líquida. La elegibilidad fina
//      se verifica EN VIVO contra datos reales (lib/creditSpread.ts); esta lista solo
//      acota a nombres que valga la pena consultar.
//   3. El `sector` es obligatorio: la Sección 8 limita a UNA posición por sector por
//      semana, así que el motor/UI lo necesita para avisar de concentración.
//
// El módulo NO valida esta lista contra el mercado. Si un ticker deja de cumplir,
// se saca a mano y se anota por qué.

export interface SpreadSymbol {
  ticker: string;
  /** Sector para la regla de concentración (Sección 8). */
  sector: string;
  razon: string;
}

export const SPREAD_UNIVERSE: SpreadSymbol[] = [
  // ── Tecnología / Semiconductores ──
  { ticker: "NVDA", sector: "Semiconductores", razon: "Cadena semanal profunda, la más negociada del sector" },
  { ticker: "AMD", sector: "Semiconductores", razon: "Semis líquida con IV alta" },
  { ticker: "AVGO", sector: "Semiconductores", razon: "Mega cap de semis, opciones activas" },
  { ticker: "MU", sector: "Semiconductores", razon: "Memoria, cíclica con cadena activa" },
  { ticker: "QCOM", sector: "Semiconductores", razon: "Semis grande con weeklies" },
  { ticker: "MSFT", sector: "Software", razon: "Mega cap estable, cadena profunda" },
  { ticker: "ORCL", sector: "Software", razon: "Software grande con opciones líquidas" },
  { ticker: "CRM", sector: "Software", razon: "Software mega cap, cadena activa" },
  { ticker: "AAPL", sector: "Hardware", razon: "La cadena de acción individual más líquida" },

  // ── Internet / Consumo digital ──
  { ticker: "META", sector: "Internet", razon: "Mega cap con IV alta" },
  { ticker: "GOOGL", sector: "Internet", razon: "Mega cap, cadena profunda" },
  { ticker: "AMZN", sector: "Comercio digital", razon: "Mega cap con cadena muy líquida" },
  { ticker: "NFLX", sector: "Streaming", razon: "Cadena líquida, prima alta" },
  { ticker: "UBER", sector: "Movilidad", razon: "Cadena líquida, IV media" },

  // ── Financieras ──
  { ticker: "JPM", sector: "Banca", razon: "Banco líder, cadena líquida" },
  { ticker: "BAC", sector: "Banca", razon: "Banco grande con opciones activas" },
  { ticker: "GS", sector: "Banca", razon: "Banca de inversión, cadena profunda" },
  { ticker: "V", sector: "Pagos", razon: "Pagos mega cap, opciones líquidas" },
  { ticker: "MA", sector: "Pagos", razon: "Pagos mega cap, cadena activa" },

  // ── Salud ──
  { ticker: "LLY", sector: "Farmacéutica", razon: "Farmacéutica grande, no binaria" },
  { ticker: "ABBV", sector: "Farmacéutica", razon: "Farmacéutica grande con dividendo" },
  { ticker: "UNH", sector: "Salud", razon: "Aseguradora mega cap, cadena líquida" },
  { ticker: "JNJ", sector: "Farmacéutica", razon: "Defensiva de calidad, opciones estables" },

  // ── Consumo ──
  { ticker: "COST", sector: "Consumo defensivo", razon: "Defensiva de calidad, cadena líquida" },
  { ticker: "WMT", sector: "Consumo defensivo", razon: "Retail mega cap, opciones activas" },
  { ticker: "HD", sector: "Consumo discrecional", razon: "Retail grande con weeklies" },
  { ticker: "NKE", sector: "Consumo discrecional", razon: "Marca global, cadena líquida" },
  { ticker: "DIS", sector: "Medios", razon: "Marca consolidada, prima decente" },

  // ── Energía / Industriales ──
  { ticker: "XOM", sector: "Energía", razon: "Petrolera integrada, cadena líquida" },
  { ticker: "CVX", sector: "Energía", razon: "Energía integrada con dividendo" },
  { ticker: "CAT", sector: "Industriales", razon: "Industrial cíclica, opciones activas" },
  { ticker: "BA", sector: "Industriales", razon: "Aeroespacial, cadena muy negociada" },

  // ── Alta beta con cadena muy líquida ──
  { ticker: "TSLA", sector: "Automóviles", razon: "IV alta persistente, cadena profunda" },
  { ticker: "PLTR", sector: "Software", razon: "IV alta y cadena muy negociada" },
  { ticker: "COIN", sector: "Cripto-financieras", razon: "IV muy alta, prima gorda, riesgo real" },
];

/** Set de tickers del universo, para validar pertenencia rápido. */
export const SPREAD_UNIVERSE_TICKERS = new Set(SPREAD_UNIVERSE.map((s) => s.ticker));
