"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { int, money, px } from "../format";
import type { VecinosResponse, VecinosSignal, NeighborStrike, VecinoTarget } from "./types";

// CONTRATOS VECINOS 2.0 — vista de la señal de entrada 0DTE que combina el imán
// del GEX (dirección) con el dinero real ejecutado en los strikes vecinos
// (confirmación). El motor puro vive en lib/vecinos.ts; aquí solo se pinta.
// NO es consejo financiero: los datos pueden venir retrasados.

const SYMBOLS = ["SPY", "QQQ", "IWM", "SPX", "NDX"];
const REFRESH_MS = 60_000;
const LS_KEY = "tito.vecinos.sym";

function signed(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

/** Net premium en $ con signo explícito (el signo ES la señal). */
function netMoney(n: number): string {
  if (n === 0) return "·";
  return `${n > 0 ? "+" : "−"}${money.format(Math.abs(n))}`;
}

/** Etiqueta de la fuente del sesgo. "ninguna" sale cuando el imán cae FUERA del
 *  vecindario (a 10 strikes o más del spot): ahí no hay ni flujo ni pared que leer. */
const SOURCE_LABEL: Record<VecinoTarget["source"], string> = {
  flujo: "dinero real",
  estructura: "posición",
  ninguna: "sin flujo",
};

export default function VecinosPage() {
  const [sym, setSym] = useState("SPY");
  const [exp, setExp] = useState("");
  const [data, setData] = useState<VecinosResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const symRef = useRef(sym);
  symRef.current = sym;
  const expRef = useRef(exp);
  expRef.current = exp;

  useEffect(() => {
    try {
      const s = window.localStorage.getItem(LS_KEY);
      if (s && SYMBOLS.includes(s)) setSym(s);
    } catch { /* noop */ }
  }, []);

  const load = useCallback(async (which: string, whichExp: string) => {
    setBusy(true);
    setError(null);
    try {
      const q = whichExp ? `&exp=${encodeURIComponent(whichExp)}` : "";
      const r = await fetch(`/api/vecinos?ticker=${encodeURIComponent(which)}${q}`, { cache: "no-store" });
      const d = (await r.json()) as VecinosResponse & { error?: string };
      if (which !== symRef.current || whichExp !== expRef.current) return;
      if (!r.ok || d.error) {
        setError(d.error ?? "No se pudo construir la señal de Contratos Vecinos.");
        setData(null);
      } else {
        setData(d);
      }
    } catch {
      if (which === symRef.current) setError("Se cortó la conexión con el servidor.");
    } finally {
      if (which === symRef.current && whichExp === expRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    void load(sym, exp);
    const id = setInterval(() => load(sym, exp), REFRESH_MS);
    return () => clearInterval(id);
  }, [sym, exp, load]);

  const pick = (s: string) => {
    if (s === sym) return;
    setSym(s);
    setExp("");
    try { window.localStorage.setItem(LS_KEY, s); } catch { /* noop */ }
  };

  return (
    <main className="z-page">
      <div className="hb">
        <div className="hb-title">
          Contratos Vecinos <span className="hb-chip">2.0 · imán GEX + flujo real</span>
        </div>
      </div>

      <div className="z-tabs">
        {SYMBOLS.map((s) => (
          <button key={s} className={`z-tab ${sym === s ? "on" : ""}`} onClick={() => pick(s)}>
            {s}
          </button>
        ))}
        <button className="z-refresh" onClick={() => load(sym, exp)} disabled={busy} title="Recargar">↻</button>
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
      {busy && !data && <div className="card z-loading">Calculando los contratos vecinos de {sym}…</div>}

      {data && (
        <div className="z-body">
          <VecHeader data={data} />
          <VecDecision data={data} />
          <div className="z-grid">
            <div className="z-col">
              <VecTargets
                title="Objetivos hacia el imán"
                hint="Paso 3 — hasta 3 strikes que confirman con dinero real, y el imán siempre como último."
                targets={data.signal.towardTargets}
                empty="Sin dirección que perseguir (lateral)."
              />
              <VecTargets
                title="Objetivos de ruptura (invalidación)"
                hint="Paso 4 — del lado contrario al imán. Si el precio rompe ahí, la tesis se cae."
                targets={data.signal.breakoutTargets}
                empty="Ningún strike del lado opuesto confirma la dirección contraria."
              />
              <VecHow />
            </div>
            <VecNeighborhood signal={data.signal} />
          </div>
          <p className="z-disclaimer">
            ⚠ <b>No es consejo financiero.</b> Los datos de la cadena y del flujo pueden venir
            <b> retrasados</b>. El 0DTE es de altísimo riesgo: esto es contexto, no una recomendación
            de operar. El agente calcula y muestra; tú decides y ejecutas.
          </p>
        </div>
      )}
    </main>
  );
}

function VecHeader({ data }: { data: VecinosResponse }) {
  const { spot, change, changePercent, expiration, isToday, selectedDte, spotSource, minutesLeft } = data;
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
          <span className="z-spotsrc" title="Precio derivado de la paridad put-call de la cadena.">≈ paridad</span>
        )}
      </div>
      <div className="z-head-meta">
        <span className={`z-badge ${isToday ? "today" : "warn"}`}>{badge}</span>
        <span className="z-head-sub">
          {isToday && minutesLeft > 0 ? `Cierre en ${h}h ${m}m · ` : isToday ? "Mercado cerrado · " : ""}
          {int.format(data.contractCount)} contratos · {int.format(data.flowTrades)} trades con agresor
          {" · act. "}{new Date(data.updatedAt).toLocaleTimeString("en-US", { hour12: false })}
        </span>
      </div>
    </div>
  );
}

const DECISION_LABEL: Record<VecinosSignal["decision"], { text: string; cls: string }> = {
  entrar: { text: "ENTRAR", cls: "go" },
  esperar_breakout: { text: "ESPERAR BREAKOUT", cls: "wait" },
  lateral: { text: "LATERAL — NO OPERAR", cls: "flat" },
};

function VecDecision({ data }: { data: VecinosResponse }) {
  const s = data.signal;
  const d = DECISION_LABEL[s.decision];
  const dirText = s.direction === "call" ? "▲ CALL" : s.direction === "put" ? "▼ PUT" : "— sin sesgo";
  const dirCls = s.direction === "call" ? "up" : s.direction === "put" ? "down" : "flat";
  return (
    <div className={`card vec-decision ${d.cls}`}>
      <div className="vec-dec-top">
        <div>
          <div className="z-card-title">Paso 6 — Decisión</div>
          <div className={`vec-dec-verdict ${d.cls}`}>{d.text}</div>
        </div>
        <div className={`vec-dec-dir ${dirCls}`}>{dirText}</div>
      </div>

      <p className="vec-dec-summary">{s.summary}</p>

      <div className="z-stats">
        <div><span>Imán del GEX</span><b>{s.magnet != null ? `$${px.format(s.magnet)}` : "—"}</b></div>
        <div><span>Strike del spot</span><b>{s.spotStrike != null ? `$${px.format(s.spotStrike)}` : "—"}</b></div>
        <div>
          <span>Régimen</span>
          <b className={s.regime === "positive" ? "up" : "down"}>
            {s.regime === "positive" ? "γ+ ancla" : "γ− amplifica"}
          </b>
        </div>
        <div>
          <span>Confirmaciones</span>
          <b>
            {s.confirmations.flow} con dinero real
            {s.confirmations.structural > 0 && ` · ${s.confirmations.structural} por posición`}
          </b>
        </div>
      </div>

      {s.sibling && (
        <div className={`vec-sibling ${s.sibling.effect}`}>
          🔗 {s.sibling.symbol} {s.sibling.effect === "confirma" ? "confirma" : s.sibling.effect === "contradice" ? "contradice" : "es neutral"}
          {s.sibling.factor !== 1 && ` · ×${s.sibling.factor}`}
        </div>
      )}

      {s.warnings.map((w) => (
        <div key={w} className="vec-warn">⚡ {w}</div>
      ))}
      {!data.flowAvailable && (
        <div className="vec-warn">⚡ MarketSnack no devolvió el Time &amp; Sales: la señal se apoyó solo en el posicionamiento.</div>
      )}
    </div>
  );
}

function VecTargets({
  title, hint, targets, empty,
}: { title: string; hint: string; targets: VecinoTarget[]; empty: string }) {
  return (
    <div className="card">
      <div className="z-card-title">{title}</div>
      <div className="vec-hint">{hint}</div>
      {targets.length === 0 ? (
        <div className="z-muted">{empty}</div>
      ) : (
        <div className="vec-targets">
          {targets.map((t) => {
            const pctText = `${Math.round(t.probability * 100)}%`;
            return (
              <div key={`${t.kind}-${t.strike}`} className={`vec-target ${t.kind}`}>
                <div className="vec-t-head">
                  <span className="vec-t-strike">
                    {t.kind === "iman" && <span title="Imán del GEX">🧲 </span>}
                    ${px.format(t.strike)}
                    <em>{signed(t.distancePct, 2)}%</em>
                  </span>
                  <span className="vec-t-prob">{pctText}</span>
                </div>
                <div className="vec-t-bar">
                  <span className="vec-t-fill" style={{ width: `${Math.round(t.probability * 100)}%` }} />
                </div>
                <div className="vec-t-note">
                  <span className={`vec-src ${t.source}`}>{SOURCE_LABEL[t.source]}</span> {t.note}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VecNeighborhood({ signal }: { signal: VecinosSignal }) {
  // Strikes altos arriba, como en una cadena de opciones real.
  const rows = useMemo(() => [...signal.neighbors].sort((a, b) => b.strike - a.strike), [signal.neighbors]);
  const maxBias = useMemo(
    () => rows.reduce((m, n) => (n.source === "flujo" ? Math.max(m, Math.abs(n.netBias)) : m), 0),
    [rows],
  );
  const spot = signal.spot;
  let spotAfter = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].strike <= spot) { spotAfter = i; break; }
  }

  return (
    <div className="card vec-hood">
      <div className="z-card-title">Paso 2 — Vecindario (10 strikes por lado)</div>
      <div className="vec-hint">
        Net premium real de hoy: <b>+</b> ejecutado al ASK (compra agresiva), <b>−</b> ejecutado al
        BID (venta). Los strikes sin dinero real caen al respaldo de posicionamiento (OI × gamma).
      </div>
      <div className="vec-hood-cols">
        <span>Strike</span><span>Calls</span><span>Puts</span><span>Sesgo neto</span>
        <span className="vec-col-read">Lectura</span>
      </div>
      <div className="vec-hood-rows">
        {rows.map((n, i) => {
          const node = <VecHoodRow key={n.strike} n={n} maxBias={maxBias} isMagnet={signal.magnet === n.strike} />;
          if (i === spotAfter) {
            return (
              <div key={`grp-${n.strike}`}>
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

function VecHoodRow({ n, maxBias, isMagnet }: { n: NeighborStrike; maxBias: number; isMagnet: boolean }) {
  const bull = n.netBias > 0;
  // La barra solo escala el dinero real; el posicionamiento no comparte unidades.
  const w = n.source === "flujo" && maxBias > 0 ? Math.min(100, (Math.abs(n.netBias) / maxBias) * 100) : 0;
  return (
    <div className={`vec-hrow ${n.source} ${isMagnet ? "magnet" : ""}`}>
      <span className="vec-hstrike">
        {px.format(n.strike)}
        {isMagnet && <span className="vec-magnet" title="Imán del GEX"> 🧲</span>}
      </span>
      <span className={`vec-hnet ${n.callNet > 0 ? "up" : n.callNet < 0 ? "down" : ""}`}>{netMoney(n.callNet)}</span>
      <span className={`vec-hnet ${n.putNet > 0 ? "down" : n.putNet < 0 ? "up" : ""}`}>{netMoney(n.putNet)}</span>
      <span className="vec-hbias">
        {n.source === "flujo" ? (
          <>
            <span className={`vec-hbar ${bull ? "up" : "down"}`} style={{ width: `${w}%` }} />
            <span className="vec-hbias-num">{bull ? "▲" : "▼"}</span>
          </>
        ) : n.source === "estructura" ? (
          <span
            className={`vec-hstruct ${bull ? "up" : "down"}`}
            title={bull ? "Predomina el OI de puts: soporte" : "Predomina el OI de calls: resistencia"}
          >
            {bull ? "▲ soporte" : "▼ resist."}
          </span>
        ) : (
          <span className="vec-hnone">·</span>
        )}
      </span>
      <span className="vec-hread">{n.reading}</span>
    </div>
  );
}

function VecHow() {
  return (
    <details className="card vec-how">
      <summary>¿Cómo se calcula esta señal?</summary>
      <ol>
        <li>
          <b>Dirección = imán del GEX.</b> Se calcula el GEX neto por strike (gamma REAL de la
          cadena × Open Interest, +call/−put) y se busca el de mayor concentración. Se compara
          contra el spot usando la <b>grilla real de strikes</b>, no un % fijo: mismo strike →
          lateral; arriba → CALL; abajo → PUT.
        </li>
        <li>
          <b>Vecindario.</b> 10 strikes por lado. Con el net premium real de hoy:
          compra de calls = alcista, compra de puts = bajista, venta de calls = resistencia,
          venta de puts = soporte. Se fusionan en un sesgo neto por strike.
        </li>
        <li>
          <b>Respaldo sin flujo.</b> Donde el dinero real dio cero, el strike se clasifica por
          posicionamiento (OI × gamma real) según <b>qué lado domina dentro del propio strike</b>:
          predominan calls → resistencia, predominan puts → soporte. Vale en los dos lados del
          precio, así que un muro de puts por encima del spot también confirma una subida. Solo
          cuenta como pared el <b>top 30%</b> del posicionamiento neto del vecindario; un strike
          con mucho OI en calls <i>y</i> en puts se cancela y se queda sin lectura. El flujo real
          siempre manda si existe.
        </li>
        <li>
          <b>Objetivos.</b> Hasta 3 strikes camino al imán que confirmen la dirección, más el
          imán como cuarto y último. Del lado contrario, hasta 4 strikes de ruptura.
        </li>
        <li>
          <b>Probabilidad.</b> Probabilidad estadística de toque (distancia + IV + horas al
          cierre) ajustada por la agresividad del flujo en ese strike. Ruptura ×0.65; objetivos
          hacia el imán en régimen γ− ×0.75. Nunca 0% ni 100% (3%–95%).
        </li>
        <li>
          <b>Decisión.</b> <i>Entrar</i> si al menos un strike confirmó hacia el imán;
          <i> esperar breakout</i> si hay dirección pero nadie la confirma todavía con dinero
          real; <i>lateral</i> si el imán está pegado al spot.
        </li>
      </ol>
      <p className="vec-how-note">
        La confirmación cruzada con el índice hermano (SPX para ES, NDX para NQ) está
        implementada pero <b>inactiva</b>: es para futuros, y el proveedor de datos no sirve
        futuros. Los cinco instrumentos de esta vista tienen flujo real propio.
      </p>
    </details>
  );
}
