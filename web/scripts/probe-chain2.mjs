// Sonda fina sobre /api/options_chain (existe, devuelve {}). Prueba variantes de params.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
function readCookie() {
  const txt = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^MARKETSNACK_COOKIE=(.*)$/);
    if (m) return m[1].trim();
  }
  throw new Error("No cookie");
}
const T = (process.argv[2] || "AAPL").toUpperCase();
const BASE = "https://app.marketsnack.com";
const cookie = readCookie();

const variants = [
  `/api/options_chain`,
  `/api/options_chain?symbol=${T}`,
  `/api/options_chain?ticker=${T}`,
  `/api/options_chain?filter[symbol]=${T}`,
  `/api/options_chain?filter[symbol][]=${T}`,
  `/api/options_chain?filter[scope]=all&filter[symbol][]=${T}`,
  `/api/options_chain?filter[symbol][]=${T}&period=5d`,
  `/api/options_chain?filter[symbol][]=${T}&expiration=2026-08-21`,
  `/api/options_chain?filter[ticker][]=${T}`,
  `/api/options_chain?filter[underlying][]=${T}`,
  `/api/options_chain?filter[symbol][]=${T}&group_by=expiration`,
];

async function probe(path) {
  try {
    const res = await fetch(BASE + path, {
      headers: { Accept: "application/json", Cookie: cookie },
      redirect: "manual",
    });
    let body = "";
    if ((res.headers.get("content-type") || "").includes("json")) {
      body = (await res.text()).slice(0, 500).replace(/\s+/g, " ");
    }
    return { path, status: res.status, body };
  } catch (e) {
    return { path, status: "ERR", body: String(e).slice(0, 80) };
  }
}
for (const v of variants) {
  const r = await probe(v);
  const nonEmpty = r.body && r.body !== "{}" ? "  <<< DATOS" : "";
  console.log(`${String(r.status).padEnd(4)} ${v}${nonEmpty}`);
  if (r.body) console.log(`     ${r.body}`);
}
