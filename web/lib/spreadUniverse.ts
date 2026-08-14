// Universo curado del escáner de Credit Spreads (VENTA DE PRIMA). Se edita A MANO.
//
// Reglas:
//   1. ETFs de índice AMPLIO (SPY/QQQ/IWM) SÍ se permiten — son el vehículo estándar
//      de venta de prima: ultralíquidos, sin riesgo de earnings idiosincrático y con
//      la cadena semanal más profunda del mercado. El resto son acciones individuales
//      de alta liquidez. (Antes se prohibían los ETFs; el mandato original era para el
//      agente institucional de flujo, no para venta de prima.)
//   2. Deben ser plausiblemente elegibles: precio ≥ $30, con vencimientos semanales y
//      cadena muy líquida (cap ≥ $10B para acciones; los ETFs no gatean por cap). La
//      elegibilidad fina se verifica EN VIVO contra datos reales (lib/creditSpread.ts);
//      esta lista solo acota a nombres que valga la pena consultar.
//   3. El `sector` es obligatorio: la Sección 8 limita a UNA posición por sector por
//      semana, así que el motor/UI lo necesita para avisar de concentración.
//
// El módulo NO valida esta lista contra el mercado. Si un ticker deja de cumplir,
// se saca a mano y se anota por qué.

export interface SpreadSymbol {
  ticker: string;
  /** Sector para la regla de concentración (Sección 8). */
  sector: string;
  /** true si es un ETF de índice amplio (SPY/QQQ/IWM): no gatea por market cap. */
  isEtf?: boolean;
  razon: string;
}

export const SPREAD_UNIVERSE: SpreadSymbol[] = [
  // ── ETFs de índice amplio (el vehículo estándar de venta de prima) ──
  { ticker: "SPY", sector: "Índice", isEtf: true, razon: "S&P 500: la cadena semanal más líquida del mundo" },
  { ticker: "QQQ", sector: "Índice", isEtf: true, razon: "Nasdaq 100: weeklies profundos, prima constante" },
  { ticker: "IWM", sector: "Índice", isEtf: true, razon: "Russell 2000: índice amplio, cadena líquida" },

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
