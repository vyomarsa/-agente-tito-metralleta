// GET /api/0dte/sim?ticker=SPX&spot=&regime=&magnet=&flip= — simulador de PAPEL
// (estrategia pin-al-imán en γ+). NO ejecuta operaciones reales. Ver Proceso 0DTE.

import { fetchIntradayBars } from "@/lib/pdf/odteStandalone/schwab";
import { marketDateStr } from "@/lib/pdf/odteStandalone/occ";
import { toSchwabSymbol } from "@/lib/pdf/odteStandalone/zerodte";
import {
  DEFAULT_PARAMS, emptyJournal, evaluateEntry, loadSimJournal, openTodayTrade,
  saveSimJournal, scoreTrade, summarize, type SimBar,
} from "@/lib/pdf/odteStandalone/zerodteSim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function etMinutes(now: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24;
  const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
/** ¿Es día hábil (lun-vie) en hora de Nueva York? (No cubre feriados.) */
function isWeekdayET(now: Date): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" })
    .format(now);
  return !["Sat", "Sun"].includes(wd);
}
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "SPX").trim().toUpperCase();
  const spot = Number(searchParams.get("spot"));
  const regime = searchParams.get("regime") === "negative" ? "negative" : "positive";
  const magnet = searchParams.get("magnet") ? Number(searchParams.get("magnet")) : null;
  const flip = searchParams.get("flip") ? Number(searchParams.get("flip")) : null;

  const now = new Date();
  const today = marketDateStr(now);
  const min = etMinutes(now);
  const marketOpen = isWeekdayET(now) && min >= OPEN_MIN && min < CLOSE_MIN;

  let journal = (await loadSimJournal(ticker)) ?? emptyJournal(ticker);

  try {
    // 1) Puntuar la operación pendiente si su día ya cerró (y sus barras siguen
    //    disponibles). Solo se puede recuperar la sesión más reciente.
    const pending = journal.trades.find((t) => !t.matured);
    if (pending) {
      const dayClosed = pending.date !== today || (!marketOpen && min >= CLOSE_MIN);
      if (dayClosed) {
        const tf = await fetchIntradayBars(toSchwabSymbol(ticker));
        const bars: SimBar[] = tf.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
        const barsDay = bars.length ? marketDateStr(new Date(bars[bars.length - 1].time * 1000)) : "";
        if (barsDay === pending.date) {
          const scored = scoreTrade(pending, bars);
          if (scored.matured) {
            journal = {
              ...journal,
              updatedAt: now.toISOString(),
              trades: journal.trades.map((t) => (t.date === pending.date ? scored : t)),
            };
            await saveSimJournal(journal);
          }
        }
      }
    }

    // 2) Abrir la operación de hoy si hay setup y el mercado está abierto.
    if (marketOpen && Number.isFinite(spot) && !journal.trades.some((t) => t.date === today)) {
      const decision = evaluateEntry(spot, regime, magnet, flip, DEFAULT_PARAMS);
      if (decision) {
        journal = openTodayTrade(journal, decision, now);
        await saveSimJournal(journal);
      }
    }
  } catch {
    // El simulador es secundario: si falla el disco o las barras, no rompe la página.
  }

  const todayTrade = journal.trades.find((t) => t.date === today) ?? null;
  return Response.json({
    ticker,
    marketOpen,
    today: todayTrade,
    summary: summarize(journal.trades),
    params: DEFAULT_PARAMS,
  });
}
