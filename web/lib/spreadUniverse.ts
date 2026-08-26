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

  // ── Las 100 EMPRESAS del S&P 100 (OEX) ──
  // Ampliado de 38 a 103 en ago 2026 para igualar al motor de paper trading: antes
  // Tito miraba 38 símbolos y el ejecutor 103, así que /spreads enseñaba MENOS
  // candidatos que las posiciones que se abrían, y eso confundía.
  //
  // El OEX tiene 101 tickers porque Alphabet cotiza en dos clases: se conserva GOOGL
  // y se omite GOOG (mismo subyacente = doble exposición al mismo riesgo).
  // Tickers verificados uno a uno contra MarketSnack (2026-08-16) y REVISADOS contra
  // MarketSnack + Tastytrade el 2026-08-24. Ojo con tres:
  //   · BRKB = Berkshire clase B, SIN punto. Correcto en las DOS fuentes de opciones
  //     (15 vencimientos, 1 en banda). Solo **Massive** lo escribe `BRK.B`, y allí solo
  //     se le pide la capitalización: la traducción vive en `lib/marketCapStore.ts`.
  //     No cambiar este ticker — con punto, Tastytrade devuelve 0 vencimientos.
  //   · HONA salió y entró HON. `HONA` (Honeywell Aerospace, la escisión) resuelve en
  //     ambas fuentes pero **no tiene weeklies**: su vencimiento más cercano es el
  //     mensual a 25 DTE, así que jamás puede dar un candidato en la banda 4-7. `HON`
  //     (Honeywell International, la matriz, S&P 100) sí: 14 vencimientos, 1 en banda.
  //   · BNY se RETIRÓ. El ticker es correcto y la empresa existe (BNY Mellon, cap
  //     $107B; el viejo `BK` ya no resuelve), pero **tampoco tiene weeklies** — 7
  //     vencimientos, el primero a 25 DTE. No es un error de símbolo y no se arregla
  //     renombrando: el instrumento no sirve para esta estrategia. Sale por la regla 2.
  //
  // La afirmación anterior de que "los 103 tienen weeklies en la banda" era FALSA para
  // HONA y BNY: resuelven, pero solo con vencimientos mensuales. Comprobado en las dos
  // fuentes por separado, que coinciden exactamente.
  //
  // PENDIENTE — otros CUATRO con el mismo perfil, comprobados el 2026-08-24 y dejados
  // DENTRO a la espera de decidirlo: **AMT, DUK, LIN y SPG** solo tienen mensuales (el
  // más cercano a 25 DTE), así que tampoco pueden dar un candidato en la banda 4-7 y
  // salen siempre como "sin cadena 4–7 DTE". No estorban —fallan con gracia y pronto—
  // pero gastan una conexión de streamer por pasada. Si se sacan, el universo baja a 98.
  { ticker: "AAPL", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "ABBV", sector: "Salud", razon: "S&P 100" },
  { ticker: "ABT", sector: "Salud", razon: "S&P 100" },
  { ticker: "ACN", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "ADBE", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "AMAT", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "AMD", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "AMGN", sector: "Salud", razon: "S&P 100" },
  { ticker: "AMT", sector: "Inmobiliario", razon: "S&P 100" },
  { ticker: "AMZN", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "AVGO", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "AXP", sector: "Financiero", razon: "S&P 100" },
  { ticker: "BA", sector: "Industrial", razon: "S&P 100" },
  { ticker: "BAC", sector: "Financiero", razon: "S&P 100" },
  { ticker: "BKNG", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "BLK", sector: "Financiero", razon: "S&P 100" },
  { ticker: "BMY", sector: "Salud", razon: "S&P 100" },
  { ticker: "BRKB", sector: "Financiero", razon: "S&P 100" },
  { ticker: "C", sector: "Financiero", razon: "S&P 100" },
  { ticker: "CAT", sector: "Industrial", razon: "S&P 100" },
  { ticker: "CL", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "CMCSA", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "COF", sector: "Financiero", razon: "S&P 100" },
  { ticker: "COP", sector: "Energía", razon: "S&P 100" },
  { ticker: "COST", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "CRM", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "CSCO", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "CVS", sector: "Salud", razon: "S&P 100" },
  { ticker: "CVX", sector: "Energía", razon: "S&P 100" },
  { ticker: "DE", sector: "Industrial", razon: "S&P 100" },
  { ticker: "DHR", sector: "Salud", razon: "S&P 100" },
  { ticker: "DIS", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "DUK", sector: "Utilities", razon: "S&P 100" },
  { ticker: "EMR", sector: "Industrial", razon: "S&P 100" },
  { ticker: "FDX", sector: "Industrial", razon: "S&P 100" },
  { ticker: "GD", sector: "Industrial", razon: "S&P 100" },
  { ticker: "GE", sector: "Industrial", razon: "S&P 100" },
  { ticker: "GEV", sector: "Industrial", razon: "S&P 100" },
  { ticker: "GILD", sector: "Salud", razon: "S&P 100" },
  { ticker: "GM", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "GOOGL", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "GS", sector: "Financiero", razon: "S&P 100" },
  { ticker: "HD", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "HON", sector: "Industrial", razon: "S&P 100" },
  { ticker: "IBM", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "INTC", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "INTU", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "ISRG", sector: "Salud", razon: "S&P 100" },
  { ticker: "JNJ", sector: "Salud", razon: "S&P 100" },
  { ticker: "JPM", sector: "Financiero", razon: "S&P 100" },
  { ticker: "KO", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "LIN", sector: "Materiales", razon: "S&P 100" },
  { ticker: "LLY", sector: "Salud", razon: "S&P 100" },
  { ticker: "LMT", sector: "Industrial", razon: "S&P 100" },
  { ticker: "LOW", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "LRCX", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "MA", sector: "Financiero", razon: "S&P 100" },
  { ticker: "MCD", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "MDLZ", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "MDT", sector: "Salud", razon: "S&P 100" },
  { ticker: "META", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "MMM", sector: "Industrial", razon: "S&P 100" },
  { ticker: "MO", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "MRK", sector: "Salud", razon: "S&P 100" },
  { ticker: "MS", sector: "Financiero", razon: "S&P 100" },
  { ticker: "MSFT", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "MU", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "NEE", sector: "Utilities", razon: "S&P 100" },
  { ticker: "NFLX", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "NKE", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "NOW", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "NVDA", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "ORCL", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "PEP", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "PFE", sector: "Salud", razon: "S&P 100" },
  { ticker: "PG", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "PLTR", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "PM", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "QCOM", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "RTX", sector: "Industrial", razon: "S&P 100" },
  { ticker: "SBUX", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "SCHW", sector: "Financiero", razon: "S&P 100" },
  { ticker: "SO", sector: "Utilities", razon: "S&P 100" },
  { ticker: "SPG", sector: "Inmobiliario", razon: "S&P 100" },
  { ticker: "T", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "TMO", sector: "Salud", razon: "S&P 100" },
  { ticker: "TMUS", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "TSLA", sector: "Consumo discrecional", razon: "S&P 100" },
  { ticker: "TXN", sector: "Tecnología", razon: "S&P 100" },
  { ticker: "UBER", sector: "Industrial", razon: "S&P 100" },
  { ticker: "UNH", sector: "Salud", razon: "S&P 100" },
  { ticker: "UNP", sector: "Industrial", razon: "S&P 100" },
  { ticker: "UPS", sector: "Industrial", razon: "S&P 100" },
  { ticker: "USB", sector: "Financiero", razon: "S&P 100" },
  { ticker: "V", sector: "Financiero", razon: "S&P 100" },
  { ticker: "VZ", sector: "Comunicación", razon: "S&P 100" },
  { ticker: "WFC", sector: "Financiero", razon: "S&P 100" },
  { ticker: "WMT", sector: "Consumo básico", razon: "S&P 100" },
  { ticker: "XOM", sector: "Energía", razon: "S&P 100" },
];

/** Set de tickers del universo, para validar pertenencia rápido. */
export const SPREAD_UNIVERSE_TICKERS = new Set(SPREAD_UNIVERSE.map((s) => s.ticker));
