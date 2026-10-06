// Universo del S&P 500 para el buscador de "Grandes empresas" (ago 2026,
// pedido explícito: "un buscador de tickets... pero solo va a ser
// de las 500 empresas del S&P500", con sugerencia por TICKER o por NOMBRE de
// la empresa — "a veces no me sé el nombre del ticket pero puedo poner el
// nombre de la empresa"). Snapshot de las 503 constituyentes reales (cruzado
// contra Wikipedia al armar esta lista, ago 2026 — incluye altas recientes
// como la escisión de Honeywell en HON/HONA y el spin-off FDX/FDXF, así que
// NO es una lista vieja de memoria). El S&P 500 cambia su composición unas
// pocas veces al año (altas/bajas por M&A, quiebras, rebalanceos) — si algún
// ticker queda desactualizado, se corrige acá a mano, no hace falta un
// pipeline de actualización automática para algo que se mueve tan poco.

import sp500Raw from "./sp500.json";

export interface Sp500Company {
  ticker: string;
  name: string;
}

// Los datos viven en lib/sp500.json (no inline acá, y NO en data/ — esa
// carpeta está en .gitignore para estado local acumulado/secretos, y este
// JSON es código fuente que tiene que viajar con el repo) para que
// scripts/premarket-movers-alert/scan.mjs —standalone, corre desde el
// Programador de tareas de Windows sin pasar por TypeScript/Next, mismo
// patrón que scripts/marketsnack-keepalive/— pueda leer EXACTAMENTE el mismo
// universo con `fs.readFile` + `JSON.parse`, sin duplicar 503 líneas a mano
// y sin arriesgarse a que las dos listas se desincronicen.
export const SP500: Sp500Company[] = sp500Raw;

export const SP500_TICKERS = new Set(SP500.map((c) => c.ticker));

/**
 * Autocompletado por ticker O por nombre de empresa (pedido explícito de
 * el usuario: "a veces no me sé el nombre del ticket pero puedo poner el nombre
 * de la empresa"). PURA — sin `fetch`, corre en el cliente en cada
 * keystroke. Orden de relevancia: ticker exacto > ticker empieza con la
 * búsqueda > nombre empieza con la búsqueda > nombre contiene la búsqueda en
 * cualquier parte — así "AAPL" no queda enterrada bajo nombres que solo
 * contienen esas letras en el medio.
 */
export function searchSp500(query: string, limit = 8): Sp500Company[] {
  const q = query.trim().toUpperCase();
  if (q.length === 0) return [];
  const qName = query.trim().toLowerCase();

  const exact: Sp500Company[] = [];
  const tickerPrefix: Sp500Company[] = [];
  const namePrefix: Sp500Company[] = [];
  const nameContains: Sp500Company[] = [];

  for (const c of SP500) {
    if (c.ticker === q) exact.push(c);
    else if (c.ticker.startsWith(q)) tickerPrefix.push(c);
    else if (c.name.toLowerCase().startsWith(qName)) namePrefix.push(c);
    else if (c.name.toLowerCase().includes(qName)) nameContains.push(c);
  }

  return [...exact, ...tickerPrefix, ...namePrefix, ...nameContains].slice(0, limit);
}
