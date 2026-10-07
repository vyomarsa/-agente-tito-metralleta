// GET /api/pdf/premarket-analysis — análisis de pre-market de SPY, QQQ, SPX y las
// 7 magníficas (lib/pdf/premarketAnalysis.ts). Cuesta ~varias decenas de
// segundos (cadena + velas por ticker), así que se guarda 2 min en memoria;
// `?fresh=1` salta la cache.

import { analyzePremarket } from "@/lib/pdf/premarketAnalysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 2 * 60_000;
let cache: { at: number; p: ReturnType<typeof analyzePremarket> } | null = null;

export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (fresh || !cache || Date.now() - cache.at > TTL_MS) {
    const p = analyzePremarket();
    cache = { at: Date.now(), p };
    p.catch(() => { if (cache?.p === p) cache = null; });
  }
  try {
    return Response.json(await cache.p);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "No se pudo armar el análisis de pre-market." },
      { status: 502 },
    );
  }
}
