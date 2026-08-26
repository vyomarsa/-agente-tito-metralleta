// Repara el libro de "Mis Trades" tras el bug del P&L en cero (2026-08-24).
//
//   node scripts/reparar-salidas-inventadas.mjs          → enseña qué haría
//   node scripts/reparar-salidas-inventadas.mjs --aplicar → lo escribe
//
// QUÉ PASÓ: al cerrar un trade, `evaluate` usaba la prima RANCIA cuando la cadena no
// traía el contrato. Sin re-cotización esa prima es la de entrada, así que el libro
// guardó "salió al mismo precio al que entró" — un dato INVENTADO — y el P&L de esas
// operaciones quedó en $0. El motor ya no lo hace (deja la salida sin precio), pero
// las filas que se escribieron con el bug siguen ahí.
//
// QUÉ HACE: a los cierres con la huella del bug les quita el precio de salida. NO
// inventa un precio nuevo ni toca el desenlace (ganada/perdida): el desenlace lo
// decidió el SUBYACENTE y ese dato sí era bueno. Lo único que se borra es el número
// falso, para que el P&L diga "no se sabe" en vez de "cero".
//
// LA HUELLA: entrada, salida, pico y precio actual IDÉNTICOS al céntimo. Que una
// prima no se mueva ni un céntimo en varios días, y que además su máximo coincida
// exactamente con la entrada, no pasa en un contrato que se cotiza de verdad.

import { promises as fs } from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "paper-trades.json");
const APLICAR = process.argv.includes("--aplicar");
const CERRADOS = new Set(["ganada", "perdida", "expirada"]);

/** ¿Esta fila tiene la huella de una salida inventada por el bug? */
function salidaInventada(t) {
  if (!CERRADOS.has(t.status)) return false;
  if (t.entryPrice == null || t.exitPrice == null) return false;
  return (
    t.exitPrice === t.entryPrice &&
    t.peakPrice === t.entryPrice &&
    t.currentPrice === t.entryPrice
  );
}

const raw = JSON.parse(await fs.readFile(FILE, "utf8"));
const trades = Array.isArray(raw) ? raw : raw.trades;
const tocados = trades.filter(salidaInventada);

console.log(`Libro: ${trades.length} trades · con salida inventada: ${tocados.length}`);
for (const t of tocados) {
  const tipo = t.optionType === "call" ? "C" : "P";
  console.log(
    `  ${t.ticker.padEnd(6)} ${t.strike}${tipo} ${t.expiration}  ` +
      `entró ${t.entryPrice} → "salió" ${t.exitPrice}  (${t.closeReason})  ⇒ salida sin precio`,
  );
}

if (tocados.length === 0) {
  console.log("Nada que reparar.");
} else if (!APLICAR) {
  console.log("\nEnsayo. Vuelve a lanzarlo con --aplicar para escribirlo.");
} else {
  const copia = `${FILE}.antes-de-reparar-${new Date().toISOString().slice(0, 10)}.json`;
  await fs.writeFile(copia, JSON.stringify(raw, null, 2), "utf8");
  for (const t of tocados) t.exitPrice = null;
  await fs.writeFile(FILE, JSON.stringify(raw, null, 2), "utf8");
  console.log(`\n✅ ${tocados.length} salida(s) sin precio. Copia previa en ${path.basename(copia)}`);
}
