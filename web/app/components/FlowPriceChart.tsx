"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { detectClusters, type FlowRow } from "@/lib/flow";
import { useBars } from "./useBars";
import { dateET, hmET, int, money, px, timeET } from "../format";

const FORWARD_SEC = 30 * 60; // seguimiento intradía: +30 min
const FORWARD_SEC_DAILY = 24 * 3600; // seguimiento en vista diaria: +1 día

// Ventana de flujo que carga cada timeframe (el flujo acompaña a la gráfica).
const DAYS_BY_TF: Record<string, number> = { "5m5d": 5, "15m10d": 10, "1y": 30 };

const ASK = "#3fd07a";
const BID = "#ff6b6b";
const ASK_DIM = "rgba(63, 208, 122, 0.5)";
const BID_DIM = "rgba(255, 107, 107, 0.5)";
const CLUSTER_ASK = "#8cffbc";
const CLUSTER_BID = "#ffa8a8";

const TFS: { key: string; label: string; intraday: boolean }[] = [
  { key: "5m5d", label: "5 min · 5d", intraday: true },
  { key: "15m10d", label: "15 min · 10d", intraday: true },
  { key: "1y", label: "1 año", intraday: false },
];

function contractLabel(r: FlowRow): string {
  const t = r.type === "call" ? "C" : r.type === "put" ? "P" : "?";
  return `${r.underlying} ${r.strike != null ? px.format(r.strike) : "?"}${t}`;
}

function nearestBarTime(times: number[], sec: number): number | null {
  if (times.length === 0) return null;
  if (sec <= times[0]) return times[0];
  if (sec >= times[times.length - 1]) return times[times.length - 1];
  let lo = 0, hi = times.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] === sec) return sec;
    if (times[mid] < sec) lo = mid + 1;
    else hi = mid - 1;
  }
  const before = times[hi], after = times[lo];
  return sec - before <= after - sec ? before : after;
}

export default function FlowPriceChart({ ticker, trades }: { ticker: string; trades: FlowRow[] }) {
  const priceRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState("5m5d");
  const { bars, stale, error, loading, retrying } = useBars(ticker, tf);
  const [flowTrades, setFlowTrades] = useState<FlowRow[] | null>(null);
  const [flowLoading, setFlowLoading] = useState(false);

  const intraday = TFS.find((x) => x.key === tf)?.intraday ?? true;
  const fwdSec = intraday ? FORWARD_SEC : FORWARD_SEC_DAILY;
  // El flujo de la gráfica acompaña al timeframe (5d / 10d / 30d).
  const effTrades = flowTrades ?? trades;
  const clusters = useMemo(() => detectClusters(effTrades), [effTrades]);

  useEffect(() => {
    let cancelled = false;
    const days = DAYS_BY_TF[tf] ?? 5;
    setFlowLoading(true);
    fetch(`/api/flow?ticker=${encodeURIComponent(ticker)}&days=${days}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && Array.isArray(d.rows)) setFlowTrades(d.rows); })
      .catch(() => { /* fallback: se queda el flujo del dashboard */ })
      .finally(() => { if (!cancelled) setFlowLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, tf]);

  // Racimos + movimiento posterior (tabla)
  const clusterRows = useMemo(() => {
    const times = bars ? bars.map((b) => b.time) : [];
    const closeByTime = new Map((bars ?? []).map((b) => [b.time, b.close]));
    return clusters.map((c) => {
      let move: { pct: number; matched: boolean } | null = null;
      if (bars && bars.length > 0) {
        const bt = nearestBarTime(times, c.endSec);
        const ft = nearestBarTime(times, c.endSec + fwdSec);
        if (bt != null && ft != null && ft > bt) {
          const base = closeByTime.get(bt), fut = closeByTime.get(ft);
          if (base != null && fut != null && base !== 0) {
            const pct = (fut - base) / base;
            // El veredicto se mide contra la APUESTA (calls/puts), no contra ask/bid.
            move = { pct, matched: c.bet === "alcista" ? pct > 0 : pct < 0 };
          }
        }
      }
      return { c, move };
    });
  }, [clusters, bars, fwdSec]);

  useEffect(() => {
    const priceEl = priceRef.current;
    const histEl = histRef.current;
    const tip = tooltipRef.current;
    if (!priceEl || !histEl || !bars || bars.length === 0) return;

    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const { createChart, ColorType, CrosshairMode } = await import("lightweight-charts");
      if (disposed || !priceRef.current || !histRef.current) return;

      const common = {
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8a93a6", fontFamily: "ui-sans-serif, system-ui, sans-serif" },
        grid: { vertLines: { visible: false }, horzLines: { color: "#26304228" } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "#26304260", minimumWidth: 72 },
      } as const;

      // ── Panel 1: PRECIO (limpio — solo velas + banderas de racimo)
      const priceChart = createChart(priceEl, {
        ...common,
        timeScale: { visible: false, borderColor: "#26304260" },
        height: 300,
        autoSize: true,
      });
      const candles = priceChart.addCandlestickSeries({
        upColor: "#1f9d68", downColor: "#d9524f",
        wickUpColor: "#1f9d6899", wickDownColor: "#d9524f99",
        borderVisible: false, priceLineVisible: false,
      });
      candles.setData(bars.map((b) => ({ time: b.time as never, open: b.open, high: b.high, low: b.low, close: b.close })));

      // ── Panel 2: DINERO (histograma espejo — compra arriba, venta abajo)
      const histChart = createChart(histEl, {
        ...common,
        timeScale: {
          borderColor: "#26304260",
          timeVisible: intraday,
          secondsVisible: false,
          ...(intraday ? { tickMarkFormatter: (t: number) => hmET(t) } : {}),
        },
        ...(intraday ? { localization: { timeFormatter: (t: number) => hmET(t) + " ET" } } : {}),
        height: 170,
        autoSize: true,
      });
      // Escala log: sin ella, un solo día gigante ($700M+) aplasta el resto de barras.
      const toLog = (v: number) => Math.max(0.2, Math.log10(Math.max(v, 1)) - 4.5);
      const fromLog = (v: number) => Math.pow(10, Math.abs(v) + 4.5);
      const fmtAbs = { type: "custom" as const, formatter: (v: number) => (Math.abs(v) < 0.05 ? "$0" : money.format(fromLog(v))), minMove: 0.01 };
      const askHist = histChart.addHistogramSeries({ priceFormat: fmtAbs, lastValueVisible: false, priceLineVisible: false });
      const bidHist = histChart.addHistogramSeries({ priceFormat: fmtAbs, lastValueVisible: false, priceLineVisible: false });

      // Mapear trades a su vela + agregado por vela
      const barTimes = bars.map((b) => b.time);
      const tradesByBar = new Map<number, FlowRow[]>();
      const agg = new Map<number, { ask: number; bid: number }>();
      for (const t of effTrades) {
        const sec = Math.floor(Date.parse(t.timestamp) / 1000);
        if (!Number.isFinite(sec)) continue;
        const bt = nearestBarTime(barTimes, sec);
        if (bt == null) continue;
        (tradesByBar.get(bt) ?? tradesByBar.set(bt, []).get(bt)!).push(t);
        const a = agg.get(bt) ?? { ask: 0, bid: 0 };
        if (t.aggression === "ask") a.ask += t.premium;
        else if (t.aggression === "bid") a.bid += t.premium;
        agg.set(bt, a);
      }

      // Velas dentro de un racimo (para resaltarlas)
      const clusterBars = new Set<number>();
      for (const c of clusters) {
        const bs = nearestBarTime(barTimes, c.startSec);
        const be = nearestBarTime(barTimes, c.endSec);
        if (bs == null || be == null) continue;
        for (const bt of barTimes) if (bt >= bs && bt <= be) clusterBars.add(bt);
      }

      // IMPORTANTE: un punto por CADA vela (whitespace si no hay flujo) para que los
      // índices lógicos de ambos paneles coincidan y la sincronización sea 1:1.
      askHist.setData(barTimes.map((bt) => {
        const a = agg.get(bt);
        return a && a.ask > 0
          ? { time: bt as never, value: toLog(a.ask), color: clusterBars.has(bt) ? CLUSTER_ASK : ASK_DIM }
          : ({ time: bt as never } as { time: never });
      }));
      bidHist.setData(barTimes.map((bt) => {
        const a = agg.get(bt);
        return a && a.bid > 0
          ? { time: bt as never, value: -toLog(a.bid), color: clusterBars.has(bt) ? CLUSTER_BID : BID_DIM }
          : ({ time: bt as never } as { time: never });
      }));

      // Banderas de racimo sobre el precio. Para no amontonar, solo los 5 racimos
      // más grandes llevan texto; el resto es una flecha pequeña.
      const top5 = new Set([...clusters].sort((a, b) => b.premium - a.premium).slice(0, 5));
      type Mk = { time: never; position: "aboveBar" | "belowBar"; color: string; shape: "arrowUp" | "arrowDown"; size: number; text?: string };
      const markers: Mk[] = [];
      for (const c of clusters) {
        const btEnd = nearestBarTime(barTimes, c.endSec);
        if (btEnd == null) continue;
        const alcista = c.bet === "alcista";
        markers.push({
          time: btEnd as never,
          position: alcista ? "belowBar" : "aboveBar",
          color: "#ffb020",
          shape: alcista ? "arrowUp" : "arrowDown",
          size: top5.has(c) ? 2 : 1,
          ...(top5.has(c) ? { text: `${c.count}× ${money.format(c.premium)}` } : {}),
        });
      }
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      candles.setMarkers(markers);

      // Sincronizar el zoom/scroll de los dos paneles
      let syncing = false;
      const link = (from: ReturnType<typeof createChart>, to: ReturnType<typeof createChart>) => {
        from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
          if (syncing || !r) return;
          syncing = true;
          to.timeScale().setVisibleLogicalRange(r);
          syncing = false;
        });
      };
      link(priceChart, histChart);
      link(histChart, priceChart);

      // Leyenda fija en la esquina (no flota ni tapa las velas)
      const showTip = (sec: number | undefined) => {
        if (!tip) return;
        const list = sec != null ? tradesByBar.get(sec) : undefined;
        if (!list) { tip.style.display = "none"; return; }
        const a = agg.get(sec!) ?? { ask: 0, bid: 0 };
        const shown = [...list].sort((x, y) => y.premium - x.premium).slice(0, 3);
        tip.innerHTML =
          `<div class="ft-time">${dateET(list[0].timestamp)} · ${timeET(list[0].timestamp)} ET — ${list.length} trade${list.length > 1 ? "s" : ""}` +
          ` · <span style="color:${ASK}">▲ ${money.format(a.ask)}</span> <span style="color:${BID}">▼ ${money.format(a.bid)}</span></div>` +
          shown.map((r) => {
            const c = r.aggression === "ask" ? ASK : BID;
            const lado = r.aggression === "ask" ? "compra" : "venta";
            const tipo = r.type === "call" ? "CALL" : r.type === "put" ? "PUT" : "";
            return `<div class="ft-row"><span class="ft-dot" style="background:${c}"></span><b>${contractLabel(r)}</b> ${tipo} <span class="ft-side" style="color:${c}">${lado}</span> · ${money.format(r.premium)} · ${int.format(r.size)}u</div>`;
          }).join("") +
          (list.length > shown.length ? `<div class="ft-more">+${list.length - shown.length} más…</div>` : "");
        tip.style.display = "block";
      };
      priceChart.subscribeCrosshairMove((p) => showTip(p.time as unknown as number | undefined));
      histChart.subscribeCrosshairMove((p) => showTip(p.time as unknown as number | undefined));

      // Zoom inicial: en intradía, enfocar el último día completo (sesión incluida).
      if (intraday) {
        const lastT = bars[bars.length - 1].time;
        const from = Math.max(bars[0].time, lastT - 24 * 3600);
        priceChart.timeScale().setVisibleRange({ from: from as never, to: (lastT + 45 * 60) as never });
      } else {
        priceChart.timeScale().fitContent();
      }

      cleanup = () => { priceChart.remove(); histChart.remove(); };
    })();

    return () => { disposed = true; cleanup(); };
  }, [bars, effTrades, clusters, tf, intraday]);

  return (
    <section className="chart">
      <div className="chart-head">
        <h2>Flujo notable sobre el precio · {ticker}</h2>
        <div className="tf-toggle">
          {TFS.map((x) => (
            <button key={x.key} className={`tf-btn ${tf === x.key ? "on" : ""}`} onClick={() => setTf(x.key)} type="button">{x.label}</button>
          ))}
        </div>
      </div>
      <div className="chart-sub muted">
        Arriba: el precio. Abajo: el dinero de cada vela — <span className="dot-ask" /> <b>compra</b> hacia arriba,
        {" "}<span className="dot-bid" /> <b>venta</b> hacia abajo (barras brillantes = racimo).
        {" "}🚩 = racimo de trades ({DAYS_BY_TF[tf] ?? 5} días de flujo) · hora ET · pasa el cursor para ver los trades.
      </div>
      {flowLoading && <div className="chart-loading">Cargando flujo de {DAYS_BY_TF[tf] ?? 5} días…</div>}
      {loading && <div className="chart-loading">Cargando barras…</div>}
      {!loading && bars && bars.length === 0 && (
        <div className="chart-empty">
          {error
            ? `${error}${retrying ? " Reintentando solo…" : ""}`
            : `Sin barras de precio para ${ticker} en este timeframe.`}
        </div>
      )}
      <div className="flowchart-wrap" style={{ display: bars && bars.length > 0 ? "block" : "none" }}>
        {/* Dentro del wrap a propósito: `.chart-stale` va absoluto y este es el
            ancestro posicionado más cercano. */}
        {stale && <div className="chart-stale">⚡ Barras de la última carga buena: {error}</div>}
        <div ref={priceRef} className="pane-price" />
        <div ref={histRef} className="pane-hist" />
        <div ref={tooltipRef} className="flow-legend" style={{ display: "none" }} />
      </div>

      {clusterRows.length > 0 && (
        <div className="clusters">
          <div className="clusters-title">
            🚩 Racimos de trades ({clusterRows.length})
            <span className="muted"> — grupos de 3+ trades grandes del mismo lado en 5 minutos</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Cuándo (ET)</th><th>Qué hicieron</th><th>Apuesta</th><th>Trades</th>
                  <th>Dinero</th><th>Fuerza</th><th>¿El precio siguió la apuesta? ({intraday ? "30 min" : "1 día"} después)</th>
                </tr>
              </thead>
              <tbody>
                {clusterRows.map(({ c, move }, i) => (
                  <tr key={i}>
                    <td className="left">{dateET(c.trades[0].timestamp)} · {hmET(c.startSec)}–{hmET(c.endSec)}</td>
                    <td><span className={`pill ${c.bet === "alcista" ? "agg-ask" : "agg-bid"}`}>{c.betLabel}</span></td>
                    <td>{c.bet === "alcista" ? "📈 Alcista" : "📉 Bajista"}</td>
                    <td>{c.count}</td>
                    <td>{money.format(c.premium)}</td>
                    <td>{c.score}/10</td>
                    <td>
                      {move
                        ? <span className={move.matched ? "mv-ok" : "mv-bad"}>{move.matched ? "Sí ✓" : "No ✗"} ({(move.pct * 100).toFixed(2)}%)</span>
                        : <span className="muted">aún en curso</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pxsrc" style={{ marginTop: 8 }}>
            La <b>apuesta</b> sale de qué operaron: comprar CALLS o vender PUTS = apuesta alcista 📈 ·
            comprar PUTS o vender CALLS = apuesta bajista 📉. "Sí" = el precio se movió en esa dirección. No es consejo, es análisis.
          </p>
        </div>
      )}
    </section>
  );
}
