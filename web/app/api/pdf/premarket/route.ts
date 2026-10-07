// GET /api/pdf/premarket — movimientos del S&P 500 en la sesión extendida
// (pre-market o after-hours) para la pestaña "Pre-market" de Prueba de Fuego.
// Mismo cálculo que la alerta de Telegram (lib/pdf/premarketMovers.ts).
//
// Escanear las ~500 tarda ~6 s con MarketSnack (más con Tastytrade), así que se
// guarda 60 s en memoria: varias pestañas abiertas o el refresco automático no
// multiplican la carga. `?fresh=1` salta la cache (botón "Actualizar").

import { scanExtendedMoves, type ExtendedScan } from "@/lib/pdf/premarketMovers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 60_000;
let cache: { at: number; p: Promise<ExtendedScan> } | null = null;

export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (fresh || !cache || Date.now() - cache.at > TTL_MS) {
    const p = scanExtendedMoves({ sessions: ["Pre-market", "After hours"] });
    cache = { at: Date.now(), p };
    p.catch(() => { if (cache?.p === p) cache = null; }); // un fallo no se cachea
  }
  try {
    return Response.json(await cache.p);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "No se pudo escanear la sesión extendida." },
      { status: 502 },
    );
  }
}
