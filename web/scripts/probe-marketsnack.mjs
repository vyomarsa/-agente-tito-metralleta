// Sonda de descubrimiento para "Option Chain 2.0" de MarketSnack.
// Lee MARKETSNACK_COOKIE de .env.local y prueba rutas candidatas.
// NO imprime la cookie. Uso: node scripts/probe-marketsnack.mjs [TICKER]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env.local");

function readCookie() {
  const txt = readFileSync(envPath, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^MARKETSNACK_COOKIE=(.*)$/);
    if (m) return m[1].trim();
  }
  throw new Error("No MARKETSNACK_COOKIE en .env.local");
}

const TICKER = (process.argv[2] || "AAPL").toUpperCase();
const BASE = "https://app.marketsnack.com";
const cookie = readCookie();

// Rutas candidatas basadas en el patrón de /api/flow_feed. El shape real lo
// vemos el lunes; esto solo detecta cuáles YA existen (200 vs 404/redirect).
const candidates = [
  `/api/option_chain?filter[symbol][]=${TICKER}`,
  `/api/option_chain_feed?filter[symbol][]=${TICKER}`,
  `/api/options?filter[symbol][]=${TICKER}`,
  `/api/options_chain?filter[symbol][]=${TICKER}`,
  `/api/chain?filter[symbol][]=${TICKER}`,
  `/api/gex?filter[symbol][]=${TICKER}`,
  `/api/gamma?filter[symbol][]=${TICKER}`,
  `/api/magnets?filter[symbol][]=${TICKER}`,
  `/api/open_interest?filter[symbol][]=${TICKER}`,
  `/api/option_chain/${TICKER}`,
  `/api/v2/option_chain?filter[symbol][]=${TICKER}`,
];

async function probe(path) {
  const url = BASE + path;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Cookie: cookie },
      redirect: "manual",
    });
    let sample = "";
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.includes("json")) {
      const body = await res.text();
      sample = body.slice(0, 240).replace(/\s+/g, " ");
    }
    return { path, status: res.status, ct: ct.slice(0, 40), sample };
  } catch (e) {
    return { path, status: "ERR", ct: "", sample: String(e).slice(0, 80) };
  }
}

console.log(`Sondeando MarketSnack para ${TICKER}...\n`);
for (const c of candidates) {
  const r = await probe(c);
  const flag = r.status === 200 ? "  <<< VIVO (200)" : "";
  console.log(`${String(r.status).padEnd(4)} ${r.ct.padEnd(22)} ${r.path}${flag}`);
  if (r.sample) console.log(`     ${r.sample}`);
}
console.log("\nListo. Las 200 con JSON son endpoints ya activos.");
