"use client";

// "Grandes empresas" (Prueba de Fuego, ago 2026, pedido explícito):
// Magnificent Seven + PLTR, IREN, NFLX, SPCX, INTC, ORCL, HOOD. Reusa el motor de
// "Contratos vecinos 3.0" (lib/contratosVecinos3.ts) para el call/put con dos
// targets — ver ContratosVecinos3Tab.tsx, mismo patrón de SignalBox/TargetChip.
// Suma: imán real de MarketSnack (GEX agregado, lib/spxLevels.ts), % movido en
// pre-market, y gráfica de velas de 15 min / 20 días (lightweight-charts, ver
// GrandesEmpresasChart.tsx) con los puntos de rechazo del pre-market de hoy.

import { useCallback, useEffect, useRef, useState } from "react";
import GrandesEmpresasChart, { type ChartLevelLine, type ChartPremarketWindow } from "./GrandesEmpresasChart";
import type { TfBar } from "@/lib/pdf/types";
import { applyPersistence, PERSISTENCE_REQUIRED, type ContratosVecinos3Signal, type PersistentSignal } from "@/lib/pdf/contratosVecinos3";
import { GRANDES_EMPRESAS, DEFAULT_GRANDES_EMPRESA } from "@/lib/pdf/grandesEmpresas";
import { searchSp500, SP500_TICKERS, type Sp500Company } from "@/lib/pdf/sp500";
import { CHART_TIMEFRAMES, DEFAULT_CHART_TIMEFRAME, type ChartTimeframeId } from "@/lib/pdf/timeframeBars";
import type { ZeroDteSuggestions } from "@/lib/pdf/zerodteSuggestions";

const KEY_TICKER = "visionary.grandesEmpresas.ticker";
const REFRESH_MS = 60 * 1000;
const TICKER_IDS = new Set(GRANDES_EMPRESAS.map((t) => t.id));

type Trend = "subiendo" | "bajando" | "estable";
interface Activity { totalPremium: number; netPremium: number; trend: Trend }
interface ActivityLevel { strike: number; type: "call" | "put"; activity: Activity; otherActivity?: Activity | null }
type Target = NonNullable<ContratosVecinos3Signal["target1"]>;

interface Magnet {
  strike: number;
  callWall: number;
  putWall: number;
  gammaFlip: number | null;
}

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

interface Result {
  ticker: string;
  asOf: string;
  spot: number;
  prevClose: number | null;
  premarketChangePct: number | null;
  isPreMarket: boolean;
  marketOpen: boolean;
  magnet: Magnet | null;
  expirations: string[];
  bars: TfBar[];
  premarketWindows: ChartPremarketWindow[];
  premarketRejections: RejectionPoint[];
  above: ActivityLevel[];
  below: ActivityLevel[];
  signal: ContratosVecinos3Signal;
  orderBook: OrderBookSentiment;
  suggestions: ZeroDteSuggestions | null;
}

const money0 = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const dec = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const etTime = () => new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
const fmtExpiration = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" });

export default function GrandesEmpresasTab() {
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selTicker, setSelTicker] = useState<string>(DEFAULT_GRANDES_EMPRESA);
  const [tickerReady, setTickerReady] = useState(false);
  const requestedTickerRef = useRef<string | null>(null);
  const historyRef = useRef<ContratosVecinos3Signal[]>([]);
  const [persistent, setPersistent] = useState<PersistentSignal | null>(null);

  // Buscador de tickers del S&P 500 (ago 2026, pedido explícito):
  // deja elegir CUALQUIERA de las 500 empresas, no solo las 14 "guardadas"
  // de arriba — sugerencia en vivo por ticker O por nombre de la empresa
  // (`searchSp500`, lib/sp500.ts). Al elegir una, se comporta exactamente
  // igual que tocar una pill: mismo `pickTicker`.
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Sp500Company[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Selector de temporalidad de la gráfica (ago 2026, pedido explícito de
  // el usuario): la temporalidad por defecto ("15m") sigue viniendo de `data`
  // (la ruta principal, con la vela de HOY pegada y el pre-market
  // sombreado) — al elegir otra, se pide aparte a un endpoint liviano
  // (app/api/grandes-empresas/chart/route.ts) que solo trae velas, sin
  // recalcular toda la señal.
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
    historyRef.current = [];
    setPersistent(null);
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
      const res = await fetch(`/api/pdf/grandes-empresas?ticker=${ticker}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (requestedTickerRef.current !== ticker) return;
      setData(json as Result);
      setLastUpdated(new Date());
      historyRef.current = [...historyRef.current, (json as Result).signal].slice(-PERSISTENCE_REQUIRED);
      setPersistent(applyPersistence(historyRef.current));
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

  const signal = persistent;
  const chartLevels: ChartLevelLine[] =
    data?.premarketRejections.map((r) => ({ price: r.price, kind: r.kind, touches: r.touches })) ?? [];

  return (
    <div className="ge-wrap">
      <style>{CSS}</style>

      <header className="ge-head">
        <div>
          <h1>Grandes empresas</h1>
          <p>Magnificent Seven + PLTR, IREN, NFLX, SPCX, INTC, ORCL, HOOD — Premium Traded real + imán del GEX real (Tastytrade).</p>
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
            {data.expirations.length > 0 && (
              <span className="ge-expirations">
                {data.expirations.length === 1 ? "Vencimiento: " : "Vencimientos: "}
                {data.expirations.map(fmtExpiration).join(" · ")}
              </span>
            )}
          </div>
          {data.magnet && (
            <div className="ge-magnet-box">
              <span className="ge-magnet-label">🧲 Imán (GEX real)</span>
              <span className="ge-magnet-value">${data.magnet.strike.toFixed(2)}</span>
              <span className="ge-magnet-sub">
                muro calls ${data.magnet.callWall.toFixed(0)} · muro puts ${data.magnet.putWall.toFixed(0)}
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

      {signal && <SignalBox signal={signal} />}

      {data?.suggestions && <SpreadSuggestions s={data.suggestions} />}

      <p className="ge-foot">
        Se actualiza sola cada 60s. Dinero simulado — no es consejo financiero. Vencimientos usados según el
        día de la semana que se está operando (nunca cruza a la semana siguiente): lunes combina 0DTE de hoy +
        miércoles + viernes; martes combina miércoles + viernes; miércoles combina 0DTE de hoy + viernes;
        jueves usa solo viernes; viernes usa solo el 0DTE de hoy. El
imán sale del GEX calculado con la gamma y el OI reales de Tastytrade (vencimientos de la semana); el Premium Traded y el Net Premium salen del Time & Sales de Tastytrade; el call/put y los targets salen del mismo motor de
        "Contratos vecinos 3.0" (Premium Traded acumulado del día confirma dónde está el dinero, Net Premium
        del ÚLTIMO bucket de 5 min — no acumulado — confirma la dirección de AHORA). La dirección se marca
        "✅ confirmado" recién al sostenerse {PERSISTENCE_REQUIRED} lecturas seguidas.
      </p>
    </div>
  );
}

/** Ver ContratosVecinos3Tab.tsx — mismo panel, mismo motor (lib/contratosVecinos3.ts → orderBookSentiment). */
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

function SignalBox({ signal }: { signal: PersistentSignal }) {
  if (!signal.type) {
    return (
      <section className="ge-advice ge-advice-lateral">
        <span className="ge-advice-tag">🟡 SIN ACTIVIDAD REAL — NO OPERAR</span>
        <p>{signal.reason}</p>
      </section>
    );
  }

  const dirLabel = signal.type === "call" ? "🟢 CALL" : "🔴 PUT";
  return (
    <section className={`ge-advice ${signal.type === "call" ? "ge-advice-call" : "ge-advice-put"} ${signal.confirmed ? "" : "ge-advice-pending"}`}>
      <div className="ge-advice-top">
        <span className="ge-advice-dir">{dirLabel}</span>
        {signal.confirmed ? (
          <span className="ge-advice-tag ge-advice-tag-confirmed">✅ confirmado ({PERSISTENCE_REQUIRED} lecturas)</span>
        ) : (
          <span className="ge-advice-tag ge-advice-tag-wait">⏳ confirmando… (evita entrar todavía)</span>
        )}
        {signal.wallStrike != null && <span className="ge-advice-tag ge-advice-tag-wait">🧱 pared en ${signal.wallStrike}</span>}
        {signal.capStrike != null && <span className="ge-advice-tag ge-advice-tag-wait">⛔ probable techo ${signal.capStrike}</span>}
        {signal.capReversal && <span className="ge-advice-tag ge-advice-tag-wait">🔄 posible agotamiento ${signal.capReversal.strike}</span>}
      </div>
      <div className="ge-targets-row">
        <TargetChip label="Target 1" target={signal.target1} />
        <TargetChip label="Target 2" target={signal.target2} />
        {signal.stopLoss && (
          <div className="ge-chip ge-chip-stop">
            <div className="ge-chip-label">Stop-loss</div>
            <div className="ge-chip-value">${signal.stopLoss.strike}</div>
            <div className="ge-chip-sub">baja actividad · {signal.stopLoss.type === "call" ? "calls" : "puts"}</div>
          </div>
        )}
        {signal.supportingWall && (
          <div className="ge-chip ge-chip-support">
            <div className="ge-chip-label">{signal.supportingWall.label === "soporte" ? "Soporte" : "Resistencia"} real</div>
            <div className="ge-chip-value">${signal.supportingWall.strike}</div>
            <div className="ge-chip-sub">venta de {signal.supportingWall.type === "call" ? "calls" : "puts"} · refuerza la tesis</div>
          </div>
        )}
        {signal.capReversal && (
          <div className="ge-chip ge-chip-reversal">
            <div className="ge-chip-label">Posible agotamiento</div>
            <div className="ge-chip-value">${signal.capReversal.strike}</div>
            <div className="ge-chip-sub">
              {[
                signal.capReversal.contraSideAggressive && "lado contrario también al ask ahí",
                signal.capReversal.nextStrikeSelling && "venta ya en el siguiente strike",
              ].filter(Boolean).join(" · ")}
            </div>
          </div>
        )}
        {signal.breakoutWatch && (
          <div className={`ge-chip ge-chip-breakout ${signal.breakoutWatch.unusual ? "ge-chip-unusual" : ""}`}>
            <div className="ge-chip-label">Vigilar detrás de la pared</div>
            <div className="ge-chip-value">${signal.breakoutWatch.strike}</div>
            <div className="ge-chip-sub">
              compra real · necesita que ${signal.wallStrike} ceda primero
              {signal.breakoutWatch.unusual && <span className="ge-chip-flag"> · ⚡ actividad inusual</span>}
            </div>
          </div>
        )}
      </div>
      {signal.capCandidate && (
        <div className={`ge-capcand ${signal.capCandidate.confirmed ? "ge-capcand-confirmed" : "ge-capcand-pending"}`}>
          <div className="ge-capcand-head">
            {signal.capCandidate.confirmed ? "🎯" : "🔍"} Candidato a punto máximo real: <b>${signal.capCandidate.strike}</b>
            <span className="ge-capcand-sub">(actividad explotando — camino spot→strike chequeado abajo)</span>
          </div>
          <ul className="ge-capcand-checks">
            <CheckItem ok={signal.capCandidate.pathAllPositive} label="Todo el camino comprado (net premium positivo en cada strike)" />
            <CheckItem ok={signal.capCandidate.pathBuildingUp} label="Premium Traded en aumento parejo hacia el candidato" />
            <CheckItem ok={signal.capCandidate.pathOppositeClean} label="El tipo contrario no compite en el camino" />
            <CheckItem ok={signal.capCandidate.nextStrikeConfirms} label="El strike siguiente ya confirma (menos plata y vendido)" />
            <CheckItem ok={signal.capCandidate.opposingSideClean} label="El lado opuesto del tablero no agrede" />
          </ul>
        </div>
      )}
      <p>{signal.reason}</p>
    </section>
  );
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={ok ? "ge-check-ok" : "ge-check-fail"}>
      {ok ? "✅" : "❌"} {label}
    </li>
  );
}

/** Sugerencias de spreads del vencimiento más cercano — vertical de débito
 * (direccional), credit call e iron condor (neutrales), con bid/ask real de
 * tastytrade. Mismo motor y mismo layout que Agente ODTE (lib/zerodteSuggestions.ts). */
function SpreadSuggestions({ s }: { s: ZeroDteSuggestions }) {
  const biasLabel =
    s.bias === "alcista" ? `▲ sesgo alcista (${s.biasSource === "pin" ? "imán" : "agresor"})`
    : s.bias === "bajista" ? `▼ sesgo bajista (${s.biasSource === "pin" ? "imán" : "agresor"})`
    : "▬ sin sesgo claro";

  return (
    <section className="ge-spreads">
      <header>
        <h2>Sugerencias de spreads</h2>
        <span className={`ge-spreads-bias ge-spreads-bias-${s.bias}`}>{biasLabel}</span>
      </header>

      <div className="ge-spreads-grid">
        <div className="ge-spread-card">
          <span className="ge-sum-lbl">Vertical de débito</span>
          {s.vertical ? (
            <>
              <b>{s.vertical.kind === "bull_call" ? "Bull Call" : "Bear Put"}</b>
              <span className="ge-spread-legs">Compra {s.vertical.longStrike} · Vende {s.vertical.shortStrike}</span>
              <div className="ge-spread-nums">
                <div><span>Débito</span><b>{money0(s.vertical.debit)}</b></div>
                <div><span>Máx. ganancia</span><b className="ge-spread-good">{money0(s.vertical.maxProfit)}</b></div>
                <div><span>Breakeven</span><b>{dec(s.vertical.breakeven)}</b></div>
              </div>
            </>
          ) : (
            <p className="ge-spread-empty">
              {s.bias === "lateral" ? "Sin sesgo direccional claro — no se arma." : "Sin strikes cotizados suficientes."}
            </p>
          )}
        </div>

        <div className="ge-spread-card">
          <span className="ge-sum-lbl">Credit Call</span>
          {s.creditCall ? (
            <>
              <b>Bear Call</b>
              <span className="ge-spread-legs">Vende {s.creditCall.shortCall} · Compra {s.creditCall.longCall}</span>
              <div className="ge-spread-nums">
                <div><span>Crédito</span><b className="ge-spread-good">{money0(s.creditCall.credit)}</b></div>
                <div><span>Máx. pérdida</span><b>{money0(s.creditCall.maxLoss)}</b></div>
                <div><span>Breakeven</span><b>{dec(s.creditCall.breakeven)}</b></div>
              </div>
            </>
          ) : (
            <p className="ge-spread-empty">Sin strikes cotizados suficientes arriba del rango.</p>
          )}
        </div>

        <div className="ge-spread-card">
          <span className="ge-sum-lbl">Iron Condor</span>
          {s.ironCondor ? (
            <>
              <b>{s.ironCondor.shortPut}P / {s.ironCondor.shortCall}C</b>
              <span className="ge-spread-legs">Alas: {s.ironCondor.longPut}P · {s.ironCondor.longCall}C</span>
              <div className="ge-spread-nums">
                <div><span>Crédito</span><b className="ge-spread-good">{money0(s.ironCondor.credit)}</b></div>
                <div><span>Rango seguro</span><b>{dec(s.ironCondor.beLow)} – {dec(s.ironCondor.beHigh)}</b></div>
              </div>
            </>
          ) : (
            <p className="ge-spread-empty">Sin strikes cotizados suficientes en ambos lados del rango.</p>
          )}
        </div>
      </div>

      <p className="ge-spreads-note">
        Vertical: apunta al borde de 1σ del movimiento esperado (sesgo del agresor neto). Credit Call e Iron
        Condor venden el borde de 1σ y compran el de 2σ como protección — spreads con riesgo definido, ambas
        patas. Precios de débito/crédito al ask/bid real de cada pata — pueden no llenarse a ese precio exacto.
        Dinero simulado, no es consejo financiero.
      </p>
    </section>
  );
}

function TargetChip({ label, target }: { label: string; target: Target | null }) {
  return (
    <div className={`ge-chip ${target?.unusual ? "ge-chip-unusual" : ""}`}>
      <div className="ge-chip-label">{label}</div>
      <div className="ge-chip-value">{target ? `$${target.strike}` : "—"}</div>
      {target && (
        <div className="ge-chip-sub">
          {money0(target.totalPremium)} Premium Traded
          {target.unusual && <span className="ge-chip-flag"> · ⚡ actividad inusual</span>}
        </div>
      )}
    </div>
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
.ge-expirations { font-size: 11px; color: var(--faint); margin-top: 1px; }

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
.ge-chart-canvas-wrap { position: relative; width: 100%; height: 100%; }
.ge-chart-overlay { position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.ge-chart-canvas { position: relative; z-index: 1; width: 100%; height: 100%; }
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
.ge-advice-pending { opacity: .75; }
.ge-advice-tag-confirmed { background: var(--green-bg); color: var(--green-dark); border-color: var(--green); }
.ge-advice-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
.ge-advice-dir { font-size: 20px; font-weight: 800; }
.ge-advice-tag { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--border); }
.ge-advice-tag-wait { background: var(--amber-bg); color: var(--amber-text); border-color: var(--amber-border); }
.ge-advice p { margin: 8px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--text); }

.ge-targets-row { display: flex; gap: 12px; flex-wrap: wrap; }
.ge-chip { background: var(--panel-2); border: 1px solid var(--border-soft); border-radius: 8px;
  padding: 10px 14px; min-width: 130px; }
.ge-chip-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
.ge-chip-value { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ge-chip-sub { font-size: 11.5px; color: var(--faint); margin-top: 2px; }
.ge-chip-stop { border-color: var(--amber-border); }
.ge-chip-support { border-color: var(--accent); }
.ge-chip-breakout { border-color: var(--border-soft); border-style: dashed; }
.ge-chip-reversal { border-color: var(--red-soft); }
.ge-chip-unusual { border-color: var(--amber-border); box-shadow: 0 0 0 1px var(--amber-border) inset; }
.ge-chip-flag { color: var(--amber-text); font-weight: 700; }

.ge-capcand { margin-top: 12px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel-2); }
.ge-capcand-confirmed { border-color: var(--green); }
.ge-capcand-pending { border-color: var(--amber-border); }
.ge-capcand-head { font-size: 13px; font-weight: 700; }
.ge-capcand-sub { font-weight: 400; color: var(--faint); font-size: 11.5px; margin-left: 4px; }
.ge-capcand-checks { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ge-capcand-checks li { font-size: 12.5px; }
.ge-check-ok { color: var(--green-dark); }
.ge-check-fail { color: var(--faint); }

.ge-spreads { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.ge-spreads header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.ge-spreads h2 { margin: 0; font-size: 15px; }
.ge-spreads-bias { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel-2); border: 1px solid var(--border); }
.ge-spreads-bias-alcista { background: var(--green-bg); color: var(--green-dark); }
.ge-spreads-bias-bajista { background: var(--red-bg); color: #b42318; }
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
