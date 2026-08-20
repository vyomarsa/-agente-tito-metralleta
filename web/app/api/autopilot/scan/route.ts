// POST /api/autopilot/scan — el PILOTO AUTOMÁTICO (Fase 2). Escanea el mercado, arma
// candidatos por dos vías y abre los fuertes como paper trades marcados AUTO (pendientes:
// no "entran" hasta que el subyacente cruza el gatillo). NADA mueve dinero real.
//
//  (a) INTRADÍA: GEX (dirección + imán + confianza) sobre un puñado de nombres líquidos.
//  (b) SWING: flujo institucional inusual + acierto histórico (misma maquinaria que /ideas).
//
// El disparo es manual (botón en Mis Trades). El bucle de fondo + alertas por Telegram es
// la Fase 3. Honestidad: "probabilidad" = fuerza del setup, no una garantía.

import { randomUUID } from "crypto";
import {
  swingCandidate,
  intradayCandidate,
  selectCandidates,
  DEFAULT_CONTRACTS,
  type Candidate,
  type SwingSignal,
  type IntradaySignal,
} from "@/lib/autopilot";
import { loadPaperTrades, savePaperTrades } from "@/lib/paperTradeStore";
import { isOpen, type PaperTrade } from "@/lib/paperTrade";
import { fetchMarketFlow } from "@/lib/marketsnack";
import { marketsnackConfigured } from "@/lib/marketsnackCookie";
import { classifyFlow, type FlowRow } from "@/lib/flow";
import { isTradeableIdea, withinMoneyness } from "@/lib/risk";
import { fetchCompany, fetchOptionChain, fetchDailyBars } from "@/lib/massive";
import { toRow } from "@/lib/compute";
import { gexAnalysis } from "@/lib/gex";
import { cachedDailyBars } from "@/lib/barsStore";
import { validationScore, type FlowLite } from "@/lib/validation";
import { loadTrades } from "@/lib/store";
import type { Row } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Nombres muy líquidos para la vía intradía. Pequeño a propósito: cada uno cuesta un
// snapshot de opciones de Massive (la llamada cara). Ampliar con cuidado.
const INTRADAY_UNIVERSE = ["SPY", "QQQ", "NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT"];
const SWING_MIN_PREMIUM = 500_000;
const SWING_MAX_PAGES = 6;
const SWING_MAX_IDEAS = 40;
const SWING_MAX_HISTORY = 12; // tope de tickers a los que se les calcula el acierto histórico
const MAX_OPEN_PER_SCAN = 8; // no inundar la bitácora: solo los más fuertes por escaneo
const CONCURRENCY = 3;

function marketDateStr(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function dedupeByContract(rows: FlowRow[]): FlowRow[] {
  const best = new Map<string, FlowRow>();
  for (const r of rows) {
    const prev = best.get(r.symbol);
    if (!prev || r.premium > prev.premium) best.set(r.symbol, r);
  }
  return [...best.values()];
}

function toFlowLite(t: FlowRow): FlowLite {
  return {
    id: t.id, timestamp: t.timestamp, type: t.type, strike: t.strike,
    expiration: t.expiration, assetPrice: t.assetPrice, premium: t.premium, aggression: t.aggression,
  };
}

// --- Vía SWING: flujo inusual + acierto histórico -------------------------
async function scanSwing(now: Date): Promise<{ candidates: Candidate[]; considered: number }> {
  const { trades } = await fetchMarketFlow({ period: "1d", minPremium: SWING_MIN_PREMIUM, maxPages: SWING_MAX_PAGES });
  const { rows } = classifyFlow(trades, now);
  const tradeable = dedupeByContract(rows.filter((r) => isTradeableIdea(r) && withinMoneyness(r)))
    .filter((r) => r.strike != null && r.expiration != null && (r.type === "call" || r.type === "put"))
    .sort((a, b) => b.premium - a.premium)
    .slice(0, SWING_MAX_IDEAS);

  // Acierto histórico (sub-agente 6) para los tickers con flujo guardado, capado.
  const tickers = [...new Set(tradeable.map((r) => r.underlying))];
  const hitRateBy = new Map<string, number | null>();
  const withStored: { ticker: string; flows: FlowLite[] }[] = [];
  for (const ticker of tickers) {
    const stored = await loadTrades(ticker);
    const flows = (stored?.trades ?? []).filter((t) => t.assetPrice > 0 && t.timestamp).map(toFlowLite);
    if (flows.length > 0) withStored.push({ ticker, flows });
  }
  for (const { ticker, flows } of withStored.slice(0, SWING_MAX_HISTORY)) {
    const bars = await fetchDailyBars(ticker, 200).catch(() => []);
    if (bars.length === 0) continue;
    hitRateBy.set(ticker, validationScore({ flows, bars, now }).hitRate.value);
  }

  const candidates: Candidate[] = [];
  for (const r of tradeable) {
    const sig: SwingSignal = {
      ticker: r.underlying,
      optionType: r.type === "put" ? "put" : "call",
      strike: r.strike as number,
      expiration: r.expiration as string,
      assetPrice: r.assetPrice,
      unusualScore: r.scores?.total ?? 0,
      hitRate: hitRateBy.get(r.underlying) ?? null,
    };
    const c = swingCandidate(sig, now);
    if (c) candidates.push(c);
  }
  return { candidates, considered: tradeable.length };
}

// --- Vía INTRADÍA: GEX sobre nombres líquidos ------------------------------
function pickContract(rows: Row[], spot: number, type: "call" | "put", now: Date): { strike: number; expiration: string } | null {
  const today = marketDateStr(now);
  const future = rows.filter((r) => r.expiration >= today && r.contractType === type);
  if (future.length === 0) return null;
  const exp = future.map((r) => r.expiration).sort()[0]; // vencimiento más cercano
  const atExp = future.filter((r) => r.expiration === exp);
  const best = atExp.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
  return { strike: best.strike, expiration: exp };
}

async function scanIntraday(now: Date): Promise<{ candidates: Candidate[]; considered: number }> {
  const results = await mapLimit(INTRADAY_UNIVERSE, CONCURRENCY, async (ticker) => {
    try {
      const [{ contracts, underlyingPrice }, bars, company] = await Promise.all([
        fetchOptionChain(ticker),
        cachedDailyBars(ticker, 250).catch(() => []),
        fetchCompany(ticker).catch(() => null),
      ]);
      const rows = contracts.map(toRow);
      const closes = bars.map((b) => b.close);
      const spot = company?.price || underlyingPrice || (closes.length ? closes[closes.length - 1] : 0);
      if (!spot || spot <= 0 || rows.length === 0) return null;

      const gex = gexAnalysis({ rows, closes, spot, now });
      if (gex.direction !== "up" && gex.direction !== "down") return null;
      const type = gex.direction === "up" ? "call" : "put";
      const contract = pickContract(rows, spot, type, now);
      if (!contract) return null;

      const sig: IntradaySignal = {
        ticker,
        spot: gex.spot,
        direction: gex.direction,
        kingStrike: gex.kingStrike,
        confidence: gex.confidence,
        strike: contract.strike,
        expiration: contract.expiration,
      };
      return intradayCandidate(sig);
    } catch {
      return null;
    }
  });
  const candidates = results.filter((c): c is Candidate => c != null);
  return { candidates, considered: INTRADAY_UNIVERSE.length };
}

function candidateToTrade(c: Candidate, now: Date): PaperTrade {
  const iso = now.toISOString();
  return {
    id: randomUUID(),
    createdAt: iso,
    source: "auto",
    ticker: c.ticker,
    optionType: c.optionType,
    strike: c.strike,
    expiration: c.expiration,
    direction: c.direction,
    trigger: c.trigger,
    target: c.target,
    stop: c.stop,
    trailing: true,
    probability: c.probability,
    note: c.note,
    contracts: DEFAULT_CONTRACTS,
    status: "pendiente",
    entryPrice: null,
    entryAt: null,
    exitPrice: null,
    exitAt: null,
    peakPrice: null,
    currentUnderlying: c.refPrice,
    currentPrice: null,
    updatedAt: iso,
    closeReason: null,
    verdict: null,
  };
}

export async function POST() {
  const now = new Date();
  const existing = await loadPaperTrades();
  const blockedTickers = new Set(existing.filter(isOpen).map((t) => t.ticker));

  const warnings: string[] = [];

  // (b) SWING — necesita cookie de MarketSnack; si falta, se corre solo el intradía.
  let swing: { candidates: Candidate[]; considered: number } = { candidates: [], considered: 0 };
  if (await marketsnackConfigured()) {
    swing = await scanSwing(now).catch((e) => {
      warnings.push(`Swing: ${e instanceof Error ? e.message : "fallo al escanear el flujo"}`);
      return { candidates: [], considered: 0 };
    });
  } else {
    warnings.push("Sin cookie de MarketSnack → no se escaneó el flujo swing (pégala en ⚙️ Ajustes).");
  }

  // (a) INTRADÍA — usa Massive (siempre disponible con la API key).
  const intraday = await scanIntraday(now).catch((e) => {
    warnings.push(`Intradía: ${e instanceof Error ? e.message : "fallo al escanear el GEX"}`);
    return { candidates: [], considered: 0 };
  });

  const all = [...intraday.candidates, ...swing.candidates];
  const selected = selectCandidates(all, { blockedTickers }).slice(0, MAX_OPEN_PER_SCAN);

  const opened: PaperTrade[] = selected.map((c) => candidateToTrade(c, now));
  if (opened.length > 0) {
    await savePaperTrades([...opened, ...existing]);
  }

  return Response.json({
    ok: true,
    opened,
    counts: {
      intradayConsidered: intraday.considered,
      swingConsidered: swing.considered,
      candidates: all.length,
      selected: selected.length,
      blocked: blockedTickers.size,
    },
    warnings: warnings.length ? warnings : undefined,
  });
}
