"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { int, money, px } from "../format";
import ZeroDteChart from "./ZeroDteChart";
import type {
  ZeroDteResponse,
  ZeroDteEvalResponse,
  ZeroDteAnalysis,
  ZeroDteBias,
  ZeroDtePinning,
  ZeroDteScoreboard,
  ZeroDteStrike,
  ZeroDteTape,
  ZeroDteTicket,
  ZeroDteTradeCard,
  AggressorRead,
} from "./types";

// Vista 0DTE: cadena del día por volumen, muros, imán del GEX, señales tácticas
// (ticket + dos modelos de trade + sesgo a 5 min), cinta en vivo (CVD/velocidad/
// bloques), pinning de cierre, escenarios y auto-evaluación.
//
// La MAQUETACIÓN está alineada con la versión de referencia del grupo: una sola
// columna de secciones a ancho completo, cada una con su cabecera grande y su
// borde de estado, y la cadena como TABLA espejo. Todo cuelga de `.z-wrap`: el
// esqueleto `z-*` viejo sigue en globals.css (PredictionCard usa .z-tab/.z-tabs)
// y sin el scope estas reglas —que redefinen .z-head o .z-bar con otro sentido—
// se lo pisarían.
//
// NO es consejo financiero: los datos de la cadena y del flujo pueden venir
// retrasados.

const SYMBOLS = ["SPY", "QQQ", "IWM", "SPX"];
const REFRESH_MS = 60_000;
const LS_KEY = "tito.0dte.sym";

function signed(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

/** $8.3B / −$412M — el GEX se lee en órdenes de magnitud, no en dígitos. */
function bigMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function pctOrDash(n: number | null, digits = 0): string {
  return n == null ? "—" : `${n.toFixed(digits)}%`;
}

/** "lun 24" desde un YYYY-MM-DD. Se ancla a mediodía UTC para no perder un día. */
function dayLabel(date: string): string {
  try {
    return new Date(`${date}T12:00:00Z`).toLocaleDateString("es-ES", {
      weekday: "short", day: "numeric",
    });
  } catch {
    return date;
  }
}

export default function ZeroDtePage() {
  const [sym, setSym] = useState("SPY");
  const [exp, setExp] = useState(""); // "" = 0DTE del día; si no, YYYY-MM-DD elegido
  const [data, setData] = useState<ZeroDteResponse | null>(null);
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
      if (s && SYMBOLS.includes(s)) setSym(s);
    } catch { /* noop */ }
  }, []);

  // Modo oscuro fijo para esta vista (ver el porqué en 0dte/layout.tsx). El
  // script del layout cubre la carga completa; esto cubre las navegaciones desde
  // la barra lateral, donde ese script ya no vuelve a correr.
  //
  // Al salir se REPONE la preferencia global recalculándola (localStorage, y si
  // no, la del sistema), igual que hace el script anti-parpadeo de app/layout.
  // OJO: no vale con guardar el `data-theme` que había al montar — en la carga
  // completa el script del layout ya lo ha puesto en "dark" antes de que corra
  // este efecto, así que "lo que había" sería siempre "dark" y al salir la app
  // entera se quedaría oscura.
  //
  // Si el tema ya no es "dark" al desmontar es que el usuario le dio al toggle
  // estando aquí: esa elección es suya y no se toca. Tampoco se escribe nunca en
  // localStorage, así que la preferencia global queda intacta.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", "dark");
    return () => {
      if (root.getAttribute("data-theme") !== "dark") return;
      let global: string | null = null;
      try {
        global = window.localStorage.getItem("tito.theme");
      } catch { /* localStorage bloqueado: caemos a la preferencia del sistema */ }
      if (!global) {
        global = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      if (global === "dark") root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
    };
  }, []);

  // Una sola llamada por refresco: la cadena, el flujo, las señales y el marcador
  // vienen juntos porque el marcador apunta exactamente lo que se enseña.
  const load = useCallback(async (which: string, whichExp: string) => {
    setBusy(true);
    setError(null);
    try {
      const q = whichExp ? `&exp=${encodeURIComponent(whichExp)}` : "";
      const r = await fetch(`/api/0dte?ticker=${encodeURIComponent(which)}${q}`, { cache: "no-store" });
      const d = (await r.json()) as ZeroDteResponse & { error?: string };
      if (which !== symRef.current || whichExp !== expRef.current) return;
      if (!r.ok || d.error) { setError(d.error ?? "No se pudo cargar la cadena 0DTE."); setData(null); }
      else { setData(d); setUpdatedAt(new Date().toISOString()); }
    } catch {
      if (which === symRef.current) setError("Se cortó la conexión con el servidor.");
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

  useEffect(() => {
    setData(null); setEvalr(null);
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
    <main className="z-wrap">
      <header className="z-head">
        <div>
          <h1>Agente 0DTE</h1>
          <p>Vencimiento del día · los strikes de más volumen alrededor del precio</p>
        </div>
        <div className="z-controls">
          <select value={sym} onChange={(e) => pick(e.target.value)} aria-label="Instrumento">
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>{s === "SPX" ? "SPX (beta)" : s}</option>
            ))}
          </select>
          <button onClick={() => load(sym, exp)} disabled={busy}>
            {busy ? "Cargando…" : "Actualizar"}
          </button>
        </div>
      </header>

      {data && data.available.length > 1 && (
        <div className="z-daybar" role="group" aria-label="Vencimiento">
          <span className="z-daybar-lbl">Vencimiento</span>
          {data.available.map((e) => (
            <button
              key={e.date}
              className={`z-daychip ${e.date === data.expiration ? "z-daychip-on" : ""}`}
              onClick={() => setExp(e.dte === 0 ? "" : e.date)}
              title={e.date}
            >
              {e.dte === 0 ? "Hoy" : dayLabel(e.date)}
              <em>{e.dte} DTE</em>
            </button>
          ))}
        </div>
      )}

      {error && <div className="z-error">⚠ {error}</div>}
      {busy && !data && <p className="z-chart-msg">Cargando la cadena 0DTE de {sym}…</p>}

      {data && (
        <>
          <ZeroMeta data={data} updatedAt={updatedAt} />

          <ZeroTicket ticket={data.signals.ticket} note={data.signals.ticketNote} open={data.sessionOpen} />
          <ZeroTrade card={data.signals.trade} title="GEX Trade" sub="— vuelta al imán" open={data.sessionOpen} />
          <ZeroTrade card={data.signals.tradeAlt} title="GEX Trade" sub="· alterno" open={data.sessionOpen} alt />
          <ZeroBias bias={data.signals.bias} sub="— próximos 5 min" />
          <ZeroBias bias={data.signals.biasAlt} sub="— próximos 5 min · alterno" alt />
          <ZeroScoreboard score={data.score} open={data.sessionOpen} />

          <ZeroVolumeLive tape={data.tape} open={data.sessionOpen} />
          <ZeroTape tape={data.tape} open={data.sessionOpen} ticker={data.ticker} a={data.analysis} />

          <ZeroSummary a={data.analysis} />
          <ZeroGex a={data.analysis} />
          <ZeroPinning pin={data.signals.pinning} ticker={data.ticker} />
          <ZeroScenarios
            a={data.analysis}
            minutesLeft={data.minutesLeft}
            isToday={data.isToday}
            selectedDte={data.selectedDte}
          />

          <ZeroDteChart ticker={data.ticker} a={data.analysis} />
          <ZeroChain a={data.analysis} reads={data.flow.reads} />
          <ZeroAggressor reads={data.flow.reads} summary={data.flow.summary} />
          <ZeroEval evalr={evalr} />

          <p className="z-foot">
            ⚠ <b>No es consejo financiero.</b> Los datos de la cadena y del flujo pueden venir
            retrasados. El 0DTE es de altísimo riesgo: esto es contexto, no una recomendación de operar.
          </p>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Línea de contexto
// ---------------------------------------------------------------------------

function ZeroMeta({ data, updatedAt }: { data: ZeroDteResponse; updatedAt: string | null }) {
  const {
    spot, change, changePercent, expiration, isToday, selectedDte, spotSource,
    minutesLeft, contractCount, analysis, ticker,
  } = data;
  const dir = changePercent == null ? "" : changePercent > 0 ? "up" : changePercent < 0 ? "down" : "";
  const h = Math.floor(minutesLeft / 60), m = minutesLeft % 60;
  return (
    <div className="z-meta">
      <span><b>{ticker}</b></span>
      <span>
        Spot <b>{px.format(spot)}</b>
        {changePercent != null && (
          <> <b className={dir}>{change != null ? `${signed(change)} ` : ""}({signed(changePercent)}%)</b></>
        )}
      </span>
      <span>Vence <b>{expiration}</b> {isToday ? "(hoy · 0DTE)" : `(${selectedDte} DTE)`}</span>
      <span>{int.format(contractCount)} contratos en la cadena</span>
      {isToday && minutesLeft > 0 && <span>Cierre en <b>{h}h {m}m</b></span>}
      {updatedAt && (
        <span className="z-time">
          {new Date(updatedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET
        </span>
      )}
      <span className="z-fresh">
        ⚡ {int.format(analysis.gammaCoverage.strikes)} strikes con gamma real ({analysis.gammaCoverage.pct}%)
      </span>
      {spotSource === "paridad" && (
        <span className="z-flag" title="Massive no cotiza índices: el spot sale de la paridad put-call de la cadena.">
          spot ≈ paridad put-call
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GEX Ticket
// ---------------------------------------------------------------------------

function ZeroTicket({ ticket, note, open }: { ticket: ZeroDteTicket | null; note: string; open: boolean }) {
  const state = !ticket ? "z-ticket-idle" : ticket.type === "call" ? "z-ticket-long" : "z-ticket-short";
  return (
    <section className={`z-ticket ${state}`}>
      <header>
        <h2>GEX Ticket <span className="z-live-sub">— contrato sugerido</span></h2>
        {ticket && <span className="z-ticket-badge">{ticket.type === "call" ? "COMPRAR CALL" : "COMPRAR PUT"}</span>}
      </header>

      {!ticket ? (
        <p className="z-ticket-none">
          {open ? note : "Mercado cerrado — no hay contrato en vivo que sugerir."}
        </p>
      ) : (
        <>
          <div className="z-ticket-buy">
            <span className="z-ticket-act">COMPRAR</span>
            <span className="z-ticket-ctr">
              {ticket.type === "call" ? "CALL" : "PUT"} {px.format(ticket.strike)}
            </span>
            <span className="z-ticket-at">a</span>
            <span className="z-ticket-price">${ticket.mid.toFixed(2)}</span>
            <span className="z-ticket-quote">
              bid {ticket.bid != null ? ticket.bid.toFixed(2) : "—"} / ask {ticket.ask != null ? ticket.ask.toFixed(2) : "—"}
              {ticket.spreadPct != null && ` · horquilla ${ticket.spreadPct.toFixed(1)}%`}
            </span>
          </div>

          <div className="z-ticket-st">
            <div className="z-ticket-box">
              <span className="z-ticket-k">Coste por contrato</span>
              <span className="z-ticket-v">${ticket.cost.toFixed(0)}</span>
            </div>
            <div className="z-ticket-box">
              <span className="z-ticket-k">Si llega al objetivo</span>
              <span className="z-ticket-v z-ticket-tgt">{signed(ticket.targetGain, 0)} $</span>
            </div>
            <div className="z-ticket-box">
              <span className="z-ticket-k">Si salta el stop</span>
              <span className="z-ticket-v z-ticket-stp">{signed(ticket.stopLoss, 0)} $</span>
            </div>
          </div>

          <div className="z-ticket-meta">
            <span className="z-ticket-chip">delta <b>{ticket.delta != null ? ticket.delta.toFixed(2) : "—"}</b></span>
            <span className="z-ticket-chip">vol <b>{int.format(ticket.volume)}</b></span>
            <span className="z-ticket-chip">OI <b>{int.format(ticket.openInterest)}</b></span>
            <span className="z-ticket-chip">liquidez <b>{ticket.liquidity}</b></span>
            <span className="z-ticket-chip">{ticket.optionSymbol}</span>
          </div>

          <p className="z-ticket-foot">
            {ticket.rationale} El agente calcula y muestra; tú decides y ejecutas.{" "}
            <b>No es una orden ni un consejo.</b>
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// GEX Trade (original y alterno)
// ---------------------------------------------------------------------------

function ZeroTrade({
  card, title, sub, open, alt = false,
}: { card: ZeroDteTradeCard; title: string; sub: string; open: boolean; alt?: boolean }) {
  const t = card.trade;
  const state = !t ? "z-live-idle" : t.side === "LONG" ? "z-live-long" : "z-live-short";
  return (
    <section className={`z-live ${state}`}>
      <header>
        <h2>
          {title}{" "}
          <span className={alt ? "z-alt-suffix" : "z-live-sub"}>{sub}</span>
        </h2>
        {alt && <span className="z-live-momtag">MOMENTUM · γ−</span>}
        {!open && <span className="z-live-clock">mercado cerrado</span>}
      </header>

      {!t ? (
        <p className="z-live-msg">
          {open
            ? card.note
            : "Fuera de sesión (9:30-16:00 ET). Con el mercado abierto el agente busca la mejor entrada en vivo y la actualiza cada minuto."}
        </p>
      ) : (
        <>
          <div className={`z-live-dir ${t.side === "LONG" ? "z-dir-long" : "z-dir-short"}`}>
            {t.side === "LONG" ? "▲ LONG" : "▼ SHORT"}
          </div>
          <div className="z-live-row">
            <div><span className="z-ticket-k">Entrada (ahora)</span><b>{px.format(t.entry)}</b></div>
            <div><span className="z-ticket-k">Objetivo</span><b>{px.format(t.target)}</b></div>
            <div><span className="z-ticket-k">Stop</span><b>{px.format(t.stop)}</b></div>
            <div><span className="z-ticket-k">Riesgo / Beneficio</span><b>{t.rr.toFixed(1)} : 1</b></div>
          </div>
          <p className="z-live-reason">{t.rationale}</p>
        </>
      )}

      <p className="z-outlook-caveat">
        Se recalcula cada minuto con el GEX en vivo. El agente calcula y muestra; tú decides y
        ejecutas. No es una orden ni un consejo.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// GEX Bias — cono de 5 minutos
// ---------------------------------------------------------------------------

const DIR_LABEL: Record<ZeroDteBias["dir"], { icon: string; text: string; key: string }> = {
  up: { icon: "▲", text: "al alza", key: "alcista" },
  down: { icon: "▼", text: "a la baja", key: "bajista" },
  flat: { icon: "▬", text: "lateral", key: "lateral" },
};

function ZeroBias({ bias, sub, alt = false }: { bias: ZeroDteBias; sub: string; alt?: boolean }) {
  const d = DIR_LABEL[bias.dir];
  const span = bias.high - bias.low;
  const pos = span > 0 ? Math.max(0, Math.min(100, ((bias.spot - bias.low) / span) * 100)) : 50;
  return (
    <section className={`z-outlook z-lean-${d.key}`}>
      <div className="z-outlook-top">
        <span className="z-outlook-tag">
          GEX Bias <span className={alt ? "z-alt-suffix" : "z-live-sub"}>{sub}</span>
        </span>
        <span className={`z-lean-chip z-lean-chip-${d.key}`}>{d.icon} {d.text}</span>
        <span className="z-conf">confianza {bias.confidence}</span>
      </div>

      <p className="z-outlook-head">
        Ahora {px.format(bias.spot)} → en ~{bias.minutes} min, probablemente entre{" "}
        {px.format(bias.low)} y {px.format(bias.high)}
      </p>

      <div className="z-outlook-range">
        <span>{px.format(bias.low)}</span>
        <div className="z-range-bar">
          <i className="z-range-fill" />
          <b className="z-range-now" style={{ left: `${pos}%` }}>{px.format(bias.spot)}</b>
        </div>
        <span>{px.format(bias.high)}</span>
      </div>

      <p className="z-outlook-detail">{bias.note}</p>

      {bias.flowNote && (
        <div className="z-flow">
          <p className="z-flow-line"><span className="z-flow-tag">FLUJO</span> {bias.flowNote}</p>
        </div>
      )}

      <p className="z-outlook-caveat">
        Estimación probabilística desde el posicionamiento de opciones — el rango es ~68% (±1σ).
        No es una certeza ni un consejo de inversión.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Marcador alterno vs original
// ---------------------------------------------------------------------------

const TRADE_MODEL_LABEL: Record<string, string> = {
  magnet: "original · vuelta al imán",
  momentum: "alterno · momentum γ−",
};

function ZeroScoreboard({ score, open }: { score: ZeroDteScoreboard | null; open: boolean }) {
  if (!score) return null;
  const biasGraded = score.bias.reduce((s, b) => s + b.graded, 0);
  const tradesClosed = score.trades.reduce((s, t) => s + t.closed, 0);
  return (
    <div className="z-altcmp">
      <h3>Alterno vs original · marcador de hoy ({score.date})</h3>

      <h4>Sesgo a 5 minutos</h4>
      {biasGraded === 0 ? (
        <p className="z-altcmp-sub">
          {open
            ? "Recogiendo… cada llamada se califica 5 minutos después. Deja la página abierta durante la sesión."
            : "Sin llamadas calificadas hoy. Se apuntan solo con el mercado abierto."}
        </p>
      ) : (
        <table>
          <thead>
            <tr><th>Modelo</th><th>Calificadas</th><th>Acierto de rango</th><th>Acierto de dirección</th><th>Vivas</th></tr>
          </thead>
          <tbody>
            {score.bias.map((b) => (
              <tr key={b.model}>
                <td><b>{b.model}</b></td>
                <td>{int.format(b.graded)}</td>
                <td><b>{pctOrDash(b.rangePct)}</b> <em>{b.rangeHits}/{b.graded}</em></td>
                <td><b>{pctOrDash(b.dirPct)}</b> <em>{b.dirHits}/{b.graded}</em></td>
                <td>{int.format(b.open)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>GEX Trade</h4>
      {tradesClosed === 0 ? (
        <p className="z-altcmp-sub">
          {open
            ? "Midiendo en vivo — se rellena cuando los trades toquen su objetivo o su stop."
            : "Sin trades cerrados hoy."}
        </p>
      ) : (
        <table>
          <thead>
            <tr><th>Modelo</th><th>Cerrados</th><th>Aciertos</th><th>Fallos</th><th>Sin resolver</th><th>Win rate</th></tr>
          </thead>
          <tbody>
            {score.trades.map((t) => (
              <tr key={t.model}>
                <td><b>{TRADE_MODEL_LABEL[t.model] ?? t.model}</b></td>
                <td>{int.format(t.closed)}</td>
                <td className="up">{int.format(t.wins)}</td>
                <td className="down">{int.format(t.losses)}</td>
                <td>{int.format(t.flats)}</td>
                <td><b>{pctOrDash(t.winRate)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="z-altcmp-sub">
        El spot solo se conoce cuando la página consulta (cada minuto), así que un objetivo tocado y
        devuelto entre dos consultas no se ve. Mide lo que el agente pudo ver en vivo, no el tick perfecto.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Volumen en vivo: velocidad + CVD
// ---------------------------------------------------------------------------

function ZeroVolumeLive({ tape, open }: { tape: ZeroDteTape; open: boolean }) {
  const total = Math.max(1, tape.buy + tape.sell);
  const buyPct = (tape.buy / total) * 100;
  const chip = tape.pressure === "compradora" ? "z-vv-buy" : tape.pressure === "vendedora" ? "z-vv-sell" : "z-vv-flat";
  // El CVD se pinta a partir del centro: la mitad que se llena es la que domina.
  const cvdPct = Math.min(50, Math.abs(tape.weight) * 50);
  const cvdPos = tape.cvd >= 0;
  return (
    <section className="z-vv">
      <div className="z-vv-top">
        <span className="z-vv-tag">Volumen en vivo <span className="z-live-sub">— velocidad + CVD</span></span>
        <span className={`z-vv-chip ${chip}`}>
          {tape.pressure === "compradora" ? "▲ presión compradora"
            : tape.pressure === "vendedora" ? "▼ presión vendedora" : "▬ presión neutral"}
        </span>
        {!open && <span className="z-vv-clock">mercado cerrado</span>}
      </div>

      <div className="z-vv-grid">
        <div>
          <span className="z-vv-lbl">Velocidad</span>
          <div className="z-vv-big">
            {tape.velocity != null ? `${int.format(Math.round(tape.velocity))}/min` : "—"}
          </div>
          <div className="z-vv-sub">
            {tape.velocityLabel
              ? `${tape.velocityLabel} · media de la sesión ${tape.avgVelocity != null ? int.format(Math.round(tape.avgVelocity)) : "—"}/min`
              : open ? "midiendo… hacen falta 5 minutos de cinta" : "fuera de sesión, no hay ritmo que medir"}
          </div>
          <div className="z-vv-sub">
            <b>{int.format(tape.contracts)}</b> contratos hoy en {int.format(tape.trades)} tickets
          </div>
        </div>

        <div>
          <span className="z-vv-lbl">Agresor neto (CVD)</span>
          <div className={`z-vv-big ${cvdPos ? "up" : "down"}`}>{signed(tape.cvd, 0)}</div>
          <div className="z-vv-sub">
            {cvdPos ? "domina la compra al ask" : "domina la venta al bid"}
          </div>
          <div className="z-vv-div">
            <i className="z-vv-zero" />
            <i
              className="z-vv-fill"
              style={{
                left: cvdPos ? "50%" : `${50 - cvdPct}%`,
                width: `${cvdPct}%`,
                background: cvdPos ? "var(--green)" : "var(--red)",
              }}
            />
          </div>
          <div className="z-vv-ends">
            <span>venta {int.format(tape.sell)}</span>
            <span>compra {int.format(tape.buy)}</span>
          </div>
          <div className="z-vv-sub" style={{ marginTop: 6 }}>
            {buyPct.toFixed(0)}% del volumen agredido fue al ask
          </div>
        </div>
      </div>

      <p className="z-vv-verdict">
        El CVD cuenta <b>contratos</b> agredidos al ask menos los agredidos al bid. Los cruces en el
        mid no entran: no dicen quién tenía prisa. Las opciones de índice solo cotizan de 9:30 a 16:00 ET.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cinta: bloques entrantes
// ---------------------------------------------------------------------------

function ZeroTape({
  tape, open, ticker, a,
}: { tape: ZeroDteTape; open: boolean; ticker: string; a: ZeroDteAnalysis }) {
  return (
    <section className="z-tt">
      <div className="z-tt-head">
        <span className="z-tt-tag">0DTE en vivo <span className="z-live-sub">— top 10 entrantes</span></span>
        <span className="z-tt-inst">{ticker} · imán {a.magnet != null ? px.format(a.magnet) : "—"}</span>
        <span className="z-tt-takers">⚡ solo takers</span>
      </div>

      {tape.blocks.length === 0 ? (
        <p className="z-live-msg">
          {open
            ? "Esperando bloques que cumplan los filtros…"
            : "Fuera de sesión — sin flujo en vivo. Los bloques vuelven a las 9:30 ET."}
        </p>
      ) : (
        <div>
          {tape.blocks.map((b) => (
            <div key={b.id} className={`z-tt-row ${b.bullish ? "z-tt-bull" : "z-tt-bear"}`}>
              <span className={`z-tt-k ${b.type}`}>{b.type === "call" ? "CALL" : "PUT"} {px.format(b.strike)}</span>
              <span className="z-tt-side">{b.side}</span>
              <span className="z-tt-mean">{b.meaning}</span>
              <span className="z-tt-sz">{int.format(b.size)}×</span>
              <span className="z-tt-prem">{money.format(b.premium)}</span>
            </div>
          ))}
        </div>
      )}

      <p className="z-tt-disc">
        Solo entran los tickets que agredieron el bid o el ask (takers). Comprar call es direccional
        alcista, vender put es soporte, comprar put es cobertura y vender call es resistencia.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tiles de resumen
// ---------------------------------------------------------------------------

function ZeroSummary({ a }: { a: ZeroDteAnalysis }) {
  return (
    <div className="z-summary">
      <div className="z-sum-card z-sum-call">
        <span className="z-sum-lbl">Call de más volumen</span>
        <b>{a.topVolumeCall ? px.format(a.topVolumeCall.strike) : "—"}</b>
        <span className="z-sum-sub">
          {a.topVolumeCall ? `${int.format(a.topVolumeCall.volume)} contratos hoy` : "sin volumen"}
        </span>
      </div>
      <div className="z-sum-card z-sum-put">
        <span className="z-sum-lbl">Put de más volumen</span>
        <b>{a.topVolumePut ? px.format(a.topVolumePut.strike) : "—"}</b>
        <span className="z-sum-sub">
          {a.topVolumePut ? `${int.format(a.topVolumePut.volume)} contratos hoy` : "sin volumen"}
        </span>
      </div>
      <div className="z-sum-card">
        <span className="z-sum-lbl">Ratio put / call</span>
        <b>{a.putCall.ratio != null ? a.putCall.ratio.toFixed(2) : "—"}</b>
        <span className="z-sum-sub">{int.format(a.putCall.puts)} puts · {int.format(a.putCall.calls)} calls</span>
      </div>
      <div className="z-sum-card">
        <span className="z-sum-lbl">Rango 1σ</span>
        <b>{px.format(a.expectedRange.low)}</b>
        <span className="z-sum-sub">a {px.format(a.expectedRange.high)} · IV {(a.iv * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gamma del día
// ---------------------------------------------------------------------------

function ZeroGex({ a }: { a: ZeroDteAnalysis }) {
  const pos = a.regime === "positive";
  return (
    <section className={`z-gex ${pos ? "z-gex-positive" : "z-gex-negative"}`}>
      <header>
        <h2>Gamma de hoy (GEX)</h2>
        <span>
          {int.format(a.gammaCoverage.strikes)} strikes · gamma real en el {a.gammaCoverage.pct}% de los contratos
        </span>
      </header>
      <div className="z-gex-grid">
        <div>
          <span className="z-sum-lbl">GEX neto ($ por 1% de movimiento)</span>
          <b>{bigMoney(a.totalGex)}</b>
          <span className="z-sum-sub">{pos ? "positivo → el dealer amortigua" : "negativo → el dealer amplifica"}</span>
        </div>
        <div>
          <span className="z-sum-lbl">Régimen</span>
          <b>{pos ? "γ+ estabiliza" : "γ− amplifica"}</b>
          <span className="z-sum-sub">{pos ? "opera CONTRA el movimiento → rango" : "opera A FAVOR → tendencia"}</span>
        </div>
        <div>
          <span className="z-sum-lbl">Imán (más gamma)</span>
          <b>{a.magnet != null ? px.format(a.magnet) : "—"}</b>
          <span className="z-sum-sub">el strike que más ancla el precio</span>
        </div>
        <div>
          <span className="z-sum-lbl">Zona de flip</span>
          <b>{a.flipStrike != null ? px.format(a.flipStrike) : "—"}</b>
          <span className="z-sum-sub">cruzarla cambia el régimen</span>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// GEX Pinning
// ---------------------------------------------------------------------------

function ZeroPinning({ pin, ticker }: { pin: ZeroDtePinning; ticker: string }) {
  return (
    <section className={`z-close ${pin.inWindow ? "" : "z-close-pending"}`}>
      <div className="z-close-top">
        <span className="z-close-tag">GEX Pinning</span>
        <span className="z-close-min">
          {pin.inWindow
            ? "pronóstico en vigor (15:00-16:00 ET)"
            : pin.minutesToPin > 0
              ? `faltan ${pin.minutesToPin} min para las 15:00 ET`
              : "fuera de la ventana de pinning"}
        </span>
      </div>
      <div className="z-close-main">
        <div>
          <span className="z-sum-lbl">Strike de cierre más probable de {ticker}</span>
          <span className="z-close-strike">{pin.strike != null ? px.format(pin.strike) : "—"}</span>
        </div>
        <div>
          <span className="z-sum-lbl">GEX neto · fuerza del pin</span>
          <span className={`z-close-netgex ${pin.regime === "positive" ? "up" : "down"}`}>
            {bigMoney(pin.strength)}
          </span>
          <span className="z-sum-sub">
            {pin.candidate != null ? `candidato actual ${px.format(pin.candidate)}` : "sin candidato"}
          </span>
        </div>
      </div>
      <p className="z-close-note">{pin.note}</p>
      <p className="z-outlook-caveat">
        Estimación del efecto de anclaje de los dealers, no una certeza. Una noticia o un cambio de
        régimen lo rompen. Tú decides.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Escenarios de cierre
// ---------------------------------------------------------------------------

function ZeroScenarios({
  a, minutesLeft, isToday, selectedDte,
}: { a: ZeroDteAnalysis; minutesLeft: number; isToday: boolean; selectedDte: number }) {
  const rows = [a.scenarios.bull, a.scenarios.base, a.scenarios.bear];
  const sigmaPts = a.spot * (a.expectedRange.sigmaPct / 100);
  // El horizonte del cono NO siempre es "lo que queda de hoy": con un vencimiento
  // futuro seleccionado son días enteros, y rotular "0.0 h" ahí sería falso.
  const horizon = isToday
    ? minutesLeft > 0 ? `${(minutesLeft / 60).toFixed(1)} h de sesión` : "sesión cerrada"
    : `${selectedDte} DTE al vencimiento`;
  return (
    <section className="z-fc">
      <header>
        <h2>Escenarios hasta el cierre</h2>
        <span>
          {horizon} · IV {(a.iv * 100).toFixed(1)}% · 1σ = ±{sigmaPts.toFixed(2)} pts ({a.expectedRange.sigmaPct.toFixed(2)}%)
        </span>
      </header>
      {isToday && minutesLeft === 0 && (
        <div className="z-fc-caveat">Sesión cerrada: el vencimiento de hoy ya expiró.</div>
      )}
      <div className="z-fc-grid">
        {rows.map((s) => (
          <div key={s.kind} className={`z-fc-card z-fc-${s.kind}`}>
            <span className="z-sum-lbl">
              {s.kind === "bull" ? "▲ Alcista" : s.kind === "bear" ? "▼ Bajista" : "● Base"}
            </span>
            <b>{px.format(s.target)}</b>
            <span className="z-fc-pct">{signed(s.changePct, 2)}%</span>
            <div className="z-fc-prob">
              <i style={{ width: `${Math.round(s.touchProb * 100)}%` }} />
              <span>{Math.round(s.touchProb * 100)}% de tocarlo antes del cierre</span>
            </div>
            <p>
              {s.driver}
              {s.attractionStrike != null && s.attractionContracts > 0 && (
                <> · Zona de atracción {px.format(s.attractionStrike)} con {int.format(s.attractionContracts)} contratos abiertos.</>
              )}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cadena (tabla espejo)
// ---------------------------------------------------------------------------

function ZeroChain({ a, reads }: { a: ZeroDteAnalysis; reads: AggressorRead[] }) {
  // Orden descendente (strikes altos arriba). La banda del spot se inserta entre
  // los dos strikes que lo encierran.
  const rows = useMemo(() => [...a.strikes].sort((x, y) => y.strike - x.strike), [a.strikes]);
  const byRead = useMemo(() => {
    const m = new Map<string, AggressorRead>();
    for (const r of reads) m.set(r.key, r);
    return m;
  }, [reads]);
  const maxVol = Math.max(1, a.maxVolume);
  const spot = a.spot;
  const spotAfter = rows.findIndex((r) => r.strike <= spot);

  return (
    <div className="z-chart-card">
      <div className="z-chart-head">
        Cadena por volumen · muros · imán
        <span className="z-sum-sub"> — agresor acumulado sobre {int.format(reads.length)} contratos con flujo</span>
      </div>
      <div className="z-chain-wrap">
        <table className="z-chain">
          <thead>
            <tr className="z-side">
              <th className="z-call" colSpan={4}>C A L L S</th>
              <th />
              <th className="z-put" colSpan={4}>P U T S</th>
            </tr>
            <tr>
              <th>Agresor</th><th>Vol</th><th>OI</th><th>Δ</th>
              <th className="z-mid">Strike</th>
              <th>Δ</th><th>OI</th><th>Vol</th><th>Agresor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <ZeroChainRow
                key={s.strike}
                s={s}
                maxVol={maxVol}
                spot={spot}
                showSpotBandBefore={i === spotAfter}
                callRead={byRead.get(`call:${s.strike}`) ?? null}
                putRead={byRead.get(`put:${s.strike}`) ?? null}
                isMagnet={a.magnet === s.strike}
                isVolCall={a.topVolumeCall?.strike === s.strike}
                isVolPut={a.topVolumePut?.strike === s.strike}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="z-chart-legend">
        El volumen dice DÓNDE está la actividad; el agresor, de qué lado. Fila amarilla = strike de
        más volumen del día · 🧲 = imán del GEX · fondo azulado = contrato ITM.
      </p>
    </div>
  );
}

/** Celda de agresor: lado dominante, su % y cuántos tickets lo respaldan. */
function AggCell({ read }: { read: AggressorRead | null }) {
  if (!read) return <td className="z-aggr">·</td>;
  if (read.side === "mixto") {
    return <td className="z-aggr z-aggr-mixto" title={`Flujo repartido · ${read.trades} tickets`}>≈ mixto</td>;
  }
  const buy = read.side === "compra";
  return (
    <td
      className={`z-aggr ${buy ? "z-aggr-compra" : "z-aggr-venta"}`}
      title={`${read.meaning} · ${money.format(read.premium)}`}
    >
      {buy ? "▲" : "▼"} <b>{read.side} {read.pct}%</b>
      <small>{read.trades}</small>
    </td>
  );
}

function ZeroChainRow(props: {
  s: ZeroDteStrike;
  maxVol: number;
  spot: number;
  showSpotBandBefore: boolean;
  callRead: AggressorRead | null;
  putRead: AggressorRead | null;
  isMagnet: boolean; isVolCall: boolean; isVolPut: boolean;
}) {
  const { s, maxVol, spot, showSpotBandBefore, callRead, putRead, isMagnet, isVolCall, isVolPut } = props;
  const cw = `${Math.min(100, (s.callVolume / maxVol) * 100)}%`;
  const pw = `${Math.min(100, (s.putVolume / maxVol) * 100)}%`;
  const cls = [isVolCall || isVolPut ? "z-toprow" : "", isMagnet ? "z-magnetrow" : ""].filter(Boolean).join(" ");

  const row = (
    <tr className={cls}>
      <AggCell read={callRead} />
      <td className={`z-vol ${isVolCall ? "z-top z-top-call" : ""} ${s.itm === "call" ? "z-itm" : ""}`}>
        {isVolCall && <i className="z-tag">MAX CALL</i>}
        <span>{s.callVolume > 0 ? int.format(s.callVolume) : "·"}</span>
        <i className="z-bar z-bar-call" style={{ width: cw }} />
      </td>
      <td className={s.itm === "call" ? "z-itm" : ""}>
        {(s.call?.openInterest ?? 0) > 0 ? int.format(s.call!.openInterest) : "·"}
      </td>
      <td className={s.itm === "call" ? "z-itm" : ""}>
        {s.call?.delta != null ? s.call.delta.toFixed(2) : "·"}
      </td>

      <td className={`z-mid ${isMagnet ? "z-magnet" : ""}`}>
        {isMagnet && <i className="z-magnet-tag" title="Imán del GEX">🧲</i>}
        {px.format(s.strike)}
      </td>

      <td className={s.itm === "put" ? "z-itm" : ""}>
        {s.put?.delta != null ? s.put.delta.toFixed(2) : "·"}
      </td>
      <td className={s.itm === "put" ? "z-itm" : ""}>
        {(s.put?.openInterest ?? 0) > 0 ? int.format(s.put!.openInterest) : "·"}
      </td>
      <td className={`z-vol ${isVolPut ? "z-top z-top-put" : ""} ${s.itm === "put" ? "z-itm" : ""}`}>
        {isVolPut && <i className="z-tag">MAX PUT</i>}
        <span>{s.putVolume > 0 ? int.format(s.putVolume) : "·"}</span>
        <i className="z-bar z-bar-put" style={{ width: pw }} />
      </td>
      <AggCell read={putRead} />
    </tr>
  );

  if (!showSpotBandBefore) return row;
  return (
    <>
      <tr>
        <td className="z-spotband" colSpan={9}>
          <span className="z-spot-flag">precio actual</span>
          <b>{px.format(spot)}</b>
          <span className="z-spot-hint">cae entre strikes — no es un contrato, así que no tiene volumen ni OI</span>
        </td>
      </tr>
      {row}
    </>
  );
}

// ---------------------------------------------------------------------------
// Agresor por prima + precisión del modelo
// ---------------------------------------------------------------------------

function ZeroAggressor({
  reads, summary,
}: { reads: AggressorRead[]; summary: { bullish: number; bearish: number } }) {
  const total = summary.bullish + summary.bearish;
  const bullPct = total > 0 ? Math.round((summary.bullish / total) * 100) : null;
  return (
    <section className="z-tt">
      <div className="z-tt-head">
        <span className="z-tt-tag">Agresor por prima <span className="z-live-sub">— flujo de hoy</span></span>
        {bullPct != null && (
          <span className={`z-vv-chip ${bullPct >= 55 ? "z-vv-buy" : bullPct <= 45 ? "z-vv-sell" : "z-vv-flat"}`}>
            {bullPct}% presión alcista · {money.format(total)}
          </span>
        )}
      </div>
      {reads.length === 0 ? (
        <p className="z-live-msg">Sin flujo notable en el 0DTE todavía.</p>
      ) : (
        <div>
          {reads.slice(0, 10).map((r) => {
            const isBull = (r.type === "call" && r.side === "compra") || (r.type === "put" && r.side === "venta");
            const cls = r.side === "mixto" ? "" : isBull ? "z-tt-bull" : "z-tt-bear";
            return (
              <div key={r.key} className={`z-tt-row ${cls}`}>
                <span className={`z-tt-k ${r.type}`}>{r.type === "call" ? "CALL" : "PUT"} {px.format(r.strike)}</span>
                <span className="z-tt-side">{r.side}{r.side !== "mixto" ? ` ${r.pct}%` : ""}</span>
                <span className="z-tt-mean">{r.meaning || "sin sesgo claro"}</span>
                <span className="z-tt-sz">{r.trades}×</span>
                <span className="z-tt-prem">{money.format(r.premium)}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="z-tt-disc">
        El agresor se acumula desde que arrancó la sesión, así que gana fiabilidad conforme avanza el
        día. El número pequeño es cuántos tickets respaldan el porcentaje: desconfía de los que tienen pocos.
      </p>
    </section>
  );
}

function ZeroEval({ evalr }: { evalr: ZeroDteEvalResponse | null }) {
  if (!evalr) return null;
  const rv = evalr.review;
  return (
    <section className="z-eval">
      <header>
        <h2>Precisión del modelo</h2>
        <span>memoria del 0DTE · {evalr.snapshots} pronósticos guardados</span>
      </header>
      {!rv || rv.maturedCount === 0 ? (
        <p className="z-eval-wait">
          Aún no hay pronósticos vencidos. El modelo guarda el pronóstico de hoy y lo contrasta con el
          cierre real; la primera medición aparece mañana y la fiabilidad crece con los días.
        </p>
      ) : (
        <div className="z-eval-grid">
          <div><span className="z-sum-lbl">Cierres evaluados</span><b>{rv.maturedCount}</b></div>
          <div>
            <span className="z-sum-lbl">Acierto de dirección</span>
            <b>{rv.directionHitRate != null ? `${rv.directionHitRate.toFixed(0)}%` : "—"}</b>
          </div>
          <div>
            <span className="z-sum-lbl">Error medio (base)</span>
            <b>{rv.meanAbsErrorPct != null ? `${rv.meanAbsErrorPct.toFixed(2)}%` : "—"}</b>
          </div>
          <div>
            <span className="z-sum-lbl">Sesgo</span>
            <b>{rv.biasPct != null ? `${signed(rv.biasPct)}%` : "—"}</b>
          </div>
        </div>
      )}
    </section>
  );
}
