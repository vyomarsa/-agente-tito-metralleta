// GET /api/spx-levels — "Soportes y Resistencias en vivo — SPX" (el usuario,
// 2026-07-30): net premium real (call vs put) por strike + GEX real de
// MarketSnack, con confluencia/conflicto entre ambos. JSON plano, no SSE —
// son 3 fetches rápidos en paralelo, sin pasos largos que narrar (mismo
// criterio que el poll de cuenta de RegistroOperacionesTab). SPX solamente
// (no recibe `ticker`) — ver lib/spxLevels.ts para el cálculo puro. También
// trae `topVolume` (2026-08-01): los 10 calls + 10 puts de mayor volumen del
// día, panel informativo aparte (ver lib/spxLevels.ts `topByVolume`).

import { buildSpxLevelsTable, topByVolume } from "@/lib/pdf/spxLevels";
import { fetchAssetPrice, fetchGexStats, fetchOptionChainExtended, MarketSnackError } from "@/lib/pdf/marketsnack";
import { marketDateStr } from "@/lib/pdf/occ";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICKER = "SPX";

export async function GET() {
  try {
    const now = new Date();
    // SPXW son semanales que expiran TODOS los días de mercado — 0DTE de hoy.
    const expiration = marketDateStr(now);

    const [spot, gexBuckets, contracts] = await Promise.all([
      fetchAssetPrice(TICKER),
      fetchGexStats(TICKER, { period: "1d" }),
      fetchOptionChainExtended(TICKER, expiration),
    ]);

    if (!spot || spot <= 0) {
      return Response.json({ error: "Sin precio en vivo para SPX." }, { status: 502 });
    }

    const gexStats = gexBuckets.at(-1) ?? null; // bucket más reciente
    const rows = buildSpxLevelsTable({ contracts, spot, gexStats });
    const topVolume = topByVolume(contracts);

    return Response.json({ spot, expiration, gexStats, rows, topVolume });
  } catch (err) {
    const message =
      err instanceof MarketSnackError ? err.message : "Error inesperado calculando los niveles de SPX.";
    return Response.json({ error: message }, { status: 502 });
  }
}
