"use client";

// "Grandes empresas 2.0" (Prueba de Fuego, ago 2026, pedido explícito de
// el usuario: "recreame el botón de grandes empresas pero con el motor de
// 0DTE"). Copia deliberada de GrandesEmpresasTab.tsx (ESE archivo NO se
// toca) — mismo buscador S&P 500, mismo gráfico de velas con selector de
// temporalidad, mismo banner de order book. Lo único que cambia es de dónde
// sale el imán/la señal: acá viene del GEX REAL de Schwab (mismo motor que
// la pestaña "0DTE", ver lib/grandesEmpresas2Gex.ts) sobre el vencimiento
// más próximo de la empresa — no siempre hoy, las equities no vencen a
// diario como SPX/SPY/QQQ.

import { useCallback, useEffect, useRef, useState } from "react";
import GrandesEmpresasChart, { type ChartLevelLine, type ChartPremarketWindow } from "./GrandesEmpresasChart";
import type { TfBar } from "@/lib/pdf/types";
import { GRANDES_EMPRESAS, DEFAULT_GRANDES_EMPRESA } from "@/lib/pdf/grandesEmpresas";
import { searchSp500, SP500_TICKERS, type Sp500Company } from "@/lib/pdf/sp500";
import { CHART_TIMEFRAMES, DEFAULT_CHART_TIMEFRAME, type ChartTimeframeId } from "@/lib/pdf/timeframeBars";
import type { ChainLine } from "@/lib/pdf/odteStandalone/zerodte";
import type { EntryDecision } from "@/lib/pdf/odteStandalone/zerodteStrategy";
import type { Ticket } from "@/lib/pdf/odteStandalone/zerodteTicket";
import type { StrategySuggestions } from "@/lib/pdf/odteStandalone/strategySuggestions";

const KEY_TICKER = "visionary.grandesEmpresas2.ticker";
const REFRESH_MS = 60 * 1000;
const TICKER_IDS = new Set(GRANDES_EMPRESAS.map((t) => t.id));

type Trend = "subiendo" | "bajando" | "estable";
interface Activity { totalPremium: number; netPremium: number; trend: Trend }
interface ActivityLevel { strike: number; type: "call" | "put"; activity: Activity; otherActivity?: Activity | null }

interface RejectionPoint {
  price: number;
  touches: number;
  kind: "techo" | "piso";
}

interface OrderBookSentiment {
  askPct: number;
  bidPct: number;
  midPct: number;
  balanced: boolean;
  dominantSide: "call" | "put" | null;
  dominantNetPremium: number;
  message: string;
}

interface ZeroDteGexNode { strike: number; netGex: number; callGex: number; putGex: number; side: "call" | "put"; concentration: number }
interface ZeroDteGex {
  nodes: ZeroDteGexNode[];
  kingStrike: number | null;
  flipStrike: number | null;
  regime: "positive" | "negative";
  totalNetGex: number;
  realGammaShare: number;
  n: number;
}

interface CompanyGex {
  ticker: string;
  expiration: string;
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

interface Result {
  ticker: string;
  asOf: string;
  spot: number;
  prevClose: number | null;
  premarketChangePct: number | null;
  isPreMarket: boolean;
  marketOpen: boolean;
  orderBookExpirations: string[];
  bars: TfBar[];
  premarketWindows: ChartPremarketWindow[];
  premarketRejections: RejectionPoint[];
  above: ActivityLevel[];
  below: ActivityLevel[];
  orderBook: OrderBookSentiment;
  gex: CompanyGex | null;
  gexError: string | null;
}

const dec = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const optUsd = (pts: number) => `$${Math.round(pts * 100).toLocaleString("en-US")}`;
const etTime = () => new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
const fmtExpiration = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" });

export default function GrandesEmpresas2Tab() {
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selTicker, setSelTicker] = useState<string>(DEFAULT_GRANDES_EMPRESA);
  const [tickerReady, setTickerReady] = useState(false);
  const requestedTickerRef = useRef<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Sp500Company[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [chartTf, setChartTf] = useState<ChartTimeframeId>(DEFAULT_CHART_TIMEFRAME);
  const [altBars, setAltBars] = useState<TfBar[] | null>(null);
  const [altLoading, setAltLoading] = useState(false);
  const [altError, setAltError] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY_TICKER);
    if (saved && (TICKER_IDS.has(saved) || SP500_TICKERS.has(saved))) setSelTicker(saved);
    setTickerReady(true);
  }, []);

  const pickTicker = useCallback((id: string) => {
    setSelTicker(id);
    window.localStorage.setItem(KEY_TICKER, id);
  }, []);

  const onSearchChange = useCallback((q: string) => {
    setSearchQuery(q);
    setSuggestions(searchSp500(q));
    setShowSuggestions(true);
  }, []);

  const selectSuggestion = useCallback(
    (c: Sp500Company) => {
      pickTicker(c.ticker);
      setSearchQuery("");
      setSuggestions([]);
      setShowSuggestions(false);
    },
    [pickTicker],
  );

  // Mismo endpoint LIVIANO de temporalidad que la v1 — no toca señal/GEX,
  // así que no hace falta un duplicado propio (ver app/api/grandes-empresas/chart).
  useEffect(() => {
    if (!tickerReady || chartTf === DEFAULT_CHART_TIMEFRAME) return;
    let cancelled = false;
    setAltLoading(true);
    setAltError(null);
    fetch(`/api/pdf/grandes-empresas/chart?ticker=${selTicker}&tf=${chartTf}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setAltBars(json.bars as TfBar[]);
      })
      .catch((e) => {
        if (cancelled) return;
        setAltError(e instanceof Error ? e.message : "Error desconocido");
        setAltBars(null);
      })
      .finally(() => {
        if (!cancelled) setAltLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tickerReady, selTicker, chartTf]);

  const load = useCallback(async (ticker: string) => {
    requestedTickerRef.current = ticker;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pdf/grandes-empresas-2?ticker=${ticker}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (requestedTickerRef.current !== ticker) return;
      setData(json as Result);
      setLastUpdated(new Date());
    } catch (e) {
      if (requestedTickerRef.current !== ticker) return;
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      if (requestedTickerRef.current === ticker) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!tickerReady) return;
    load(selTicker);
    const id = setInterval(() => load(selTicker), REFRESH_MS);
    return () => clearInterval(id);
  }, [tickerReady, selTicker, load]);

  const chartLevels: ChartLevelLine[] =
    data?.premarketRejections.map((r) => ({ price: r.price, kind: r.kind, touches: r.touches })) ?? [];

  return (
    <div className="ge-wrap">
      <style>{CSS}</style>

      <header className="ge-head">
        <div>
          <h1>Grandes empresas 2.0</h1>
          <p>Igual que "Grandes empresas", pero el imán y la señal salen del GEX real de Tastytrade — el mismo motor de la pestaña "0DTE".</p>
        </div>
        <div className="ge-controls">
          {lastUpdated && <span className="ge-updated">actualizado {etTime()} ET</span>}
          <button onClick={() => load(selTicker)} disabled={loading}>
            {loading ? "Cargando…" : "🔄 Actualizar"}
          </button>
        </div>
      </header>

      <div className="ge-tickers">
        {GRANDES_EMPRESAS.map((t) => (
          <button key={t.id} className={selTicker === t.id ? "active" : ""} onClick={() => pickTicker(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="ge-search">
        <input
          type="text"
          value={searchQuery}
          placeholder="Buscar en el S&P 500 por ticker o nombre (ej. Apple, MSFT)…"
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={() => searchQuery && setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && suggestions[0]) selectSuggestion(suggestions[0]);
            if (e.key === "Escape") setShowSuggestions(false);
          }}
        />
        {showSuggestions && suggestions.length > 0 && (
          <ul className="ge-search-list">
            {suggestions.map((c) => (
              <li key={c.ticker} onMouseDown={() => selectSuggestion(c)}>
                <span className="ge-search-ticker">{c.ticker}</span>
                <span className="ge-search-name">{c.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <div className="ge-error">⚠ {error}</div>}

      {data && (
        <div className="ge-top">
          <div className="ge-price-box">
            <span className="ge-price-label">{data.ticker}</span>
            <span className="ge-price-value">${data.spot.toFixed(2)}</span>
            <span className={`ge-mkt ${data.marketOpen ? "ge-mkt-on" : "ge-mkt-off"}`}>
              {data.marketOpen ? "🟢 mercado abierto" : data.isPreMarket ? "🟡 pre-market" : "🔴 mercado cerrado"}
            </span>
          </div>
          {data.gex && (
            <div className="ge-magnet-box">
              <span className="ge-magnet-label">🧲 Imán (GEX real de Tastytrade)</span>
              <span className="ge-magnet-value">{data.gex.gex.kingStrike != null ? `$${dec(data.gex.gex.kingStrike)}` : "—"}</span>
              <span className="ge-magnet-sub">
                vencimiento {fmtExpiration(data.gex.expiration)}{data.gex.isToday ? " (0DTE)" : ""} · flip {data.gex.gex.flipStrike != null ? `$${dec(data.gex.gex.flipStrike)}` : "—"} · régimen {data.gex.gex.regime === "positive" ? "γ+ (revierte)" : "γ− (amplifica)"}
              </span>
            </div>
          )}
        </div>
      )}

      {data && data.premarketChangePct != null && (
        <div className={`ge-premarket-banner ${data.premarketChangePct >= 0 ? "ge-pm-up" : "ge-pm-down"}`}>
          La empresa <b>{data.ticker}</b> se ha movido{" "}
          <b>{data.premarketChangePct >= 0 ? "+" : ""}{data.premarketChangePct.toFixed(2)}%</b> durante el pre-market
          {!data.isPreMarket && " (último dato antes de la apertura)"}.
        </div>
      )}

      {data && data.bars.length > 0 && (() => {
        const isDefaultTf = chartTf === DEFAULT_CHART_TIMEFRAME;
        const shownBars = isDefaultTf ? data.bars : altBars;
        const shownLevels = isDefaultTf ? chartLevels : [];
        const shownWindows = isDefaultTf ? data.premarketWindows : [];
        return (
          <section className="ge-chart-box">
            <header>
              <div className="ge-chart-head-row">
                <div>
                  <h2>{isDefaultTf ? "15 min · últimos 20 días" : CHART_TIMEFRAMES.find((t) => t.id === chartTf)?.label}</h2>
                  <p>
                    {isDefaultTf
                      ? "Franja gris = pre-market (4:00–9:30 ET) · líneas punteadas = puntos de rechazo del pre-market de hoy (se quedan visibles toda la sesión)."
                      : "Velas de Tastytrade (1h y 4h: historial desde ~9 meses atrás)."}
                  </p>
                </div>
                <div className="ge-tf-picker">
                  {CHART_TIMEFRAMES.map((tf) => (
                    <button key={tf.id} className={chartTf === tf.id ? "active" : ""} onClick={() => setChartTf(tf.id)}>
                      {tf.label}
                    </button>
                  ))}
                </div>
              </div>
            </header>
            <div className="ge-chart">
              {!isDefaultTf && altLoading && <div className="ge-chart-status">Cargando…</div>}
              {!isDefaultTf && altError && <div className="ge-chart-status ge-chart-status-error">⚠ {altError}</div>}
              {shownBars && shownBars.length > 0 && (
                <GrandesEmpresasChart bars={shownBars} levels={shownLevels} premarketWindows={shownWindows} />
              )}
            </div>
          </section>
        );
      })()}

      {data && <OrderBookBanner ob={data.orderBook} />}

      {data?.gex && <GexSignalBox g={data.gex} />}
      {!data?.gex && data?.gexError && (
        <section className="ge2-nogex">⚠ GEX real no disponible ahora mismo: {data.gexError}</section>
      )}

      {data?.gex?.suggestions && <SpreadSuggestions s={data.gex.suggestions} />}

      <p className="ge-foot">
        Se actualiza sola cada 60s. El imán/la señal salen del GEX real de Tastytrade (griegos reales, en
        tiempo real) sobre el vencimiento MÁS PRÓXIMO de la empresa — casi nunca es hoy mismo (las equities no vencen
        a diario como SPX/SPY/QQQ, según el ticker vencen 2-3 veces por semana). El order book y los puntos de
        rechazo del pre-market siguen siendo el mismo motor de "Contratos vecinos 3.0"/net premium real (Time & Sales
        de Tastytrade) que ya usa "Grandes empresas". Dinero simulado, no es consejo financiero.
      </p>
    </div>
  );
}

function OrderBookBanner({ ob }: { ob: OrderBookSentiment }) {
  const bleeding = !ob.balanced && ob.dominantSide != null && ob.dominantNetPremium > 0;
  const tone = ob.balanced ? "ob-neutral" : bleeding ? (ob.dominantSide === "call" ? "ob-bull" : "ob-bear") : "ob-flat";
  return (
    <section className={`ob-banner ${tone}`}>
      <span className="ob-banner-msg">{ob.message}</span>
      <span className="ob-banner-split">
        bid <b>{ob.bidPct.toFixed(0)}%</b> · mid <b>{ob.midPct.toFixed(0)}%</b> · ask <b>{ob.askPct.toFixed(0)}%</b>
      </span>
    </section>
  );
}

/** Señal GEX real: GEX Trade (vuelta al imán) + GEX Ticket, mismo motor que
 *  la pestaña "0DTE" — ver lib/grandesEmpresas2Gex.ts. */
function GexSignalBox({ g }: { g: CompanyGex }) {
  const entry = g.entry;
  const ticket = g.ticket;

  if (!entry) {
    return (
      <section className="ge-advice ge-advice-lateral">
        <span className="ge-advice-tag">🟡 SIN SETUP AHORA — NO OPERAR</span>
        <p>{g.noSetup ?? "El precio está pegado al imán o el régimen no favorece un pin claro."}</p>
      </section>
    );
  }

  const dirLabel = entry.direction === "long" ? "🟢 LONG — vuelta al imán" : "🔴 SHORT — vuelta al imán";
  return (
    <section className={`ge-advice ${entry.direction === "long" ? "ge-advice-call" : "ge-advice-put"}`}>
      <div className="ge-advice-top">
        <span className="ge-advice-dir">{dirLabel}</span>
        <span className="ge-advice-tag">R:B {g.entryRR?.toFixed(2) ?? "—"}x</span>
      </div>
      <div className="ge-targets-row">
        <div className="ge-chip">
          <div className="ge-chip-label">Entrada</div>
          <div className="ge-chip-value">${entry.entry.toFixed(2)}</div>
        </div>
        <div className="ge-chip">
          <div className="ge-chip-label">Target (imán)</div>
          <div className="ge-chip-value">${entry.target.toFixed(2)}</div>
        </div>
        <div className="ge-chip ge-chip-stop">
          <div className="ge-chip-label">Stop</div>
          <div className="ge-chip-value">${entry.stop.toFixed(2)}</div>
        </div>
      </div>
      <p>{entry.reason}</p>

      {ticket && (
        <div className="ge2-ticket">
          <div className="ge2-ticket-tag">🎫 GEX Ticket — {ticket.type === "call" ? "CALL" : "PUT"} {ticket.strike}</div>
          <div className="ge2-ticket-row">
            <span>Entrada (mid) ${ticket.mid.toFixed(2)}</span>
            <span>Target ${ticket.targetPx.toFixed(2)}</span>
            <span>Stop ${ticket.stopPx.toFixed(2)}</span>
            <span>R:B {ticket.rbOption.toFixed(2)}x</span>
          </div>
          <div className="ge2-ticket-row ge2-ticket-sub">
            <span>Costo ${Math.round(ticket.cost).toLocaleString("en-US")}/contrato</span>
            <span>Delta {ticket.delta.toFixed(2)}</span>
            <span>Volumen {ticket.volume.toLocaleString("en-US")}</span>
            <span>OI {ticket.oi.toLocaleString("en-US")}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/** Mismas 3 estrategias que el panel "Opciones de recomendación" de la
 *  pestaña 0DTE (lib/odteStandalone/strategySuggestions.ts) — versión
 *  en español, sin el toggle de idioma que sí tiene esa pestaña. */
function SpreadSuggestions({ s }: { s: StrategySuggestions }) {
  const any = s.vertical || s.creditCall || s.ironCondor;
  return (
    <section className="ge-spreads">
      <header>
        <h2>Opciones de recomendación</h2>
        <span className="ge-spreads-bias">riesgo definido, sobre el mismo GEX real</span>
      </header>

      {!any && <p className="ge-spread-empty">Sin setup de estrategia ahora mismo — sin entrada direccional y/o sin un muro limpio para vender.</p>}

      {any && (
        <div className="ge-spreads-grid">
          {s.vertical && (
            <div className="ge-spread-card">
              <span className="ge-sum-lbl">Vertical (débito)</span>
              <b>{s.vertical.kind === "bull_call" ? "Bull Call" : "Bear Put"}</b>
              <span className="ge-spread-legs">Compra {s.vertical.longStrike} · Vende {s.vertical.shortStrike}</span>
              <div className="ge-spread-nums">
                <div><span>Débito</span><b>{s.vertical.debit != null ? `${dec(s.vertical.debit)} (${optUsd(s.vertical.debit)})` : "sin quote real"}</b></div>
              </div>
              <p className="ge2-reason">{s.vertical.reason}</p>
            </div>
          )}
          {s.creditCall && (
            <div className="ge-spread-card">
              <span className="ge-sum-lbl">Credit Call</span>
              <b>Bear Call</b>
              <span className="ge-spread-legs">Vende {s.creditCall.shortStrike} · Compra {s.creditCall.longStrike}</span>
              <div className="ge-spread-nums">
                <div><span>Crédito</span><b className="ge-spread-good">{s.creditCall.credit != null ? `${dec(s.creditCall.credit)} (${optUsd(s.creditCall.credit)})` : "sin quote real"}</b></div>
              </div>
              <p className="ge2-reason">{s.creditCall.reason}</p>
            </div>
          )}
          {s.ironCondor && (
            <div className="ge-spread-card">
              <span className="ge-sum-lbl">Iron Condor</span>
              <b>{s.ironCondor.shortPut}P / {s.ironCondor.shortCall}C</b>
              <span className="ge-spread-legs">Alas: {s.ironCondor.longPut}P · {s.ironCondor.longCall}C</span>
              <div className="ge-spread-nums">
                <div><span>Crédito</span><b className="ge-spread-good">{s.ironCondor.credit != null ? `${dec(s.ironCondor.credit)} (${optUsd(s.ironCondor.credit)})` : "sin quote real"}</b></div>
                {s.ironCondor.beLow != null && s.ironCondor.beHigh != null && (
                  <div><span>Rango seguro</span><b>{dec(s.ironCondor.beLow)} – {dec(s.ironCondor.beHigh)}</b></div>
                )}
              </div>
              <p className="ge2-reason">{s.ironCondor.reason}</p>
            </div>
          )}
        </div>
      )}

      <p className="ge-spreads-note">
        El agente calcula y muestra; vos decidís y ejecutás. No es una orden ni un consejo. Precio conservador
        (comprar al ask, vender al bid) — sin quote real de alguna pata, no se inventa un número.
      </p>
    </section>
  );
}

const CSS = `
.ge-wrap { max-width: 1200px; margin: 0 auto; padding: 0 0 40px; font-size: 15px; }
.ge-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.ge-head h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.2px; }
.ge-head p { margin: 0; color: var(--muted); font-size: 13.5px; }
.ge-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ge-controls button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  background: var(--accent); border: 1px solid var(--accent); color: #fff; font-weight: 600; }
.ge-controls button:disabled { opacity: .6; cursor: default; }
.ge-updated { font-size: 12.5px; color: var(--faint); font-variant-numeric: tabular-nums; }

.ge-tickers { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.ge-tickers button { font: inherit; padding: 7px 14px; border-radius: 999px; cursor: pointer; font-weight: 600;
  font-size: 13px; border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.ge-tickers button.active { background: var(--accent); border-color: var(--accent); color: #fff; }

.ge-search { position: relative; max-width: 420px; margin: 0 0 16px; }
.ge-search input { font: inherit; width: 100%; box-sizing: border-box; padding: 9px 14px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.ge-search input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.ge-search-list { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; right: 0; margin: 0; padding: 4px;
  list-style: none; border: 1px solid var(--border); background: var(--panel); border-radius: 8px;
  max-height: 280px; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.ge-search-list li { display: flex; align-items: baseline; gap: 8px; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
.ge-search-list li:hover { background: var(--panel-2); }
.ge-search-ticker { font-weight: 700; font-size: 13px; }
.ge-search-name { font-size: 12.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ge-error { background: var(--red-bg); border: 1px solid var(--red-soft); color: #7a271a;
  padding: 12px 14px; border-radius: 8px; margin: 16px 0; }

.ge-top { display: flex; gap: 16px; flex-wrap: wrap; margin: 4px 0 14px; }
.ge-price-box, .ge-magnet-box { border: 1px solid var(--border); background: var(--panel); border-radius: 12px;
  padding: 12px 18px; display: flex; flex-direction: column; gap: 3px; min-width: 200px; }
.ge-price-label, .ge-magnet-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; }
.ge-price-value, .ge-magnet-value { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; }
.ge-magnet-sub { font-size: 11.5px; color: var(--faint); }
.ge-mkt { align-self: flex-start; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; font-weight: 600; margin-top: 2px; }
.ge-mkt-on { background: var(--green-bg); color: var(--green-dark); border: 1px solid var(--green); }
.ge-mkt-off { background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }

.ge-premarket-banner { border-radius: 10px; padding: 12px 16px; margin: 0 0 16px; font-size: 14px; border: 1px solid var(--border); }
.ge-pm-up { background: var(--green-bg); color: var(--green-dark); border-color: var(--green); }
.ge-pm-down { background: var(--red-bg); color: #7a271a; border-color: var(--red-soft); }

.ge-chart-box { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.ge-chart-box header { margin-bottom: 8px; }
.ge-chart-head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.ge-chart-box h2 { margin: 0; font-size: 15px; }
.ge-chart-box p { margin: 2px 0 0; font-size: 12px; color: var(--faint); }
.ge-tf-picker { display: flex; gap: 4px; flex-wrap: wrap; }
.ge-tf-picker button { font: inherit; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 6px;
  cursor: pointer; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); }
.ge-tf-picker button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.ge-chart { height: clamp(280px, 40vw, 420px); position: relative; }
.ge-chart-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--faint); z-index: 2; }
.ge-chart-status-error { color: #b42318; }

.ob-banner { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  border: 2px solid var(--border); border-radius: 12px; padding: 16px 20px; margin: 0 0 16px; }
.ob-banner-msg { font-size: 18px; font-weight: 800; letter-spacing: -0.1px; }
.ob-banner-split { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ob-banner-split b { color: var(--text); }
.ob-neutral { border-color: var(--amber-border); background: var(--amber-bg); }
.ob-neutral .ob-banner-msg { color: var(--amber-text); }
.ob-bull { border-color: var(--green); background: var(--green-bg); }
.ob-bull .ob-banner-msg { color: var(--green-dark); }
.ob-bear { border-color: var(--red-soft); background: var(--red-bg); }
.ob-bear .ob-banner-msg { color: #b42318; }
.ob-flat { border-color: var(--border); background: var(--panel); }
.ob-flat .ob-banner-msg { color: var(--muted); }

.ge-advice { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; background: var(--panel); }
.ge-advice-call { border-color: var(--green); background: var(--green-bg); }
.ge-advice-put { border-color: var(--red-soft); background: var(--red-bg); }
.ge-advice-lateral { border-color: var(--amber-border); background: var(--amber-bg); text-align: center; }
.ge-advice-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
.ge-advice-dir { font-size: 20px; font-weight: 800; }
.ge-advice-tag { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--border); }
.ge-advice p { margin: 8px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--text); }

.ge-targets-row { display: flex; gap: 12px; flex-wrap: wrap; }
.ge-chip { background: var(--panel-2); border: 1px solid var(--border-soft); border-radius: 8px;
  padding: 10px 14px; min-width: 130px; }
.ge-chip-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
.ge-chip-value { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ge-chip-stop { border-color: var(--amber-border); }

.ge2-nogex { border: 1px solid var(--amber-border); background: var(--amber-bg); color: var(--amber-text);
  border-radius: 10px; padding: 12px 16px; margin: 0 0 16px; font-size: 13.5px; }
.ge2-ticket { margin-top: 12px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel-2); }
.ge2-ticket-tag { font-size: 12.5px; font-weight: 700; color: var(--accent); margin-bottom: 6px; }
.ge2-ticket-row { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ge2-ticket-sub { margin-top: 4px; color: var(--muted); font-size: 11.5px; }
.ge2-reason { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--faint); }

.ge-spreads { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.ge-spreads header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.ge-spreads h2 { margin: 0; font-size: 15px; }
.ge-spreads-bias { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel-2); border: 1px solid var(--border); color: var(--muted); }
.ge-spreads-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.ge-spread-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; background: var(--panel-2); }
.ge-spread-card b { font-size: 17px; letter-spacing: -0.2px; }
.ge-spread-legs { font-size: 12px; color: var(--muted); }
.ge-spread-empty { margin: 4px 0 0; font-size: 12px; color: var(--faint); line-height: 1.5; }
.ge-spread-nums { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-soft); }
.ge-spread-nums > div { display: flex; justify-content: space-between; font-size: 12.5px; }
.ge-spread-nums span { color: var(--muted); }
.ge-spread-nums b { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ge-spread-good { color: var(--green-dark); }
.ge-spreads-note { margin: 14px 0 0; font-size: 11.5px; color: var(--faint); line-height: 1.5; }

.ge-foot { color: var(--faint); font-size: 12px; margin-top: 8px; line-height: 1.5; }
`;
