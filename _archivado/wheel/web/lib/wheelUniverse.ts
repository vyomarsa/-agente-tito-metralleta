// Universo curado del screener de Wheel. Se edita A MANO.
//
// Criterios de admisión, en orden (§4.1 del spec):
//   1. Opcionabilidad real: vencimientos semanales y OI agregado alto.
//   2. Sería aceptable poseerla: la Wheel te puede dejar con 100 acciones
//      durante meses. Nada de quiebras ni biotecnológicas binarias.
//   3. Cobertura de tramos de precio, para que una cuenta chica opere.
//   4. Los ETFs de índice van aparte: menor riesgo idiosincrático.
//
// El módulo NO valida esta lista contra el mercado. Si un ticker deja de
// cumplir, se saca a mano y se anota por qué.

export type WheelTier = "etf" | "barato" | "medio" | "caro";

export interface WheelSymbol {
  ticker: string;
  tier: WheelTier;
  razon: string;
}

export const WHEEL_UNIVERSE: WheelSymbol[] = [
  // ── ETFs de índice: el caso de menor riesgo idiosincrático ──
  { ticker: "SPY", tier: "etf", razon: "S&P 500 — la cadena más líquida del mundo" },
  { ticker: "QQQ", tier: "etf", razon: "Nasdaq 100 — muy líquido, más prima que SPY" },
  { ticker: "IWM", tier: "etf", razon: "Small caps — colateral moderado" },
  { ticker: "DIA", tier: "etf", razon: "Dow 30 — prima baja pero estable" },
  { ticker: "XLF", tier: "etf", razon: "Financieras — colateral bajo para un ETF" },
  { ticker: "XLE", tier: "etf", razon: "Energía — IV alta con frecuencia" },

  // ── Caro: casi siempre fuera del alcance de cuentas chicas, útil de referencia ──
  { ticker: "NVDA", tier: "caro", razon: "Mega cap con la prima más gorda del índice" },
  { ticker: "MSFT", tier: "caro", razon: "Mega cap estable, cadena profunda" },
  { ticker: "META", tier: "caro", razon: "Mega cap con IV alta" },
  { ticker: "NFLX", tier: "caro", razon: "Cadena líquida, prima alta" },
  { ticker: "AVGO", tier: "caro", razon: "Semis de mega cap, opciones activas" },
  { ticker: "COST", tier: "caro", razon: "Defensiva de calidad, poseerla no duele" },
  { ticker: "LLY", tier: "caro", razon: "Farmacéutica grande, no binaria" },

  // ── Medio ──
  { ticker: "AAPL", tier: "medio", razon: "La cadena de acción individual más líquida" },
  { ticker: "AMZN", tier: "medio", razon: "Mega cap con colateral alcanzable" },
  { ticker: "GOOGL", tier: "medio", razon: "Mega cap, cadena profunda" },
  { ticker: "TSLA", tier: "medio", razon: "IV alta de forma persistente" },
  { ticker: "AMD", tier: "medio", razon: "Semis con IV alta y cadena líquida" },
  { ticker: "DIS", tier: "medio", razon: "Marca consolidada, prima decente" },
  { ticker: "BAC", tier: "medio", razon: "Banco grande, colateral bajo" },
  { ticker: "KO", tier: "medio", razon: "Defensiva con dividendo — cómoda de poseer" },
  { ticker: "PFE", tier: "medio", razon: "Farmacéutica grande con dividendo" },
  { ticker: "INTC", tier: "medio", razon: "Semis barata, cadena muy activa" },
  { ticker: "UBER", tier: "medio", razon: "Cadena líquida, IV media" },
  { ticker: "COIN", tier: "medio", razon: "IV muy alta — prima gorda, riesgo real" },
  { ticker: "MU", tier: "medio", razon: "Memoria, cíclica con IV alta" },
  { ticker: "CVX", tier: "medio", razon: "Energía integrada con dividendo" },

  // ── Barato: donde una cuenta pequeña puede operar de verdad ──
  { ticker: "F", tier: "barato", razon: "Colateral bajo y cadena sorprendentemente líquida" },
  { ticker: "SOFI", tier: "barato", razon: "Fintech barata con opciones activas" },
  { ticker: "PLTR", tier: "barato", razon: "IV alta y cadena muy negociada" },
  { ticker: "NIO", tier: "barato", razon: "Colateral bajo, IV alta — riesgo país declarado" },
  { ticker: "WULF", tier: "barato", razon: "Minería de bitcoin, colateral muy bajo" },
  { ticker: "RIOT", tier: "barato", razon: "Proxy de bitcoin con IV alta" },
  { ticker: "MARA", tier: "barato", razon: "Proxy de bitcoin, cadena activa" },
  { ticker: "CCL", tier: "barato", razon: "Cruceros, colateral bajo" },
  { ticker: "SNAP", tier: "barato", razon: "Colateral bajo, IV alta" },
  { ticker: "T", tier: "barato", razon: "Telecom con dividendo — cómoda de poseer" },
  { ticker: "VALE", tier: "barato", razon: "Minera con dividendo y colateral bajo" },
  { ticker: "HOOD", tier: "barato", razon: "Bróker, IV alta" },
  { ticker: "LCID", tier: "barato", razon: "Colateral mínimo — el más especulativo de la lista" },
];
