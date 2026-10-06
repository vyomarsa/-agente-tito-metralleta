"use client";

// Gráfica de velas de BTC — clon de GrandesEmpresasChart.tsx (misma librería,
// `lightweight-charts`, ya usada en el resto del proyecto) + una línea de VWAP
// superpuesta + un panel de MACD apilado abajo. Sin las franjas de pre-market
// (BTC opera 24/7, ese concepto no aplica acá).
//
// El MACD vive en el MISMO chart que las velas (un segundo `priceScaleId`
// acotado a la franja inferior con `scaleMargins`), no en un chart aparte
// sincronizado — así el eje de tiempo es literalmente el mismo, sin necesitar
// plomería de sincronización entre dos instancias de lightweight-charts en
// componentes distintos.

import { useEffect, useRef } from "react";
import type { TfBar } from "@/lib/pdf/types";
import type { MacdPoint } from "@/lib/pdf/technicalIndicators";

export interface BtcChartLevelLine {
  price: number;
  kind: "techo" | "piso";
  touches: number;
}

export default function BtcPriceChart({
  bars,
  levels,
  vwap,
  macd,
}: {
  bars: TfBar[];
  levels: BtcChartLevelLine[];
  vwap: Array<number | null>;
  macd: MacdPoint[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);

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
        rightPriceScale: { borderColor: "#263049", scaleMargins: { top: 0.05, bottom: 0.32 } },
        timeScale: { borderColor: "#263049", timeVisible: true, secondsVisible: false },
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 460,
        autoSize: true,
      });
      chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight || 460);

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
          title: `${lvl.kind === "piso" ? "soporte" : "resistencia"} · ${lvl.touches}×`,
        });
      }

      const vwapData = bars
        .map((b, i) => ({ time: b.time as never, value: vwap[i] }))
        .filter((p): p is { time: never; value: number } => p.value != null);
      if (vwapData.length > 0) {
        const vwapSeries = chart.addLineSeries({ color: "#e8a33d", lineWidth: 2, priceLineVisible: false, title: "VWAP" });
        vwapSeries.setData(vwapData);
      }

      // El priceScale "macd" no existe hasta que algún series lo referencia por
      // `priceScaleId` — llamar a `chart.priceScale("macd")` antes de eso tira
      // "incorrect ID" y aborta este efecto entero (cleanup nunca se asigna, así
      // que el chart previo nunca se remueve y se van apilando uno sobre otro).
      let macdScaleReady = false;
      const ensureMacdScale = () => {
        if (macdScaleReady) return;
        macdScaleReady = true;
        chart.priceScale("macd").applyOptions({ scaleMargins: { top: 0.72, bottom: 0.02 } });
      };

      const histData = bars
        .map((b, i) => ({ time: b.time as never, value: macd[i]?.histogram, up: (macd[i]?.histogram ?? 0) >= 0 }))
        .filter((p): p is { time: never; value: number; up: boolean } => p.value != null)
        .map((p) => ({ time: p.time, value: p.value, color: p.up ? "#1f9d6880" : "#d9524f80" }));
      if (histData.length > 0) {
        const hist = chart.addHistogramSeries({ priceScaleId: "macd", priceLineVisible: false, lastValueVisible: false });
        ensureMacdScale();
        hist.setData(histData);
      }

      const macdLineData = bars
        .map((b, i) => ({ time: b.time as never, value: macd[i]?.macd }))
        .filter((p): p is { time: never; value: number } => p.value != null);
      if (macdLineData.length > 0) {
        const macdLine = chart.addLineSeries({
          priceScaleId: "macd", color: "#4f8cff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "MACD",
        });
        ensureMacdScale();
        macdLine.setData(macdLineData);
      }

      const signalLineData = bars
        .map((b, i) => ({ time: b.time as never, value: macd[i]?.signal }))
        .filter((p): p is { time: never; value: number } => p.value != null);
      if (signalLineData.length > 0) {
        const signalLine = chart.addLineSeries({
          priceScaleId: "macd", color: "#e8a33d", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "Señal",
        });
        ensureMacdScale();
        signalLine.setData(signalLineData);
      }

      cleanup = () => chart.remove();
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [bars, levels, vwap, macd]);

  return <div ref={containerRef} className="btc-chart-canvas" />;
}
