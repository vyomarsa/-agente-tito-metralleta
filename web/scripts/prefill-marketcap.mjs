// Prellena data/marketcap.json con la capitalización del universo de venta de prima.
//
// El filtro de elegibilidad exige cap ≥ $10B para acciones. La única fuente es el
// endpoint de referencia de Massive, y con el plan gratis (5 peticiones/minuto)
// pedirla dentro del escaneo hacía que los 103 símbolos salieran "sin precio".
// Se llena una vez y `lib/marketCapStore.ts` la sirve con TTL de 30 días.
//
// Va DELIBERADAMENTE lento (1 cada 18 s ≈ 3,3/min) para dejarle cuota al servidor,
// que durante este rato sigue atendiendo gráficas y escaneos.
//
//   node scripts/prefill-marketcap.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = path.join(ROOT, "data", "marketcap.json");
const GAP_MS = 18_000;

// Massive escribe las clases de acción con punto; el universo guarda la forma de
// las fuentes de opciones. Misma tabla que en lib/marketCapStore.ts — si crece una,
// crece la otra. La clave del fichero es SIEMPRE el ticker del universo.
const MASSIVE_SYMBOL = { BRKB: "BRK.B" };
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const KEY = env.MASSIVE_API_KEY;
if (!KEY) { console.error("Falta MASSIVE_API_KEY en .env.local"); process.exit(1); }

// El universo se lee del propio fuente para no mantener dos listas.
const universe = [...readFileSync(path.join(ROOT, "lib", "spreadUniverse.ts"), "utf8")
  .matchAll(/ticker:\s*"([A-Z.]+)"/g)].map((m) => m[1]);
if (universe.length === 0) { console.error("No se pudo leer el universo"); process.exit(1); }

const book = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const now = Date.now();
// Las entradas con `cap: null` son el cache NEGATIVO que escribe lib/marketCapStore
// ("Massive respondió y no hay cap"). Aquí se reintentan siempre: este guion se
// lanza a mano, justo para llenar huecos, y saltárselos lo dejaría sin trabajo que
// hacer. En el servidor sí caducan solas a los 7 días.
const pending = universe.filter((t) => {
  const e = book[t];
  if (!e) return true;
  if (e.cap == null) return true;
  return now - e.at >= TTL_MS;
});

console.log(`universo ${universe.length} · ya en cache ${universe.length - pending.length} · por pedir ${pending.length}`);
console.log(`ritmo 1 cada ${GAP_MS / 1000}s → ~${Math.ceil((pending.length * GAP_MS) / 60000)} min`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;

for (const [i, ticker] of pending.entries()) {
  try {
    const res = await fetch(
      `https://api.massive.com/v3/reference/tickers/${encodeURIComponent(MASSIVE_SYMBOL[ticker] ?? ticker)}`,
      { headers: { Authorization: `Bearer ${KEY}` } },
    );
    if (res.ok) {
      const cap = (await res.json())?.results?.market_cap;
      if (typeof cap === "number" && cap > 0) {
        book[ticker] = { cap, at: Date.now() };
        // Se guarda tras CADA símbolo: si esto se corta a medias, lo hecho queda.
        mkdirSync(path.dirname(FILE), { recursive: true });
        writeFileSync(FILE, JSON.stringify(book), "utf8");
        ok++;
        console.log(`  [${i + 1}/${pending.length}] ${ticker} → $${(cap / 1e9).toFixed(1)}B`);
      } else {
        // Massive CONTESTÓ y no hay cap → se anota el negativo, igual que hace el
        // servidor, para que no vuelva a preguntarlo en cada consulta. Un HTTP que
        // falla (abajo) NO se anota: eso es "no pude preguntar", no "no hay cap".
        book[ticker] = { cap: null, at: Date.now() };
        mkdirSync(path.dirname(FILE), { recursive: true });
        writeFileSync(FILE, JSON.stringify(book), "utf8");
        fail++;
        console.log(`  [${i + 1}/${pending.length}] ${ticker} → sin market_cap (anotado)`);
      }
    } else { fail++; console.log(`  [${i + 1}/${pending.length}] ${ticker} → HTTP ${res.status}`); }
  } catch (e) { fail++; console.log(`  [${i + 1}/${pending.length}] ${ticker} → ${e?.message ?? e}`); }
  if (i < pending.length - 1) await sleep(GAP_MS);
}

console.log(`\nlisto: ${ok} guardadas, ${fail} fallidas · total en cache ${Object.keys(book).length}`);
