"use client";

// "Contratos vecinos 3.0" — a diferencia de "Contratos vecinos 2.0" (el imán
// del GEX decide y el dinero real confirma), acá NO hay GEX: el dinero real
// de MarketSnack (Premium Traded + Net Premium) decide todo. Pedido explícito
// (ago 2026), con un ejemplo práctico dado a mano (SPX en 7750,
// ver lib/contratosVecinos3.ts). Solo SPX/SPY/QQQ — mismo universo que
// Agente ODTE.

import { useCallback, useEffect, useRef, useState } from "react";
import { applyPersistence, PERSISTENCE_REQUIRED, type ContratosVecinos3Signal, type PersistentSignal } from "@/lib/pdf/contratosVecinos3";

type TickerId = "SPX" | "SPY" | "QQQ";
const TICKERS: { id: TickerId; label: string }[] = [
  { id: "SPX", label: "SPX" },
  { id: "SPY", label: "SPY" },
  { id: "QQQ", label: "QQQ" },
];
const DEFAULT_TICKER: TickerId = "SPX";
const KEY_TICKER = "visionary.contratosVecinos3.ticker";
// Más frecuente que "Contratos vecinos 2.0" (60s) — pedido explícito de
// el usuario: "siempre tiene que actualizarse" para poder ver el Premium Traded
// subiendo o bajando en vivo, no solo una foto fija.
const REFRESH_MS = 30 * 1000;

type Trend = "subiendo" | "bajando" | "estable";

interface Activity {
  totalPremium: number;
  netPremium: number;
  trend: Trend;
}

interface ActivityLevel {
  strike: number;
  type: "call" | "put";
  activity: Activity;
  /** Actividad del tipo contrario en el mismo strike (put arriba, call abajo) — solo para mostrar. */
  otherActivity?: Activity | null;
}

type Target = NonNullable<ContratosVecinos3Signal["target1"]>;

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
  marketOpen: boolean;
  magnetStrike: number | null;
  gexNote: string | null;
  above: ActivityLevel[];
  below: ActivityLevel[];
  signal: ContratosVecinos3Signal;
  orderBook: OrderBookSentiment;
}

const money0 = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const etTime = () => new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

export default function ContratosVecinos3Tab() {
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selTicker, setSelTicker] = useState<TickerId>(DEFAULT_TICKER);
  const [tickerReady, setTickerReady] = useState(false);
  // Mismo guardia de "pedido en vuelo" que Contratos vecinos 2.0: una
  // respuesta vieja puede llegar después de la nueva si el usuario cambió de
  // ticker mientras un fetch seguía en camino.
  const requestedTickerRef = useRef<TickerId | null>(null);
  // Filtro de persistencia (pedido explícito, tras un backtest real
  // del 2026-08-13: señales que duraban 1-2 minutos no eran operables). Se
  // acumulan las últimas lecturas crudas y `applyPersistence` (lib puro)
  // decide si la dirección se sostuvo. Vive en un ref (no en historyRef de
  // React state) porque no necesita re-render por sí solo — se lee junto con
  // `data` en cada `load()`. Se reinicia al cambiar de ticker: la historia de
  // SPX no debe confirmar una señal de QQQ.
  const historyRef = useRef<ContratosVecinos3Signal[]>([]);
  const [persistent, setPersistent] = useState<PersistentSignal | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY_TICKER);
    if (saved === "SPX" || saved === "SPY" || saved === "QQQ") setSelTicker(saved);
    setTickerReady(true);
  }, []);

  const pickTicker = useCallback((id: TickerId) => {
    historyRef.current = [];
    setPersistent(null);
    setSelTicker(id);
    window.localStorage.setItem(KEY_TICKER, id);
  }, []);

  const load = useCallback(async (ticker: TickerId) => {
    requestedTickerRef.current = ticker;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pdf/contratos-vecinos-3?ticker=${ticker}`, { cache: "no-store" });
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

  return (
    <div className="c3-wrap">
      <style>{CSS}</style>

      <header className="c3-head">
        <div>
          <h1>Contratos vecinos 3.0</h1>
          <p>Premium Traded real (MarketSnack) marca soportes/resistencias — el Net Premium confirma la dirección. Sin GEX.</p>
        </div>
        <div className="c3-controls">
          <select value={selTicker} onChange={(e) => pickTicker(e.target.value as TickerId)} aria-label="Ticker">
            {TICKERS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <span className={`c3-mkt ${data?.marketOpen ? "c3-mkt-on" : "c3-mkt-off"}`}>
            {data?.marketOpen ? "🟢 mercado abierto" : "🔴 mercado cerrado"}
          </span>
          {lastUpdated && <span className="c3-updated">actualizado {etTime()} ET</span>}
          <button onClick={() => load(selTicker)} disabled={loading}>
            {loading ? "Cargando…" : "🔄 Actualizar"}
          </button>
        </div>
      </header>

      {error && <div className="c3-error">⚠ {error}</div>}

      {data && (
        <div className="c3-meta">
          <span><b>{data.ticker}</b> 0DTE</span>
          <span>Spot <b>{data.spot.toFixed(2)}</b></span>
          {data.magnetStrike != null && (
            <span className="c3-magnet">🧲 Imán (GEX): <b>${data.magnetStrike}</b> — solo referencia, no decide la señal</span>
          )}
        </div>
      )}

      {data && <OrderBookBanner ob={data.orderBook} />}

      {signal && <SignalBox signal={signal} gexNote={data?.gexNote ?? null} />}

      {data && (
        <div className="c3-cols">
          <ActivityTable title="Arriba del spot" levels={data.above} signal={signal} />
          <ActivityTable title="Abajo del spot" levels={data.below} signal={signal} />
        </div>
      )}

      <p className="c3-foot">
        Se actualiza sola cada 30s. Dinero simulado — no es consejo financiero. Premium Traded = toda la
        actividad real de HOY en ese strike (acumulado, compra + venta); Net Premium confirma la dirección
        con la lectura de AHORA MISMO, del último bucket de 5 min — nunca acumulado del día (positivo =
        compra agresiva, negativo = venta). Solo se confirma un target donde hay actividad alta Y compra
        agresiva a la vez — actividad alta pero vendida es una pared, no una entrada. La dirección se marca
        "✅ confirmado" recién al sostenerse {PERSISTENCE_REQUIRED} lecturas seguidas (evita operar
        parpadeos de 1-2 minutos, confirmado con un backtest real). El stop-loss solo mira los{" "}
        {"4"} strikes más cercanos al spot — mejor sin sugerencia que una a 40+ puntos de distancia.
      </p>
    </div>
  );
}

/**
 * Panel del order book (pedido explícito, 2026-08-25, inspirado en
 * "Asset Order Book Side"/"Asset Premium Sentiment" de MarketSnack): SOLO
 * informativo — no toca la señal call/put de arriba. Balanceado = posible
 * rebote; desbalanceado + el lado dominante comprándose al ask = "desangrando"
 * en esa dirección. "Mensaje en grande" pedido explícito — banner propio,
 * no un chip chico perdido entre los demás.
 */
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

function SignalBox({ signal, gexNote }: { signal: PersistentSignal; gexNote: string | null }) {
  if (!signal.type) {
    return (
      <section className="c3-advice c3-advice-lateral">
        <span className="c3-advice-tag">🟡 SIN ACTIVIDAD REAL — NO OPERAR</span>
        <p>{signal.reason}</p>
      </section>
    );
  }

  const dirLabel = signal.type === "call" ? "🟢 CALL" : "🔴 PUT";
  return (
    <section className={`c3-advice ${signal.type === "call" ? "c3-advice-call" : "c3-advice-put"} ${signal.confirmed ? "" : "c3-advice-pending"}`}>
      <div className="c3-advice-top">
        <span className="c3-advice-dir">{dirLabel}</span>
        {signal.confirmed ? (
          <span className="c3-advice-tag c3-advice-tag-confirmed">✅ confirmado ({PERSISTENCE_REQUIRED} lecturas)</span>
        ) : (
          <span className="c3-advice-tag c3-advice-tag-wait">⏳ confirmando… (evita entrar todavía)</span>
        )}
        {signal.wallStrike != null && (
          <span className="c3-advice-tag c3-advice-tag-wait">🧱 pared en ${signal.wallStrike}</span>
        )}
        {signal.capStrike != null && (
          <span className="c3-advice-tag c3-advice-tag-wait">⛔ probable techo ${signal.capStrike}</span>
        )}
        {signal.capReversal && (
          <span className="c3-advice-tag c3-advice-tag-wait">🔄 posible agotamiento ${signal.capReversal.strike}</span>
        )}
      </div>
      <div className="c3-targets-row">
        <TargetChip label="Target 1" target={signal.target1} />
        <TargetChip label="Target 2" target={signal.target2} />
        {signal.stopLoss && (
          <div className="c3-chip c3-chip-stop">
            <div className="c3-chip-label">Stop-loss</div>
            <div className="c3-chip-value">${signal.stopLoss.strike}</div>
            <div className="c3-chip-sub">baja actividad · {signal.stopLoss.type === "call" ? "calls" : "puts"}</div>
          </div>
        )}
        {signal.supportingWall && (
          <div className="c3-chip c3-chip-support">
            <div className="c3-chip-label">{signal.supportingWall.label === "soporte" ? "Soporte" : "Resistencia"} real</div>
            <div className="c3-chip-value">${signal.supportingWall.strike}</div>
            <div className="c3-chip-sub">venta de {signal.supportingWall.type === "call" ? "calls" : "puts"} · refuerza la tesis</div>
          </div>
        )}
        {signal.capReversal && (
          <div className="c3-chip c3-chip-reversal">
            <div className="c3-chip-label">Posible agotamiento</div>
            <div className="c3-chip-value">${signal.capReversal.strike}</div>
            <div className="c3-chip-sub">
              {[
                signal.capReversal.contraSideAggressive && "lado contrario también al ask ahí",
                signal.capReversal.nextStrikeSelling && "venta ya en el siguiente strike",
              ].filter(Boolean).join(" · ")}
            </div>
          </div>
        )}
        {signal.breakoutWatch && (
          <div className={`c3-chip c3-chip-breakout ${signal.breakoutWatch.unusual ? "c3-chip-unusual" : ""}`}>
            <div className="c3-chip-label">Vigilar detrás de la pared</div>
            <div className="c3-chip-value">${signal.breakoutWatch.strike}</div>
            <div className="c3-chip-sub">
              compra real · necesita que ${signal.wallStrike} ceda primero
              {signal.breakoutWatch.unusual && <span className="c3-chip-flag"> · ⚡ actividad inusual</span>}
            </div>
          </div>
        )}
      </div>
      {signal.capCandidate && (
        <div className={`c3-capcand ${signal.capCandidate.confirmed ? "c3-capcand-confirmed" : "c3-capcand-pending"}`}>
          <div className="c3-capcand-head">
            {signal.capCandidate.confirmed ? "🎯" : "🔍"} Candidato a punto máximo real: <b>${signal.capCandidate.strike}</b>
            <span className="c3-capcand-sub">(actividad explotando — camino spot→strike chequeado abajo)</span>
          </div>
          <ul className="c3-capcand-checks">
            <CheckItem ok={signal.capCandidate.pathAllPositive} label="Todo el camino comprado (net premium positivo en cada strike)" />
            <CheckItem ok={signal.capCandidate.pathBuildingUp} label="Premium Traded en aumento parejo hacia el candidato" />
            <CheckItem ok={signal.capCandidate.pathOppositeClean} label="El tipo contrario no compite en el camino" />
            <CheckItem ok={signal.capCandidate.nextStrikeConfirms} label="El strike siguiente ya confirma (menos plata y vendido)" />
            <CheckItem ok={signal.capCandidate.opposingSideClean} label="El lado opuesto del tablero no agrede" />
          </ul>
        </div>
      )}
      {gexNote && <p className="c3-gexnote">{gexNote}</p>}
      <p>{signal.reason}</p>
    </section>
  );
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={ok ? "c3-check-ok" : "c3-check-fail"}>
      {ok ? "✅" : "❌"} {label}
    </li>
  );
}

function TargetChip({ label, target }: { label: string; target: Target | null }) {
  return (
    <div className={`c3-chip ${target?.unusual ? "c3-chip-unusual" : ""}`}>
      <div className="c3-chip-label">{label}</div>
      <div className="c3-chip-value">{target ? `$${target.strike}` : "—"}</div>
      {target && (
        <div className="c3-chip-sub">
          {money0(target.totalPremium)} Premium Traded
          {target.unusual && <span className="c3-chip-flag"> · ⚡ actividad inusual</span>}
        </div>
      )}
    </div>
  );
}

function ActivityTable({ title, levels, signal }: { title: string; levels: ActivityLevel[]; signal: ContratosVecinos3Signal | null }) {
  const keyStrikes = new Set(
    [
      signal?.target1?.strike, signal?.target2?.strike, signal?.wallStrike, signal?.stopLoss?.strike,
      signal?.breakoutWatch?.strike, signal?.capReversal?.strike,
    ].filter((s): s is number => s != null),
  );
  const maxPremium = Math.max(1, ...levels.map((l) => l.activity.totalPremium));

  return (
    <section className="c3-box">
      <header><h2>{title}</h2></header>
      {levels.length === 0 ? (
        <p className="c3-box-empty">Sin contratos con datos todavía.</p>
      ) : (
        <table className="c3-table">
          <thead>
            <tr>
              <th>Strike</th><th>Premium Traded</th><th>Net Premium call</th><th>Net Premium put</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => {
              const isKey = keyStrikes.has(l.strike);
              const barPct = (l.activity.totalPremium / maxPremium) * 100;
              const call = l.type === "call" ? l.activity : l.otherActivity;
              const put = l.type === "put" ? l.activity : l.otherActivity;
              return (
                <tr key={l.strike} className={isKey ? "c3-row-key" : ""}>
                  <td className="c3-strike">${l.strike}</td>
                  <td className="c3-vol">
                    <span>{money0(l.activity.totalPremium)}</span>
                    <i className="c3-bar" style={{ width: `${barPct}%` }} />
                  </td>
                  <td className={call == null ? "" : call.netPremium >= 0 ? "c3-net-pos" : "c3-net-neg"}>
                    {call ? money0(call.netPremium) : "—"}
                  </td>
                  <td className={put == null ? "" : put.netPremium >= 0 ? "c3-net-pos" : "c3-net-neg"}>
                    {put ? money0(put.netPremium) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

const CSS = `
.c3-wrap { max-width: 1200px; margin: 0 auto; padding: 0 0 40px; font-size: 15px; }
.c3-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.c3-head h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.2px; }
.c3-head p { margin: 0; color: var(--muted); font-size: 13.5px; }
.c3-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.c3-controls select { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.c3-controls button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  background: var(--accent); border: 1px solid var(--accent); color: #fff; font-weight: 600; }
.c3-controls button:disabled { opacity: .6; cursor: default; }
.c3-mkt { font-size: 12.5px; padding: 3px 9px; border-radius: 999px; font-weight: 600; }
.c3-mkt-on { background: var(--green-bg); color: var(--green-dark); border: 1px solid var(--green); }
.c3-mkt-off { background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }
.c3-updated { font-size: 12.5px; color: var(--faint); font-variant-numeric: tabular-nums; }

.c3-error { background: var(--red-bg); border: 1px solid var(--red-soft); color: #7a271a;
  padding: 12px 14px; border-radius: 8px; margin: 16px 0; }

.c3-meta { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; margin: 18px 0 14px;
  color: var(--muted); font-size: 13.5px; }
.c3-meta b { color: var(--text); }
.c3-magnet { color: var(--accent); }

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

.c3-advice { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; background: var(--panel); }
.c3-advice-call { border-color: var(--green); background: var(--green-bg); }
.c3-advice-put { border-color: var(--red-soft); background: var(--red-bg); }
.c3-advice-lateral { border-color: var(--amber-border); background: var(--amber-bg); text-align: center; }
.c3-advice-pending { opacity: .75; }
.c3-advice-tag-confirmed { background: var(--green-bg); color: var(--green-dark); border-color: var(--green); }
.c3-advice-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
.c3-advice-dir { font-size: 20px; font-weight: 800; }
.c3-advice-tag { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--border); }
.c3-advice-tag-wait { background: var(--amber-bg); color: var(--amber-text); border-color: var(--amber-border); }
.c3-advice p { margin: 8px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--text); }
.c3-gexnote { font-weight: 600; color: var(--accent); }

.c3-capcand { margin-top: 12px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-soft); background: var(--panel-2); }
.c3-capcand-confirmed { border-color: var(--green); }
.c3-capcand-pending { border-color: var(--amber-border); }
.c3-capcand-head { font-size: 13px; font-weight: 700; }
.c3-capcand-sub { font-weight: 400; color: var(--faint); font-size: 11.5px; margin-left: 4px; }
.c3-capcand-checks { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.c3-capcand-checks li { font-size: 12.5px; }
.c3-check-ok { color: var(--green-dark); }
.c3-check-fail { color: var(--faint); }

.c3-targets-row { display: flex; gap: 12px; flex-wrap: wrap; }
.c3-chip { background: var(--panel-2); border: 1px solid var(--border-soft); border-radius: 8px;
  padding: 10px 14px; min-width: 130px; }
.c3-chip-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
.c3-chip-value { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.c3-chip-sub { font-size: 11.5px; color: var(--faint); margin-top: 2px; }
.c3-chip-stop { border-color: var(--amber-border); }
.c3-chip-support { border-color: var(--accent); }
.c3-chip-breakout { border-color: var(--border-soft); border-style: dashed; }
.c3-chip-reversal { border-color: var(--red-soft); }
.c3-chip-unusual { border-color: var(--amber-border); box-shadow: 0 0 0 1px var(--amber-border) inset; }
.c3-chip-flag { color: var(--amber-text); font-weight: 700; }

.c3-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; margin: 0 0 16px; }
.c3-box { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; }
.c3-box header { margin-bottom: 10px; }
.c3-box h2 { margin: 0; font-size: 15px; }
.c3-box-empty { color: var(--faint); font-size: 13px; margin: 0; }

.c3-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.c3-table th, .c3-table td { padding: 7px 8px; text-align: right; font-size: 13px;
  border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
.c3-table th { color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
.c3-strike { text-align: left !important; font-weight: 700; }
.c3-vol { position: relative; text-align: left !important; }
.c3-vol span { position: relative; z-index: 1; }
.c3-bar { position: absolute; left: 0; bottom: 2px; height: 3px; border-radius: 2px; background: var(--accent); opacity: .5; }
.c3-net-pos { color: var(--green-dark); font-weight: 600; }
.c3-net-neg { color: #b42318; font-weight: 600; }
.c3-row-key { background: var(--accent-dim); }
.c3-row-key .c3-strike { color: var(--accent); }

.c3-foot { color: var(--faint); font-size: 12px; margin-top: 8px; line-height: 1.5; }
`;
