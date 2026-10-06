// Motor GEX para "Grandes Empresas 2.0" (Prueba de Fuego) — pedido explícito
// (2026-08-31): "recreame el botón de grandes empresas pero con el
// motor de 0DTE... yo sé que las empresas no tienen 0DTE ciertos días, porque
// los contratos vencen 3 veces a la semana". A diferencia de "Grandes
// empresas" (original, INTACTO — usa lib/contratosVecinos3.ts + el GEX
// pre-calculado de MarketSnack), acá el imán/señal salen del MISMO motor que
// la pestaña "0DTE" (lib/odteStandalone/zerodte.ts: griegos REALES de
// Schwab, zeroDteGex, evaluateEntry, GEX Ticket) — generalizado al
// VENCIMIENTO MÁS PRÓXIMO disponible de cada empresa en vez de exigir hoy
// mismo (0DTE real). `zeroDteGex` ya no depende de Black-Scholes (usa la
// gamma real por contrato que entrega Schwab), así que funciona igual de
// bien esté el vencimiento hoy o dentro de unos días — lo único que cambia
// es CUÁNTAS horas quedan hasta el cierre de ESE vencimiento (no el de hoy),
// de ahí `hoursToExpirationClose` en vez de `hoursToClose`.
//
// PURA-ish (una sola función async de orquestación, sin fs) — no se toca
// nada de lib/odteStandalone/ ni de lib/grandesEmpresas.ts.

import { toRow } from "./odteStandalone/compute";
import { fetchTastytradeChain, TastytradeError, type TtContract } from "@/lib/tastytrade";
import { ttToRaw } from "./odteStandalone/tastySource";
import { zeroDteGex, buildChainTable, buildTicket, atmIV, type ZeroDteGex, type ChainLine } from "./odteStandalone/zerodte";
import { chainIV } from "./odteStandalone/gex";
import { expectedMove } from "./odteStandalone/expectedMove";
import { dynamicParams, evaluateEntry, riskReward, noSetupReason, type EntryDecision } from "./odteStandalone/zerodteStrategy";
import { buildStrategySuggestions, type StrategySuggestions } from "./odteStandalone/strategySuggestions";
import type { Ticket } from "./odteStandalone/zerodteTicket";
import { marketDateStr } from "./odteStandalone/occ";
import { hoursToExpirationClose } from "./occ";

export { TastytradeError };

export interface CompanyGexResult {
  ticker: string;
  /** Vencimiento REAL usado (puede no ser hoy — ver cabecera del archivo). */
  expiration: string;
  /** true solo si ese vencimiento cae hoy mismo (0DTE real, poco común en equities). */
  isToday: boolean;
  spot: number | null;
  delayed: boolean;
  contractCount: number;
  lines: ChainLine[];
  gex: ZeroDteGex;
  entry: EntryDecision | null;
  entryRR: number | null;
  ticket: Ticket | null;
  noSetup: string | null;
  suggestions: StrategySuggestions | null;
  asOf: string;
}

/**
 * GEX real (Tastytrade) del vencimiento MÁS PRÓXIMO de `ticker` — hoy si lo hay
 * (raro en equities), si no el siguiente disponible (mañana, o en unos días,
 * según cuándo vencen sus opciones esa semana).
 */
export async function fetchCompanyGex(
  ticker: string,
  now: Date = new Date(),
  /** Cadena ya bajada (p. ej. por fetchCompanyBase) para no pedirla dos veces. */
  pre?: { tt: TtContract[]; spot: number | null },
): Promise<CompanyGexResult> {
  const clean = ticker.trim().toUpperCase();
  const today = marketDateStr(now);

  // Cadena de Tastytrade (oct 2026, antes Schwab): solo los próximos 10 días,
  // basta para encontrar el PRÓXIMO vencimiento.
  const chainResult: { tt: TtContract[]; spot: number | null } = pre ??
    (await fetchTastytradeChain(clean, { dteMin: 0, dteMax: 10 }).then((r) => ({ tt: r.contracts, spot: r.spot })));
  const allRows = ttToRaw(chainResult.tt, clean, chainResult.spot).map(toRow);

  const expirations = [...new Set(allRows.map((r) => r.expiration))]
    .filter((e) => e >= today)
    .sort();
  const nearestExp = expirations[0];
  if (!nearestExp) {
    throw new Error(`Sin vencimientos disponibles de ${clean} en los próximos 10 días.`);
  }
  const rows = allRows.filter((r) => r.expiration === nearestExp);
  const spot = chainResult.spot;
  const isToday = nearestExp === today;

  const lines = buildChainTable(rows);
  const gex = zeroDteGex(rows, spot ?? 0);
  const iv = spot != null ? atmIV(rows, spot) ?? chainIV(rows, spot) : null;
  const hoursLeft = hoursToExpirationClose(nearestExp, now);
  const sigma = spot != null && iv != null && iv > 0 ? expectedMove(spot, iv, hoursLeft / 24).sigma : null;
  const entryParams = dynamicParams(spot ?? 0, sigma, clean);
  const entry = spot != null
    ? evaluateEntry(spot, gex.regime, gex.kingStrike, gex.flipStrike, entryParams, 0, "es")
    : null;
  const ticket = buildTicket(lines, entry, spot);
  const noSetup = !entry && spot != null
    ? noSetupReason(spot, gex.regime, gex.kingStrike, entryParams, "es")
    : null;
  const suggestions = spot != null ? buildStrategySuggestions(rows, spot, gex, entry, "es") : null;

  return {
    ticker: clean,
    expiration: nearestExp,
    isToday,
    spot,
    delayed: false, // Tastytrade es tiempo real
    contractCount: rows.length,
    lines,
    gex,
    entry,
    entryRR: entry ? riskReward(entry) : null,
    ticket,
    noSetup,
    suggestions,
    asOf: now.toISOString(),
  };
}
