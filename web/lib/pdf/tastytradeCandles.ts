// Lee el caché en disco que arma `scripts/tastytrade-candles/candle-streamer.mjs`
// (proceso aparte, streaming DXLink de tastytrade) — respaldo de
// `fetchAssetPriceChart` (MarketSnack) para "Grandes empresas" cuando ese
// feed queda atrasado (visto en vivo 2026-08-20: no arrancaba su "hoy" ni a
// las 9am ET). tastytrade no tiene REST de velas (solo DXLink, streaming),
// así que este archivo NUNCA pega a la red — solo lee lo que el streamer ya
// dejó en `data/tastytrade-candles/{TICKER}.json` (gitignored, mismo shape
// `TfBar[]` que ya usa el resto del proyecto). Si el streamer no está
// corriendo, el archivo no existe todavía, o quedó corrupto → `[]`, nunca
// error — es un respaldo opcional, no una fuente obligatoria.

import { promises as fs } from "fs";
import path from "path";
import type { TfBar } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "pdf", "tastytrade-candles");

function isTfBar(v: unknown): v is TfBar {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.time === "number" &&
    typeof b.open === "number" &&
    typeof b.high === "number" &&
    typeof b.low === "number" &&
    typeof b.close === "number"
  );
}

export async function fetchTastytradeCandles(ticker: string): Promise<TfBar[]> {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, `${ticker.trim().toUpperCase()}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTfBar) : [];
  } catch {
    return [];
  }
}
