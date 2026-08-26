// Liquida a VALOR INTRÍNSECO las posiciones de la bitácora que vencieron sin precio.
//
//   node scripts/liquidar-vencidas.mjs           → enseña qué haría
//   node scripts/liquidar-vencidas.mjs --aplicar → lo escribe
//
// POR QUÉ: la cadena de un vencimiento ya pasado llega vacía, así que esos cierres
// se anotaban sin precio y su P&L quedaba en "no se sabe". Pero al vencimiento el
// precio NO hace falta pedirlo: una opción vale exactamente lo que cuesta ejercerla
// (call = spot − strike, put = strike − spot, nunca menos de 0). El motor ya lo hace
// desde el 2026-08-24; esto arregla las filas que se cerraron antes.
//
// CON QUÉ PRECIO: con el CIERRE DEL DÍA EN QUE VENCIÓ, que se le pide a `/api/bars`
// (misma cascada Tastytrade → Massive → Schwab que usa la app, ya cacheada en disco).
// NO con el spot guardado en el trade: ese es de la sesión siguiente, porque el
// vencimiento solo se detecta al día siguiente. Con el USO 111C la diferencia eran
// $2.364 contra $2.116 — la misma posición y el doble de ganancia.
//
// Si no hay barra de ese día, la fila se deja como está. Sin el precio correcto es
// preferible "no se sabe" a un número de otro día.

import { promises as fs } from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "paper-trades.json");
const API = "http://127.0.0.1:3000/api/bars";
const APLICAR = process.argv.includes("--aplicar");
const CERRADOS = new Set(["ganada", "perdida", "expirada"]);

const dinero = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Venció estando dentro, y se quedó sin precio de salida. */
function pendienteDeLiquidar(t) {
  return (
    CERRADOS.has(t.status) &&
    t.closeReason === "expirada" &&
    t.entryPrice != null &&
    t.exitPrice == null
  );
}

function intrinseco(t, spot) {
  const bruto = t.optionType === "call" ? spot - t.strike : t.strike - spot;
  return Math.max(0, Math.round(bruto * 10000) / 10000);
}

/** Cierre del día `fecha` para `ticker`, por la misma ruta que usa la app. */
async function cierreEn(ticker, fecha) {
  const r = await fetch(`${API}?ticker=${encodeURIComponent(ticker)}&tf=1y`);
  if (!r.ok) return null;
  const d = await r.json();
  const bar = (d.bars ?? []).find((b) => new Date(b.time * 1000).toISOString().slice(0, 10) === fecha);
  return bar?.close ?? null;
}

const raw = JSON.parse(await fs.readFile(FILE, "utf8"));
const trades = Array.isArray(raw) ? raw : raw.trades;
const candidatas = trades.filter(pendienteDeLiquidar);

console.log(`Libro: ${trades.length} trades · vencidas sin precio: ${candidatas.length}`);

const cambios = [];
for (const t of candidatas) {
  const spot = await cierreEn(t.ticker, t.expiration);
  const tipo = t.optionType === "call" ? "C" : "P";
  if (spot == null) {
    console.log(`  ${t.ticker.padEnd(6)} ${t.strike}${tipo} ${t.expiration}  SIN barra de ese día → se deja sin precio`);
    continue;
  }
  const salida = intrinseco(t, spot);
  const pnl = (salida - t.entryPrice) * 100 * t.contracts;
  const desenlace = pnl > 0 ? "acierto" : pnl < 0 ? "fallo" : "sin decidir";
  console.log(
    `  ${t.ticker.padEnd(6)} ${t.strike}${tipo} ${t.expiration}  cerró ${spot} → intrínseco ${salida}  ` +
      `· pagaste ${dinero(t.entryPrice * 100 * t.contracts)} · P&L ${pnl >= 0 ? "+" : "−"}${dinero(Math.abs(pnl))} · ${desenlace}`,
  );
  cambios.push({ t, salida });
}

if (cambios.length === 0) {
  console.log("\nNada que liquidar.");
} else if (!APLICAR) {
  console.log("\nEnsayo. Vuelve a lanzarlo con --aplicar para escribirlo.");
} else {
  const copia = `${FILE}.antes-de-liquidar-${new Date().toISOString().slice(0, 10)}.json`;
  await fs.writeFile(copia, JSON.stringify(raw, null, 2), "utf8");
  for (const { t, salida } of cambios) {
    t.exitPrice = salida;
    // El `status` se queda en "expirada" y NO se cambia a ganada/perdida: es lo que
    // hace el motor (`close("expirada", ...)`) y dos criterios distintos para la
    // misma fila es justo la divergencia que este arreglo viene a cerrar. Quien
    // decide el acierto es `outcomeOf`, que para una expirada mira el P&L.
  }
  await fs.writeFile(FILE, JSON.stringify(raw, null, 2), "utf8");
  console.log(`\n✅ ${cambios.length} liquidada(s). Copia previa en ${path.basename(copia)}`);
}
