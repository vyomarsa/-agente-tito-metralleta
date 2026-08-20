// Lectura del libro de operaciones cerradas del bot **Venta Prima**, que vive en un
// proyecto APARTE (`Desktop/Venta Prima`) y escribe `state/closed-trades.jsonl`.
//
// Tito no ejecuta esa estrategia: solo la MUESTRA. El bot Python es el dueño de los
// datos; aquí se leen en modo solo-lectura para tener el simulador de venta de prima
// junto al resto en "Mis Trades".
//
// La cuenta parte de una cantidad hipotética y **NO se resetea**: el equity se DERIVA
// del libro (append-only), igual que en el bot, así que ambos lados enseñan el mismo
// número sin sincronizar nada.
//
// Todo aquí es PURO. Tests en `ventaPrimaLedger.test.ts`.

/** Cantidad hipotética de partida de la simulación. */
export const START_EQUITY = 10_000;

export interface VpTrade {
  id: string;
  underlying: string;
  spreadType: string;
  shortStrike: number | null;
  longStrike: number | null;
  contracts: number;
  entryCredit: number;
  exitValue: number;
  pnl: number;
  profitPctOfMax: number;
  peakProfitPct: number;
  outcome: "ganada" | "perdida" | "neutra" | "";
  closeReason: string;
  exitTime: string | null;
  /** Fecha del cierre (YYYY-MM-DD), "" si no se pudo leer. */
  exitDate: string;
}

export interface VpSymbolStat {
  symbol: string;
  trades: number;
  wins: number;
  pnl: number;
}

export interface VpSummary {
  startEquity: number;
  realizedPnl: number;
  equity: number;
  returnPct: number;
  trades: number;
  wins: number;
  losses: number;
  neutral: number;
  /** null (no 0) cuando aún no hay operaciones decididas. */
  winRate: number | null;
  best: VpTrade | null;
  worst: VpTrade | null;
  bySymbol: VpSymbolStat[];
  /** Un punto por operación, más el capital de partida al inicio. */
  equityCurve: number[];
}

function num(v: unknown, d = 0): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : d;
}

/** Convierte una línea del libro. Los campos nuevos tienen default: las filas
 *  viejas no traen `close_reason` ni `peak_profit_pct` y no deben romper nada. */
export function parseVpTrade(rec: Record<string, unknown>): VpTrade {
  const exitTime = typeof rec.exit_time === "string" ? rec.exit_time : null;
  const outcome = String(rec.outcome ?? "") as VpTrade["outcome"];
  return {
    id: String(rec.id ?? ""),
    underlying: String(rec.underlying ?? "?"),
    spreadType: String(rec.spread_type ?? ""),
    shortStrike: rec.short_strike == null ? null : num(rec.short_strike),
    longStrike: rec.long_strike == null ? null : num(rec.long_strike),
    contracts: Math.round(num(rec.contracts)),
    entryCredit: num(rec.entry_credit),
    exitValue: num(rec.exit_value),
    pnl: num(rec.pnl),
    profitPctOfMax: num(rec.profit_pct_of_max),
    peakProfitPct: num(rec.peak_profit_pct),
    outcome,
    closeReason: String(rec.close_reason ?? ""),
    exitTime,
    exitDate: exitTime ? exitTime.slice(0, 10) : "",
  };
}

/** Parsea el JSONL entero, saltando líneas corruptas (una mala no invalida el resto). */
export function parseVpLedger(text: string): VpTrade[] {
  const out: VpTrade[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(parseVpTrade(JSON.parse(s) as Record<string, unknown>));
    } catch {
      // línea rota: se ignora
    }
  }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Resume la cuenta simulada. PURA — mismo criterio que `simulator.py` del bot. */
export function summarizeVp(trades: VpTrade[], startEquity = START_EQUITY): VpSummary {
  const realizedPnl = r2(trades.reduce((s, t) => s + t.pnl, 0));

  const equityCurve: number[] = [r2(startEquity)];
  let acc = startEquity;
  for (const t of trades) {
    acc += t.pnl;
    equityCurve.push(r2(acc));
  }

  const wins = trades.filter((t) => t.outcome === "ganada").length;
  const losses = trades.filter((t) => t.outcome === "perdida").length;
  const neutral = trades.filter((t) => t.outcome === "neutra").length;

  // El win rate va sobre las DECIDIDAS: un cierre a cero no es acierto ni fallo, y
  // contarlo diluiría el número. Sin decididas es null, NO 0% (que leería como
  // "falla siempre" cuando lo que pasa es que aún no ha operado).
  const decided = wins + losses;
  const winRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null;

  const bySymbolMap = new Map<string, VpSymbolStat>();
  for (const t of trades) {
    const e = bySymbolMap.get(t.underlying) ?? { symbol: t.underlying, trades: 0, wins: 0, pnl: 0 };
    e.trades += 1;
    e.pnl = r2(e.pnl + t.pnl);
    if (t.outcome === "ganada") e.wins += 1;
    bySymbolMap.set(t.underlying, e);
  }

  const sorted = [...trades].sort((a, b) => a.pnl - b.pnl);
  return {
    startEquity: r2(startEquity),
    realizedPnl,
    equity: r2(startEquity + realizedPnl),
    returnPct: startEquity ? Math.round((realizedPnl / startEquity) * 10000) / 100 : 0,
    trades: trades.length,
    wins, losses, neutral, winRate,
    best: sorted.length ? sorted[sorted.length - 1] : null,
    worst: sorted.length ? sorted[0] : null,
    bySymbol: [...bySymbolMap.values()].sort((a, b) => b.pnl - a.pnl),
    equityCurve,
  };
}
