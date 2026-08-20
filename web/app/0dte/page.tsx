"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { int, money, px } from "../format";
import type {
  ZeroDteResponse,
  ZeroDteFlowResponse,
  ZeroDteEvalResponse,
  ZeroDteAnalysis,
} from "./types";

// Vista 0DTE nativa: cadena del día por volumen, muros, imán del GEX, sesgo del
// día, escenarios de cierre, lecturas de agresor y auto-evaluación. Reusa las libs
// del agente (MarketSnack Option Chain 2.0 + Massive + motor puro lib/zerodte.ts).
// NO es consejo financiero: los datos pueden venir retrasados.

const SYMBOLS: { sym: string; label: string; experimental?: boolean }[] = [
  { sym: "SPY", label: "SPY" },
  { sym: "QQQ", label: "QQQ" },
  { sym: "IWM", label: "IWM" },
  { sym: "SPX", label: "SPX", experimental: true },
];
const REFRESH_MS = 60_000;
const LS_KEY = "tito.0dte.sym";

function signed(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

// "Mejor trade ahora" (0DTE): idea de reversión al imán del GEX, SOLO en régimen γ+
// (el dealer estabiliza y tiende a devolver el precio al imán). En γ− no se sugiere
// nada: ahí el dealer amplifica y la vuelta no es fiable. Es PURA y se recalcula en
// cada refresco con el GEX en vivo. No es una orden ni un consejo: el agente calcula
// y muestra; la persona decide y ejecuta.
const STOP_PCT = 0.002;      // colchón del stop = 0.2% del spot (scalp intradía)
const MIN_EDGE_PCT = 0.0004; // separación mínima al imán para que haya recorrido

interface BestTrade {
  side: "LONG" | "SHORT";
  entry: number;
  target: number;
  stop: number;
  reward: number;
  risk: number;
  rr: number;
  rationale: string;
}

function bestTrade(a: ZeroDteAnalysis): { trade: BestTrade | null; note: string } {
  const { spot, magnet, regime } = a;
  if (magnet == null || spot <= 0) return { trade: null, note: "Sin imán del GEX claro por ahora." };
  const dist = magnet - spot; // + = imán por encima del precio
  const absPts = Math.abs(dist);
  if (absPts / spot < MIN_EDGE_PCT) {
    return { trade: null, note: `El precio ya está pegado al imán $${px.format(magnet)} — sin recorrido para operar la vuelta.` };
  }
  if (regime !== "positive") {
    return { trade: null, note: "γ− amplifica: el dealer acelera los movimientos, así que la vuelta al imán no es fiable. Mejor esperar a γ+." };
  }
  const side: BestTrade["side"] = dist > 0 ? "LONG" : "SHORT";
  const entry = spot;
  const stopBuf = spot * STOP_PCT;
  const stop = side === "LONG" ? entry - stopBuf : entry + stopBuf;
  const above = dist < 0; // precio por encima del imán
  const rationale = `γ+ y el precio está ${absPts.toFixed(0)} pts ${above ? "por encima" : "por debajo"} del imán ${px.format(magnet)}; se apuesta a la vuelta al imán.`;
  return {
    trade: { side, entry, target: magnet, stop, reward: absPts, risk: stopBuf, rr: absPts / stopBuf, rationale },
    note: "",
  };
}

function ZeroBestTrade({ a }: { a: ZeroDteAnalysis }) {
  const { trade, note } = useMemo(() => bestTrade(a), [a]);
  return (
    <div className="card z-best">
      <div className="z-best-head">
        <span className="z-best-title">⚡ Mejor trade ahora</span>
        <span className="z-best-chip">se recalcula c/min</span>
      </div>
      {!trade ? (
        <div className="z-best-empty">{note}</div>
      ) : (
        <>
          <div className={`z-best-dir ${trade.side === "LONG" ? "long" : "short"}`}>
            {trade.side === "LONG" ? "▲ LONG" : "▼ SHORT"}
          </div>
          <div className="z-best-grid">
            <div><span>Entrada (ahora)</span><b>${px.format(trade.entry)}</b></div>
            <div><span>Objetivo (imán)</span><b>${px.format(trade.target)}</b></div>
            <div><span>Stop</span><b>${px.format(trade.stop)}</b></div>
            <div><span>Riesgo / Beneficio</span><b>{trade.rr.toFixed(1)} : 1</b></div>
          </div>
          <div className="z-best-why">{trade.rationale}</div>
        </>
      )}
      <div className="z-best-foot">
        Se recalcula cada minuto con el GEX en vivo. El agente calcula y muestra; tú decides y
        ejecutas. <b>No es una orden ni un consejo.</b>
      </div>
    </div>
  );
}

export default function ZeroDtePage() {
  const [sym, setSym] = useState("SPY");
  const [exp, setExp] = useState(""); // "" = 0DTE del día; si no, YYYY-MM-DD elegido
  const [data, setData] = useState<ZeroDteResponse | null>(null);
  const [flow, setFlow] = useState<ZeroDteFlowResponse | null>(null);
  const [evalr, setEvalr] = useState<ZeroDteEvalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const symRef = useRef(sym);
  symRef.current = sym;
  const expRef = useRef(exp);
  expRef.current = exp;

  useEffect(() => {
    try {
      const s = window.localStorage.getItem(LS_KEY);
      if (s && SYMBOLS.some((x) => x.sym === s)) setSym(s);
    } catch { /* noop */ }
  }, []);

  const load = useCallback(async (which: string, whichExp: string) => {
    setBusy(true);
    setError(null);
    try {
      const q = whichExp ? `&exp=${encodeURIComponent(whichExp)}` : "";
      const r = await fetch(`/api/0dte?ticker=${encodeURIComponent(which)}${q}`, { cache: "no-store" });
      const d = (await r.json()) as ZeroDteResponse & { error?: string };
      if (which !== symRef.current || whichExp !== expRef.current) return;
      if (!r.ok || d.error) { setError(d.error ?? "No se pudo cargar la cadena 0DTE."); setData(null); }
      else {
        setData(d);
        setUpdatedAt(new Date().toISOString());
        // Flujo (agresor) y eval en segundo plano, sin bloquear la cadena.
        void fetch(`/api/0dte/flow?ticker=${encodeURIComponent(which)}&expiration=${d.expiration}`, { cache: "no-store" })
          .then((res) => res.json())
          .then((fd: ZeroDteFlowResponse & { error?: string }) => { if (which === symRef.current && !fd.error) setFlow(fd); })
          .catch(() => null);
      }
    } catch {
      if (which === symRef.current) { setError("Se cortó la conexión con el servidor."); }
    } finally {
      if (which === symRef.current && whichExp === expRef.current) setBusy(false);
    }
  }, []);

  const loadEval = useCallback(async (which: string) => {
    try {
      const r = await fetch(`/api/0dte/eval?ticker=${encodeURIComponent(which)}`, { cache: "no-store" });
      const d = (await r.json()) as ZeroDteEvalResponse;
      if (which === symRef.current) setEvalr(d);
    } catch { /* noop */ }
  }, []);

  // Carga + auto-refresh cada REFRESH_MS.
  useEffect(() => {
    setData(null); setFlow(null); setEvalr(null);
    void load(sym, exp);
    void loadEval(sym);
    const id = setInterval(() => load(sym, exp), REFRESH_MS);
    return () => clearInterval(id);
  }, [sym, exp, load, loadEval]);

  const pick = (s: string) => {
    if (s === sym) return;
    setSym(s);
    setExp(""); // al cambiar de símbolo, volvemos al 0DTE del día
    try { window.localStorage.setItem(LS_KEY, s); } catch { /* noop */ }
  };

  return (
    <main className="z-page">
      <div className="hb">
        <div className="hb-title">Time · 0DTE <span className="hb-chip">cadena del día</span></div>
      </div>

      <div className="z-tabs">
        {SYMBOLS.map((s) => (
          <button
            key={s.sym}
            className={`z-tab ${sym === s.sym ? "on" : ""}`}
            onClick={() => pick(s.sym)}
            title={s.experimental ? "Experimental" : undefined}
          >
            {s.label}{s.experimental && <span className="z-exp">beta</span>}
          </button>
        ))}
        <button className="z-refresh" onClick={() => load(sym, exp)} disabled={busy}>↻</button>
      </div>

      {data && data.available.length > 1 && (
        <div className="z-exps" role="group" aria-label="Vencimiento">
          {data.available.map((e) => {
            const on = e.date === data.expiration;
            const label = e.dte === 0 ? "Hoy · 0DTE" : e.dte === 1 ? "Mañana · 1D" : `+${e.dte}D`;
            return (
              <button
                key={e.date}
                className={`z-expbtn ${on ? "on" : ""}`}
                onClick={() => setExp(e.dte === 0 ? "" : e.date)}
                title={e.date}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {error && <div className="error">⚠ {error}</div>}
      {busy && !data && <div className="card z-loading">Cargando la cadena 0DTE de {sym}…</div>}

      {data && (
        <div className="z-body">
          <ZeroHeader data={data} updatedAt={updatedAt} />
          <div className="z-grid">
            <div className="z-col">
              <ZeroBestTrade a={data.analysis} />
              <ZeroOutlook a={data.analysis} />
              <ZeroScenarios a={data.analysis} />
              <ZeroAggressor flow={flow} />
              <ZeroEval evalr={evalr} />
            </div>
            <ZeroChain a={data.analysis} />
          </div>
          <p className="z-disclaimer">
            ⚠ <b>No es consejo financiero.</b> Los datos de la cadena y del flujo pueden venir
            <b> retrasados</b>. El 0DTE es de altísimo riesgo: esto es contexto, no una recomendación de operar.
          </p>
        </div>
      )}
    </main>
  );
}

function ZeroHeader({ data, updatedAt }: { data: ZeroDteResponse; updatedAt: string | null }) {
  const { spot, change, changePercent, expiration, isToday, selectedDte, spotSource, minutesLeft, contractCount } = data;
  const dir = changePercent == null ? "" : changePercent > 0 ? "up" : changePercent < 0 ? "down" : "";
  const h = Math.floor(minutesLeft / 60), m = minutesLeft % 60;
  const badge = isToday
    ? "0DTE · vence HOY"
    : selectedDte === 1
      ? `1DTE · vence mañana (${expiration})`
      : `${selectedDte}DTE · vence ${expiration}`;
  return (
    <div className="card z-head">
      <div className="z-head-price">
        <div className="z-head-spot">${px.format(spot)}</div>
        {changePercent != null && (
          <div className={`z-head-chg ${dir}`}>
            {change != null ? `${signed(change)} ` : ""}({signed(changePercent)}%)
          </div>
        )}
        {spotSource === "paridad" && (
          <span className="z-spotsrc" title="Precio derivado de la paridad put-call de la cadena (Massive no cotiza índices).">≈ paridad</span>
        )}
      </div>
      <div className="z-head-meta">
        <span className={`z-badge ${isToday ? "today" : "warn"}`}>{badge}</span>
        <span className="z-head-sub">
          {isToday && minutesLeft > 0 ? `Cierre en ${h}h ${m}m · ` : isToday ? "Mercado cerrado · " : ""}
          {int.format(contractCount)} contratos
          {updatedAt && ` · act. ${new Date(updatedAt).toLocaleTimeString("en-US", { hour12: false })}`}
        </span>
      </div>
    </div>
  );
}

function ZeroOutlook({ a }: { a: ZeroDteAnalysis }) {
  const leanClass = a.lean === "alcista" ? "up" : a.lean === "bajista" ? "down" : "flat";
  const pos = Math.max(0, Math.min(100, (a.leanScore + 100) / 2)); // −100..100 → 0..100
  return (
    <div className="card z-outlook">
      <div className="z-card-title">Sesgo del día</div>
      <div className={`z-lean ${leanClass}`}>{a.lean.toUpperCase()}</div>
      <div className="z-lean-bar">
        <span className="z-lean-track" />
        <span className="z-lean-dot" style={{ left: `${pos}%` }} />
        <span className="z-lean-mid" />
      </div>
      <div className="z-lean-ends"><span>bajista</span><span>alcista</span></div>
      <div className="z-stats">
        <div><span>Confianza</span><b>{a.confidence}%</b></div>
        <div><span>Régimen GEX</span><b className={a.regime === "positive" ? "up" : "down"}>{a.regime === "positive" ? "γ+ estabiliza" : "γ− amplifica"}</b></div>
        <div><span>Imán</span><b>{a.magnet != null ? `$${px.format(a.magnet)}` : "—"}</b></div>
        <div><span>Flip gamma</span><b>{a.flipStrike != null ? `$${px.format(a.flipStrike)}` : "—"}</b></div>
        <div><span>Dinero en calls</span><b>{a.callPct != null ? `${a.callPct}%` : "—"}</b></div>
        <div><span>Rango 1σ</span><b>${px.format(a.expectedRange.low)}–${px.format(a.expectedRange.high)}</b></div>
      </div>
    </div>
  );
}

function ZeroScenarios({ a }: { a: ZeroDteAnalysis }) {
  const rows = [a.scenarios.bull, a.scenarios.base, a.scenarios.bear];
  return (
    <div className="card z-scen">
      <div className="z-card-title">Escenarios de cierre</div>
      {rows.map((s) => (
        <div key={s.kind} className={`z-scen-row ${s.kind}`}>
          <div className="z-scen-head">
            <span className="z-scen-tag">{s.kind === "bull" ? "▲ Alcista" : s.kind === "bear" ? "▼ Bajista" : "● Base"}</span>
            <span className="z-scen-target">${px.format(s.target)} <em>{signed(s.changePct, 2)}%</em></span>
          </div>
          <div className="z-scen-driver">{s.driver}</div>
        </div>
      ))}
    </div>
  );
}

function ZeroChain({ a }: { a: ZeroDteAnalysis }) {
  // Orden descendente (strikes altos arriba). Inserta la banda del spot.
  const rows = useMemo(() => [...a.strikes].sort((x, y) => y.strike - x.strike), [a.strikes]);
  const maxVol = Math.max(1, a.maxVolume);
  const spot = a.spot;
  // Índice donde cae el spot (entre dos strikes).
  let spotAfter = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].strike <= spot) { spotAfter = i; break; }
  }

  return (
    <div className="card z-chain">
      <div className="z-card-title">Cadena por volumen · muros · imán</div>
      <div className="z-chain-legend">
        <span className="z-lg call">Volumen CALL</span>
        <span className="z-lg put">Volumen PUT</span>
        <span className="z-lg wall">🧱 muro (OI)</span>
        <span className="z-lg magnet">🧲 imán</span>
      </div>
      <div className="z-chain-cols">
        <span>Call OI</span><span>Vol</span><span className="z-mid">Strike</span><span>Vol</span><span>Put OI</span>
      </div>
      <div className="z-chain-rows">
        {rows.map((s, i) => {
          const node = (
            <ZeroChainRow
              key={s.strike}
              strike={s.strike}
              callVol={s.callVolume}
              putVol={s.putVolume}
              callOI={s.call?.openInterest ?? 0}
              putOI={s.put?.openInterest ?? 0}
              maxVol={maxVol}
              itm={s.itm}
              isMagnet={a.magnet === s.strike}
              isMaxCall={a.maxCall?.strike === s.strike}
              isMaxPut={a.maxPut?.strike === s.strike}
            />
          );
          if (i === spotAfter) {
            return (
              <div key={`grp-${s.strike}`}>
                <div className="z-spotband">◄ SPOT ${px.format(spot)} ►</div>
                {node}
              </div>
            );
          }
          return node;
        })}
      </div>
    </div>
  );
}

function ZeroChainRow(props: {
  strike: number; callVol: number; putVol: number; callOI: number; putOI: number;
  maxVol: number; itm: "call" | "put" | null; isMagnet: boolean; isMaxCall: boolean; isMaxPut: boolean;
}) {
  const { strike, callVol, putVol, callOI, putOI, maxVol, itm, isMagnet, isMaxCall, isMaxPut } = props;
  const cw = `${Math.min(100, (callVol / maxVol) * 100)}%`;
  const pw = `${Math.min(100, (putVol / maxVol) * 100)}%`;
  return (
    <div className={`z-row ${isMagnet ? "magnet" : ""}`}>
      <span className={`z-oi ${itm === "call" ? "itm" : ""}`}>{callOI > 0 ? int.format(callOI) : "·"}</span>
      <span className="z-bar-cell call">
        <span className="z-bar call" style={{ width: cw }} />
        <span className="z-bar-num">{callVol > 0 ? int.format(callVol) : ""}</span>
      </span>
      <span className="z-strike">
        {isMaxCall && <span className="z-wall call" title="Muro de calls (MAX CALL)">🧱</span>}
        {px.format(strike)}
        {isMagnet && <span className="z-magnet" title="Imán del GEX">🧲</span>}
        {isMaxPut && <span className="z-wall put" title="Muro de puts (MAX PUT)">🧱</span>}
      </span>
      <span className="z-bar-cell put">
        <span className="z-bar put" style={{ width: pw }} />
        <span className="z-bar-num">{putVol > 0 ? int.format(putVol) : ""}</span>
      </span>
      <span className={`z-oi ${itm === "put" ? "itm" : ""}`}>{putOI > 0 ? int.format(putOI) : "·"}</span>
    </div>
  );
}

function ZeroAggressor({ flow }: { flow: ZeroDteFlowResponse | null }) {
  if (!flow) return (
    <div className="card z-aggr"><div className="z-card-title">Agresor (flujo de hoy)</div><div className="z-muted">Cargando flujo…</div></div>
  );
  const total = flow.summary.bullish + flow.summary.bearish;
  const bullPct = total > 0 ? Math.round((flow.summary.bullish / total) * 100) : null;
  return (
    <div className="card z-aggr">
      <div className="z-card-title">Agresor (flujo de hoy)</div>
      {bullPct != null && (
        <div className="z-aggr-split">
          <span className="z-aggr-fill up" style={{ width: `${bullPct}%` }} />
          <span className="z-aggr-label">{bullPct}% presión alcista · {money.format(total)}</span>
        </div>
      )}
      {flow.reads.length === 0 ? (
        <div className="z-muted">Sin flujo notable en el 0DTE todavía.</div>
      ) : (
        <div className="z-reads">
          {flow.reads.slice(0, 10).map((r) => {
            const isBull = (r.type === "call" && r.side === "compra") || (r.type === "put" && r.side === "venta");
            const cls = r.side === "mixto" ? "flat" : isBull ? "up" : "down";
            return (
              <div key={r.key} className="z-read">
                <span className={`z-read-tag ${r.type}`}>{r.type === "call" ? "CALL" : "PUT"} {px.format(r.strike)}</span>
                <span className={`z-read-side ${cls}`}>{r.side}{r.side !== "mixto" ? ` ${r.pct}%` : ""}</span>
                <span className="z-read-mean">{r.meaning || "sin sesgo claro"}</span>
                <span className="z-read-prem">{money.format(r.premium)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ZeroEval({ evalr }: { evalr: ZeroDteEvalResponse | null }) {
  if (!evalr) return null;
  const rv = evalr.review;
  return (
    <div className="card z-evalc">
      <div className="z-card-title">Memoria del agente (0DTE)</div>
      {!rv || rv.maturedCount === 0 ? (
        <div className="z-muted">Aún no hay pronósticos vencidos ({evalr.snapshots} guardados). La precisión aparece tras el primer cierre.</div>
      ) : (
        <div className="z-stats">
          <div><span>Cierres evaluados</span><b>{rv.maturedCount}</b></div>
          <div><span>Acierto de dirección</span><b>{rv.directionHitRate != null ? `${rv.directionHitRate.toFixed(0)}%` : "—"}</b></div>
          <div><span>Error medio (base)</span><b>{rv.meanAbsErrorPct != null ? `${rv.meanAbsErrorPct.toFixed(2)}%` : "—"}</b></div>
          <div><span>Sesgo</span><b>{rv.biasPct != null ? `${signed(rv.biasPct)}%` : "—"}</b></div>
        </div>
      )}
    </div>
  );
}
