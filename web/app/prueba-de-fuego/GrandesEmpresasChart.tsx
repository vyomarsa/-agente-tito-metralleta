"use client";

// Gráfica de velas japonesas para "Grandes empresas" — a pedido explícito de
// el usuario ("no me gusta como se ve la gráfica... hazlo con velas japonesas"),
// reemplaza al motor SVG propio (app/components/chart/PriceChart.tsx, pensado
// para el cono de predicción de Prediction Pro, no para un candlestick clásico)
// por `lightweight-charts` — MISMA librería que ya usa ChartPanel.tsx/
// FlowPriceChart.tsx en el resto del proyecto, no una dependencia nueva.
//
// Los puntos de rechazo del pre-market se dibujan como price lines
// punteadas (igual que ChartPanel.tsx dibuja los strikes), y la franja de
// pre-market (4:00–9:30 ET de cada día) se sombrea en gris — ambos pedidos
// explícitos con capturas de referencia (estilo TradingView). La
// sombra es un overlay de divs posicionados con `timeToCoordinate` (no hay
// primitiva nativa de "banda vertical" en lightweight-charts v4) que se
// reubica solo al hacer pan/zoom o al cambiar el tamaño del contenedor.

import { useEffect, useRef } from "react";
import type { TfBar } from "@/lib/pdf/types";
import { hmET } from "./_format";

export interface ChartLevelLine {
  price: number;
  kind: "techo" | "piso";
  touches: number;
}

export interface ChartPremarketWindow {
  from: number;
  to: number;
}

/**
 * El bar real más cercano (unix seg) a `sec` — mismo binary search que ya usa
 * FlowPriceChart.tsx. Necesario porque `timeToCoordinate` extrapola mal
 * cuando se le pide un tiempo que no es EXACTAMENTE el de un bar real de la
 * serie (acá pasa siempre: la serie mezcla velas de 15 min históricas con
 * velas sintéticas de 5 min de hoy, así que la separación entre bars no es
 * uniforme) — verificado en vivo: sin este ajuste, `timeToCoordinate` daba
 * coordenadas negativas absurdas para TODAS las franjas, incluida la de hoy.
 */
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

export default function GrandesEmpresasChart({
  bars,
  levels,
  premarketWindows,
}: {
  bars: TfBar[];
  levels: ChartLevelLine[];
  premarketWindows: ChartPremarketWindow[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || bars.length === 0) return;

    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const { createChart, ColorType, LineStyle, CrosshairMode } = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;

      const chart = createChart(containerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#9aa5c0",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        },
        grid: {
          vertLines: { color: "#26304250" },
          horzLines: { color: "#26304250" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "#263049" },
        timeScale: {
          borderColor: "#263049",
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (t: number) => hmET(t),
        },
        localization: { timeFormatter: (t: number) => `${hmET(t)} ET` },
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 380,
        autoSize: true,
      });
      // Fuerza un resize explícito con las dimensiones YA medidas del
      // contenedor — `autoSize` depende de un ResizeObserver que, en pestañas
      // en segundo plano o recién montadas, puede no disparar a tiempo
      // (verificado en vivo: sin esto, `timeToCoordinate` devolvía
      // coordenadas negativas absurdas para TODAS las franjas de pre-market,
      // consistente con que la escala interna se calibró contra un tamaño de
      // contenedor obsoleto/cero).
      chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight || 380);

      const candles = chart.addCandlestickSeries({
        upColor: "#1f9d68",
        downColor: "#d9524f",
        wickUpColor: "#1f9d68",
        wickDownColor: "#d9524f",
        borderVisible: false,
      });
      candles.setData(bars.map((b) => ({ time: b.time as never, open: b.open, high: b.high, low: b.low, close: b.close })));

      for (const lvl of levels) {
        candles.createPriceLine({
          price: lvl.price,
          color: lvl.kind === "piso" ? "#1f9d68" : "#d9524f",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `rechazo pre-market (${lvl.kind}) · ${lvl.touches}×`,
        });
      }

      // Franjas grises de pre-market: divs absolutos posicionados con
      // timeToCoordinate, reubicados en cada pan/zoom y en cada resize.
      const barTimes = bars.map((b) => b.time);
      const reposition = () => {
        const overlayEl = overlayRef.current;
        const chartEl = containerRef.current;
        if (!overlayEl || !chartEl) return;
        const width = chartEl.clientWidth;
        overlayEl.replaceChildren();
        const ts = chart.timeScale();
        for (const win of premarketWindows) {
          const snappedFrom = nearestBarTime(barTimes, win.from);
          const snappedTo = nearestBarTime(barTimes, win.to);
          const x1 = snappedFrom != null ? ts.timeToCoordinate(snappedFrom as never) : null;
          const x2 = snappedTo != null ? ts.timeToCoordinate(snappedTo as never) : null;
          if (x1 == null && x2 == null) continue;
          const left = Math.max(0, x1 ?? 0);
          const right = Math.min(width, x2 ?? width);
          if (right <= left) continue;
          const band = document.createElement("div");
          band.style.cssText =
            `position:absolute; left:${left}px; top:0; width:${right - left}px; height:100%; ` +
            `background:rgba(100,105,120,0.16); pointer-events:none;`;
          overlayEl.appendChild(band);
        }
      };

      // Enfoca el último día y medio (sesión de hoy + algo de ayer de contexto).
      const lastT = bars[bars.length - 1].time;
      const from = Math.max(bars[0].time, lastT - 1.5 * 24 * 3600);
      chart.timeScale().setVisibleRange({ from: from as never, to: (lastT + 15 * 60) as never });

      // `timeToCoordinate` puede devolver null en el primer tick (la escala
      // todavía no terminó de calcular su mapeo tras `setVisibleRange`) — un
      // `requestAnimationFrame` de más asegura al menos un reposicionado tras
      // el primer layout real, además de las suscripciones para pan/zoom/resize.
      reposition();
      const raf = requestAnimationFrame(reposition);
      chart.timeScale().subscribeVisibleLogicalRangeChange(reposition);
      chart.timeScale().subscribeVisibleTimeRangeChange(reposition);
      window.addEventListener("resize", reposition);

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", reposition);
        chart.remove();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [bars, levels, premarketWindows]);

  return (
    <div className="ge-chart-canvas-wrap">
      <div ref={overlayRef} className="ge-chart-overlay" />
      <div ref={containerRef} className="ge-chart-canvas" />
    </div>
  );
}
