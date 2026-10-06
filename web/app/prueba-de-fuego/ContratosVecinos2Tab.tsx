"use client";

// "Contratos vecinos 2.0" — combina el imán del GEX (griegos reales de
// tastytrade, lib/zerodte.ts → zeroDteGex) con el net premium real de
// MarketSnack en un vecindario de 10 strikes por lado (lib/magnetWall.ts →
// magnetWallSignal). Pedido explícito (ago 2026): dirección desde
// el imán, 4 targets con probabilidad hacia él (3 strikes vecinos + el imán),
// más 4 targets de ruptura en contra, y libertad de decir "no operar" en
// mercado lateral o sin confirmación real.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { ZeroDteGex } from "@/lib/pdf/zerodte";
import type { MagnetLevel, MagnetTarget, MagnetWallSignal } from "@/lib/pdf/magnetWall";
import type { WallTarget } from "@/lib/pdf/neighborContracts";
import { ZERO_DTE_TICKERS, DEFAULT_ZERO_DTE_TICKER, type ZeroDteTickerId } from "@/lib/pdf/zerodteTickers";
import type { GexChainLine } from "./types";

const REFRESH_MS = 60 * 1000;
const KEY_TICKER = "visionary.contratosVecinos2.ticker";

interface BestEntry {
  type: "call" | "put";
  resistance: WallTarget | null;
  support: WallTarget | null;
  target1: WallTarget | null;
  target2: WallTarget | null;
  reason: string;
  /** "flow" = net premium real de MarketSnack (SPX/SPY/QQQ); "positioning" = Open Interest × gamma real de tastytrade, sin flujo (ES/NQ, CME). */
  source: "flow" | "positioning";
  target1Probability: number | null;
  target2Probability: number | null;
  resistanceProbability: number | null;
  supportProbability: number | null;
}

interface MagnetWallResult {
  ticker: string;
  asOf: string;
  spot: number;
  iv: number;
  hoursToClose: number;
  marketOpen: boolean;
  delayed: boolean;
  gex: ZeroDteGex;
  signal: MagnetWallSignal | null;
  chainLines: GexChainLine[];
  bestEntry: BestEntry | null;
}

const dec = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const nf = new Intl.NumberFormat("en-US");
const num = (v: number | null | undefined) => (v == null ? "—" : nf.format(v));
const money0 = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const etTime = () =>
  new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

export default function ContratosVecinos2Tab() {
  const [data, setData] = useState<MagnetWallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selTicker, setSelTicker] = useState<ZeroDteTickerId>(DEFAULT_ZERO_DTE_TICKER);
  const [tickerReady, setTickerReady] = useState(false);
  // Guarda de pedido en vuelo: si el usuario cambia de ticker mientras un
  // fetch viejo sigue en camino, esa respuesta vieja puede llegar DESPUÉS de
  // la nueva (orden de red no garantizado) y pisar los datos correctos con
  // los de otro ticker — pasó de verdad en pruebas (mostraba SPX mientras
  // decía "/NQ"). Solo se aplica la respuesta si sigue siendo la más reciente pedida.
  const requestedTickerRef = useRef<ZeroDteTickerId | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY_TICKER);
    if (saved && ZERO_DTE_TICKERS.some((t) => t.id === saved)) setSelTicker(saved as ZeroDteTickerId);
    setTickerReady(true);
  }, []);

  const pickTicker = useCallback((id: ZeroDteTickerId) => {
    setSelTicker(id);
    window.localStorage.setItem(KEY_TICKER, id);
  }, []);

  const load = useCallback(async (ticker: ZeroDteTickerId) => {
    requestedTickerRef.current = ticker;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pdf/magnet-wall?ticker=${ticker}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (requestedTickerRef.current !== ticker) return; // ya se pidió otro ticker después — descartar
      setData(json as MagnetWallResult);
      setLastUpdated(new Date());
    } catch (e) {
      if (requestedTickerRef.current !== ticker) return;
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      if (requestedTickerRef.current === ticker) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!tickerReady) return; // espera a que se restaure el ticker guardado antes del primer fetch
    load(selTicker);
    const id = setInterval(() => load(selTicker), REFRESH_MS);
    return () => clearInterval(id);
  }, [tickerReady, selTicker, load]);

  const signal = data?.signal ?? null;
  // Con 0 horas al cierre, probTouch no tiene margen de tiempo para proyectar
  // — daría 0% real (redondeado al piso de 3%) que parece un dato pero es un
  // artefacto matemático de "sin tiempo", no una conclusión real sobre el
  // trade. El 0DTE de hoy además ya venció. Se oculta el veredicto/targets en
  // vez de mostrar probabilidades falsas.
  const hasTimeLeft = (data?.hoursToClose ?? 0) > 0;

  return (
    <div className="mw-wrap">
      <style>{CSS}</style>

      <header className="mw-head">
        <div>
          <h1>Contratos vecinos 2.0</h1>
          <p>Imán del GEX (tastytrade, griegos reales) + net premium real de MarketSnack — 10 strikes por lado.</p>
        </div>
        <div className="mw-controls">
          <select
            value={selTicker}
            onChange={(e) => pickTicker(e.target.value as ZeroDteTickerId)}
            aria-label="Ticker"
          >
            {ZERO_DTE_TICKERS.map((t) => (
              <option key={t.id} value={t.id}>
                {/* Acá ES/NQ son datos REALES del futuro (CME), no el alias
                    "vía SPX/NDX" de Agente ODTE — se sobreescribe el sublabel. */}
                {t.label}{t.id === "ES" || t.id === "NQ" ? " (futuro real, CME)" : t.sublabel ? ` (${t.sublabel})` : ""}
              </option>
            ))}
          </select>
          <span className={`mw-mkt ${data?.marketOpen ? "mw-mkt-on" : "mw-mkt-off"}`}>
            {data?.marketOpen ? "🟢 mercado abierto" : "🔴 mercado cerrado"}
          </span>
          {lastUpdated && <span className="mw-updated">actualizado {etTime()} ET</span>}
          <button onClick={() => load(selTicker)} disabled={loading}>
            {loading ? "Cargando…" : "🔄 Actualizar"}
          </button>
        </div>
      </header>

      {(selTicker === "ES" || selTicker === "NQ") && (
        <p className="mw-futures-note">
          🌙 /{selTicker} usa el contrato de futuro real (CME, casi 24/5) y su propia cadena de opciones
          diarias — sigue actualizándose aunque el mercado de acciones esté cerrado. MarketSnack no cubre
          CME, así que acá no hay confirmación de net premium: la dirección sale solo del imán del GEX.
        </p>
      )}

      {error && <div className="mw-error">⚠ {error}</div>}

      {data && (
        <div className="mw-meta">
          <span><b>{data.ticker}</b> 0DTE</span>
          <span>Spot <b>{dec(data.spot)}</b></span>
          <span>IV ATM <b>{(data.iv * 100).toFixed(1)}%</b></span>
          <span>Quedan <b>{data.hoursToClose.toFixed(1)}h</b> al cierre</span>
          {!data.delayed && <span className="mw-fresh">⚡ griegos reales de tastytrade</span>}
        </div>
      )}

      {data && (
        <GexChainTable chainLines={data.chainLines} gex={data.gex} spot={data.spot} signal={data.signal} />
      )}

      {data && !hasTimeLeft && (
        <section className="mw-advice mw-advice-lateral">
          <span className="mw-advice-tag">🔒 MERCADO CERRADO</span>
          <p>
            El 0DTE de hoy ya venció (0 horas al cierre) — sin tiempo restante no hay proyección de
            probabilidad válida (saldría 0% real, no un dato útil). El mapa del GEX de arriba sigue siendo
            informativo. Volvé a abrir cuando el mercado esté en sesión para ver la dirección y los targets
            con probabilidad real.
          </p>
        </section>
      )}

      {signal && hasTimeLeft && <DirectionCallout signal={signal} />}

      {signal && hasTimeLeft && signal.advice !== "lateral" && (
        <div className="mw-cols">
          <TargetsBox
            title="Camino hacia el imán"
            hint="Targets confirmados por net premium real, en orden desde el spot hasta el imán."
            targets={signal.towardTargets}
            tone={signal.type === "call" ? "call" : "put"}
          />
          <TargetsBox
            title="Vigilar ruptura (en contra del imán)"
            hint="Si el precio rompe hacia acá, invalida la tesis del imán — entrada al lado contrario."
            targets={signal.breakoutTargets}
            tone={signal.type === "call" ? "put" : "call"}
            muted
          />
        </div>
      )}

      {data && hasTimeLeft && <BestEntryBox bestEntry={data.bestEntry} spot={data.spot} />}

      <p className="mw-foot">
        Se actualiza sola cada minuto. Dinero simulado — no es consejo financiero. La probabilidad de
        toque combina el movimiento esperado estadístico (IV + tiempo al cierre) con la agresividad real
        del net premium en ese strike; los targets de ruptura llevan un castigo adicional por ir contra
        el régimen que ancla el GEX. Nunca se muestra 0% ni 100%.
      </p>
    </div>
  );
}

function DirectionCallout({ signal }: { signal: MagnetWallSignal }) {
  if (signal.advice === "lateral") {
    return (
      <section className="mw-advice mw-advice-lateral">
        <span className="mw-advice-tag">🟡 NO OPERAR — MERCADO LATERAL</span>
        <p>{signal.reason}</p>
      </section>
    );
  }

  const dirLabel = signal.type === "call" ? "🟢 CALL" : "🔴 PUT";
  return (
    <section className={`mw-advice ${signal.advice === "entrar" ? "mw-advice-go" : "mw-advice-wait"}`}>
      <div className="mw-advice-top">
        <span className="mw-advice-dir">{dirLabel}</span>
        <span className="mw-advice-magnet">
          Imán <b>${signal.magnetStrike}</b> · {pct(signal.magnetProbability)} prob. de tocarlo
        </span>
        {signal.advice === "esperar_breakout" && (
          <span className="mw-advice-tag mw-advice-tag-wait">⏳ ESPERAR — SIN CONFIRMACIÓN</span>
        )}
        {signal.regime === "negative" && (
          <span className="mw-advice-tag mw-advice-tag-wait" title="Gamma negativa: los dealers amplifican en vez de anclar — la tesis del imán es menos fiable acá.">
            ⚠ γ NEGATIVA
          </span>
        )}
      </div>
      <p>{signal.reason}</p>
    </section>
  );
}

function TargetsBox({
  title, hint, targets, tone, muted,
}: {
  title: string;
  hint: string;
  targets: MagnetTarget[];
  tone: "call" | "put";
  muted?: boolean;
}) {
  return (
    <section className={`mw-box ${muted ? "mw-box-muted" : ""}`}>
      <header>
        <h2>{title}</h2>
        <span className="mw-box-hint">{hint}</span>
      </header>
      {targets.length === 0 ? (
        <p className="mw-box-empty">Sin targets confirmados por ahora.</p>
      ) : (
        <ul className="mw-targets">
          {targets.map((t) => (
            <li key={t.strike} className={`mw-target mw-target-${tone}`}>
              <div className="mw-target-top">
                <b>${t.strike}</b>
                <span className="mw-target-prob">{pct(t.probability)}</span>
              </div>
              <div className="mw-target-bar"><i style={{ width: pct(t.probability) }} /></div>
              <p>{t.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "Mejor entrada" — pedido explícito (ago 2026): un segundo
 * veredicto, independiente del imán del GEX ("porque a veces el imán se
 * mueve"), sobre la MISMA pared de dinero que ya usa "SPX vecinos"
 * (`wallEntrySignal` en `lib/neighborContracts.ts`, walk de dominancia local
 * por magnitud de net premium) — con probabilidad de toque agregada. Vive acá
 * a propósito, al lado del panel del imán, para poder comparar las dos
 * lecturas de un vistazo (ninguna pisa a la otra).
 *
 * En ES/NQ (pedido explícito, ago 2026: "puedes usar tastytrade y
 * darme la mejor entrada") `bestEntry.source` viene `"positioning"` — misma
 * geometría, pero Open Interest × gamma real de tastytrade en vez de net
 * premium ejecutado (MarketSnack no cubre CME) — se avisa explícito en vez de
 * mezclarlo con la lectura de flujo real de SPX/SPY/QQQ.
 */
function BestEntryBox({ bestEntry, spot }: { bestEntry: BestEntry | null; spot: number }) {
  return (
    <section className="mw-entry">
      <header>
        <h2>Mejor entrada</h2>
        <span className="mw-entry-hint">
          Pared de dinero más fuerte del vecindario — independiente del imán, no se mueve si el imán se corre.
        </span>
      </header>

      {!bestEntry ? (
        <p className="mw-entry-empty">Sin pared clara ahora mismo — no hay desbalance real confirmado.</p>
      ) : (
        <>
          <div className={`mw-entry-head mw-entry-head-${bestEntry.type}`}>
            {bestEntry.type === "call" ? "🟢 COMPRÁ CALL" : "🔴 COMPRÁ PUT"}
            {bestEntry.source === "positioning" && (
              <span className="mw-entry-source" title="Sin flujo real de MarketSnack en CME — pared de Open Interest × gamma real de tastytrade, no compra/venta ejecutada.">
                📐 posicionamiento (OI × gamma), sin flujo
              </span>
            )}
          </div>

          <div className="mw-entry-grid">
            <div className="mw-entry-stat">
              <div className="mw-entry-stat-label">Precio del activo</div>
              <div className="mw-entry-stat-value">${dec(spot)}</div>
            </div>
            <div className="mw-entry-stat">
              <div className="mw-entry-stat-label">Resistencia (techo)</div>
              <div className="mw-entry-stat-value">{bestEntry.resistance ? `$${bestEntry.resistance.strike}` : "—"}</div>
              {bestEntry.resistance && <div className="mw-entry-stat-sub">{money0(bestEntry.resistance.netPremium)}</div>}
              {bestEntry.resistanceProbability != null && (
                <div className="mw-entry-prob">{pct(bestEntry.resistanceProbability)} de tocarlo</div>
              )}
            </div>
            <div className="mw-entry-stat">
              <div className="mw-entry-stat-label">Soporte (piso)</div>
              <div className="mw-entry-stat-value">{bestEntry.support ? `$${bestEntry.support.strike}` : "—"}</div>
              {bestEntry.support && <div className="mw-entry-stat-sub">{money0(bestEntry.support.netPremium)}</div>}
              {bestEntry.supportProbability != null && (
                <div className="mw-entry-prob">{pct(bestEntry.supportProbability)} de tocarlo</div>
              )}
            </div>
          </div>

          <div className="mw-entry-grid">
            <div className="mw-entry-stat">
              <div className="mw-entry-stat-label">Target 1</div>
              <div className="mw-entry-stat-value">{bestEntry.target1 ? `$${bestEntry.target1.strike}` : "—"}</div>
              {bestEntry.target1 && <div className="mw-entry-stat-sub">{money0(bestEntry.target1.netPremium)}</div>}
              {bestEntry.target1Probability != null && (
                <div className="mw-entry-prob">{pct(bestEntry.target1Probability)} de tocarlo</div>
              )}
            </div>
            <div className="mw-entry-stat">
              <div className="mw-entry-stat-label">Target 2</div>
              <div className="mw-entry-stat-value">{bestEntry.target2 ? `$${bestEntry.target2.strike}` : "—"}</div>
              {bestEntry.target2 && <div className="mw-entry-stat-sub">{money0(bestEntry.target2.netPremium)}</div>}
              {bestEntry.target2Probability != null && (
                <div className="mw-entry-prob">{pct(bestEntry.target2Probability)} de tocarlo</div>
              )}
            </div>
          </div>

          <p className="mw-entry-reason">{bestEntry.reason}</p>
        </>
      )}
    </section>
  );
}

type KeyLevelTone = "resistance" | "support" | "bullish" | "bearish";

/**
 * Etiqueta de soporte/resistencia CLAVE para un strike — solo para los que el
 * propio signal ya confirmó (targets hacia el imán o de ruptura). `dir` es la
 * MISMA dirección que usó `reasonFor` (lib/magnetWall.ts) para ese target en
 * particular: la dirección del imán para "hacia el imán", la contraria para
 * "ruptura" — importa porque un strike real puede tener resistencia de calls
 * Y soporte de puts a la vez (ambos con OI real), y hay que mostrar el lado
 * que de verdad confirmó ESE target, no adivinar por prioridad fija.
 */
function keyLevelTag(lvl: MagnetLevel | undefined, dir: "call" | "put"): { label: string; tone: KeyLevelTone } | null {
  if (!lvl) return null;
  if (dir === "call") {
    if (lvl.callSignal === "bullish") return { label: "COMPRA CALLS", tone: "bullish" };
    if (lvl.putSignal === "support") return { label: "SOPORTE", tone: "support" };
  } else {
    if (lvl.putSignal === "bearish") return { label: "COMPRA PUTS", tone: "bearish" };
    if (lvl.callSignal === "resistance") return { label: "RESISTENCIA", tone: "resistance" };
  }
  return null;
}

/** Mapa del GEX estilo option-chain (calls | strike | puts) — pedido explícito, mismo formato que la tabla de Agente ODTE, con los soportes/resistencias clave marcados. */
function GexChainTable({
  chainLines, gex, spot, signal,
}: {
  chainLines: GexChainLine[];
  gex: ZeroDteGex;
  spot: number;
  signal: MagnetWallSignal | null;
}) {
  if (chainLines.length === 0) {
    return <div className="mw-gexmap-empty">Sin datos de GEX todavía.</div>;
  }

  // Strike → dirección relevante para ese target (imán para "hacia el imán",
  // la contraria para "ruptura") — ver keyLevelTag.
  const keyStrikeDir = new Map<number, "call" | "put">();
  if (signal?.type) {
    const counterDirection: "call" | "put" = signal.type === "call" ? "put" : "call";
    for (const t of signal.towardTargets) keyStrikeDir.set(t.strike, signal.type);
    for (const t of signal.breakoutTargets) keyStrikeDir.set(t.strike, counterDirection);
  }
  const levelByStrike = new Map((signal?.levels ?? []).map((l) => [l.strike, l] as const));

  const maxVol = Math.max(1, ...chainLines.flatMap((l) => [l.call?.volume ?? 0, l.put?.volume ?? 0]));
  const spotIndex = chainLines.findIndex((l) => l.strike < spot);

  return (
    <section className="mw-gexmap">
      <header>
        <h2>Mapa del GEX (0DTE)</h2>
        <span>
          {gex.regime === "positive" ? "γ positiva — anclaje hacia el imán" : "γ negativa — movimientos amplificados"}
          {" · "}gamma real en {(gex.realGammaShare * 100).toFixed(0)}% de los contratos
        </span>
      </header>
      <div className="mw-chain-wrap">
        <table className="mw-chain">
          <thead>
            <tr className="mw-chain-side">
              <th colSpan={3} className="mw-chain-call">CALLS</th>
              <th className="mw-chain-mid" />
              <th colSpan={3} className="mw-chain-put">PUTS</th>
            </tr>
            <tr>
              <th className="mw-chain-vol">Volumen</th><th>OI</th><th>Delta</th>
              <th className="mw-chain-mid">Strike</th>
              <th>Delta</th><th>OI</th><th className="mw-chain-vol">Volumen</th>
            </tr>
          </thead>
          <tbody>
            {chainLines.map((line, i) => {
              const isKing = line.strike === gex.kingStrike;
              const isFlip = line.strike === gex.flipStrike;
              const callItm = line.strike < spot;
              const putItm = line.strike > spot;
              const keyDir = keyStrikeDir.get(line.strike);
              const key = keyDir ? keyLevelTag(levelByStrike.get(line.strike), keyDir) : null;
              const callVolPct = ((line.call?.volume ?? 0) / maxVol) * 100;
              const putVolPct = ((line.put?.volume ?? 0) / maxVol) * 100;
              return (
                <Fragment key={line.strike}>
                  {i === spotIndex && (
                    <tr className="mw-chain-spotrow">
                      <td colSpan={7}>
                        <span className="mw-chain-spot-flag">Precio actual</span> <b>{spot.toFixed(2)}</b>
                      </td>
                    </tr>
                  )}
                  <tr className={key ? `mw-chain-key mw-chain-key-${key.tone}` : ""}>
                    <td className={`mw-chain-vol ${callItm ? "mw-chain-itm" : ""}`}>
                      <span>{num(line.call?.volume)}</span>
                      <i className="mw-chain-bar mw-chain-bar-call" style={{ width: `${callVolPct}%` }} />
                    </td>
                    <td className={callItm ? "mw-chain-itm" : ""}>{num(line.call?.openInterest)}</td>
                    <td className={callItm ? "mw-chain-itm" : ""}>{dec(line.call?.delta)}</td>
                    <td className={`mw-chain-mid ${isKing ? "mw-chain-magnet" : ""}`}>
                      {isKing && <em title="imán">🧲</em>}
                      {isFlip && <em title="zona de inversión">↕</em>}
                      {line.strike}
                      {key && <span className={`mw-chain-tag mw-chain-tag-${key.tone}`}>{key.label}</span>}
                    </td>
                    <td className={putItm ? "mw-chain-itm" : ""}>{dec(line.put?.delta)}</td>
                    <td className={putItm ? "mw-chain-itm" : ""}>{num(line.put?.openInterest)}</td>
                    <td className={`mw-chain-vol ${putItm ? "mw-chain-itm" : ""}`}>
                      <i className="mw-chain-bar mw-chain-bar-put" style={{ width: `${putVolPct}%` }} />
                      <span>{num(line.put?.volume)}</span>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mw-gexmap-legend">
        🧲 imán (mayor concentración de gamma) · ↕ zona de inversión gamma ·{" "}
        <span className="mw-chain-tag mw-chain-tag-resistance">RESISTENCIA</span>{" "}
        <span className="mw-chain-tag mw-chain-tag-support">SOPORTE</span> = soportes y resistencias clave que la
        herramienta ya confirmó (mismos strikes de los targets de abajo).
      </p>
    </section>
  );
}

const CSS = `
.mw-wrap { max-width: 1200px; margin: 0 auto; padding: 0 0 40px; font-size: 15px; }
.mw-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.mw-head h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.2px; }
.mw-head p { margin: 0; color: var(--muted); font-size: 13.5px; }
.mw-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mw-controls select { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.mw-controls button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  background: var(--accent); border: 1px solid var(--accent); color: #fff; font-weight: 600; }
.mw-controls button:disabled { opacity: .6; cursor: default; }
.mw-mkt { font-size: 12.5px; padding: 3px 9px; border-radius: 999px; font-weight: 600; }
.mw-mkt-on { background: var(--green-bg); color: var(--green-dark); border: 1px solid var(--green); }
.mw-mkt-off { background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }
.mw-updated { font-size: 12.5px; color: var(--faint); font-variant-numeric: tabular-nums; }

.mw-error { background: var(--red-bg); border: 1px solid var(--red-soft); color: #7a271a;
  padding: 12px 14px; border-radius: 8px; margin: 16px 0; }
.mw-futures-note { background: var(--accent-dim); border: 1px solid var(--border); color: var(--text);
  padding: 10px 14px; border-radius: 8px; margin: 14px 0 0; font-size: 12.5px; line-height: 1.5; }

.mw-meta { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; margin: 18px 0 14px;
  color: var(--muted); font-size: 13.5px; }
.mw-meta b { color: var(--text); }
.mw-fresh { background: var(--green-bg); border: 1px solid var(--green); color: var(--green-dark);
  padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }

.mw-gexmap { border: 1px solid var(--border); background: var(--panel); border-radius: 12px;
  padding: 16px 18px; margin: 0 0 16px; }
.mw-gexmap header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; margin-bottom: 10px; }
.mw-gexmap h2 { margin: 0; font-size: 16px; }
.mw-gexmap header span { color: var(--muted); font-size: 12.5px; }
.mw-gexmap-empty { color: var(--faint); font-size: 13px; padding: 12px 0; }
.mw-gexmap-legend { margin: 10px 0 0; font-size: 11.5px; color: var(--muted); display: flex; align-items: center;
  gap: 6px; flex-wrap: wrap; }

.mw-chain-wrap { width: 100%; overflow-x: auto; }
.mw-chain { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.mw-chain th, .mw-chain td { padding: 7px 10px; text-align: right; font-size: 13px;
  border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
.mw-chain thead th { background: var(--panel-2); color: var(--muted); font-weight: 600;
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
.mw-chain tr.mw-chain-side th { font-size: 11px; letter-spacing: .16em; padding: 6px; }
.mw-chain-call { color: var(--green-dark); background: var(--green-bg); }
.mw-chain-put { color: #b42318; background: var(--red-bg); }
.mw-chain-mid { text-align: center !important; font-weight: 700; background: var(--panel-2);
  border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
.mw-chain-mid em { font-style: normal; font-size: 10.5px; margin-right: 2px; }
.mw-chain-magnet { background: var(--accent-dim); color: var(--accent); }
.mw-chain-itm { background: rgba(47,107,255,.05); }
.mw-chain-vol { position: relative; font-weight: 600; }
.mw-chain-vol span { position: relative; z-index: 1; }
.mw-chain-bar { position: absolute; bottom: 0; height: 3px; display: block; border-radius: 2px; }
.mw-chain-bar-call { right: 0; background: var(--call); }
.mw-chain-bar-put { left: 0; background: var(--put); }
.mw-chain-spotrow td { background: var(--accent-dim); border-top: 2px solid var(--accent);
  border-bottom: 2px solid var(--accent); text-align: center !important; padding: 6px 10px !important; }
.mw-chain-spot-flag { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700;
  color: #fff; background: var(--accent); padding: 2px 8px; border-radius: 999px; }
.mw-chain-key td { font-weight: 700; }
.mw-chain-key-resistance td:not(.mw-chain-mid) { background: var(--red-bg); }
.mw-chain-key-support td:not(.mw-chain-mid) { background: var(--green-bg); }
.mw-chain-key-bullish td:not(.mw-chain-mid) { background: var(--green-bg); }
.mw-chain-key-bearish td:not(.mw-chain-mid) { background: var(--red-bg); }
.mw-chain-tag { display: inline-block; margin-left: 6px; font-size: 9.5px; font-weight: 800;
  letter-spacing: .03em; padding: 2px 7px; border-radius: 999px; vertical-align: middle; }
.mw-chain-tag-resistance, .mw-chain-tag-bearish { background: var(--red-bg); color: #b42318; border: 1px solid var(--red-soft); }
.mw-chain-tag-support, .mw-chain-tag-bullish { background: var(--green-bg); color: var(--green-dark); border: 1px solid var(--green); }

.mw-advice { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; background: var(--panel); }
.mw-advice-go { border-color: var(--green); background: var(--green-bg); }
.mw-advice-wait { border-color: var(--amber-border); background: var(--amber-bg); }
.mw-advice-lateral { border-color: var(--amber-border); background: var(--amber-bg); text-align: center; }
.mw-advice-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 8px; }
.mw-advice-dir { font-size: 20px; font-weight: 800; }
.mw-advice-magnet { font-size: 14px; color: var(--text); }
.mw-advice-magnet b { font-variant-numeric: tabular-nums; }
.mw-advice-tag { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--border); }
.mw-advice-tag-wait { background: var(--amber-bg); color: var(--amber-text); border-color: var(--amber-border); }
.mw-advice p { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--text); }

.mw-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin: 0 0 16px; }
.mw-box { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; }
.mw-box-muted { opacity: .85; }
.mw-box header { margin-bottom: 10px; }
.mw-box h2 { margin: 0 0 2px; font-size: 15px; }
.mw-box-hint { font-size: 12px; color: var(--muted); }
.mw-box-empty { color: var(--faint); font-size: 13px; margin: 0; }
.mw-targets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.mw-target { border-radius: 8px; }
.mw-target-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.mw-target-top b { font-size: 17px; font-variant-numeric: tabular-nums; }
.mw-target-prob { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.mw-target-call .mw-target-prob { color: var(--green-dark); }
.mw-target-put .mw-target-prob { color: #b42318; }
.mw-target-bar { height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; margin-bottom: 6px; }
.mw-target-call .mw-target-bar i { display: block; height: 100%; background: var(--call); }
.mw-target-put .mw-target-bar i { display: block; height: 100%; background: var(--put); }
.mw-target p { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.4; }

.mw-foot { color: var(--faint); font-size: 12px; margin-top: 8px; line-height: 1.5; }

.mw-entry { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.mw-entry header { margin-bottom: 12px; }
.mw-entry h2 { margin: 0 0 2px; font-size: 15px; }
.mw-entry-hint { font-size: 12px; color: var(--muted); }
.mw-entry-empty { color: var(--faint); font-size: 13px; margin: 0; }
.mw-entry-head { font-weight: 800; font-size: 18px; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mw-entry-head-call { color: var(--green-dark); }
.mw-entry-head-put { color: #b42318; }
.mw-entry-source { font-size: 11px; font-weight: 700; color: var(--muted); background: var(--panel-2);
  border: 1px solid var(--border); border-radius: 999px; padding: 3px 9px; letter-spacing: 0; }
.mw-entry-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 12px; }
.mw-entry-stat { background: var(--panel-2); border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px 12px; }
.mw-entry-stat-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
.mw-entry-stat-value { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.mw-entry-stat-sub { font-size: 11.5px; color: var(--faint); margin-top: 2px; }
.mw-entry-prob { font-size: 11.5px; font-weight: 700; color: var(--accent); margin-top: 3px; }
.mw-entry-reason { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
`;
