"use client";

// Pestaña BTC (Prueba de Fuego, pedido explícito): trackear el
// momentum de BTC con Ondas de Elliott como capa de CONTEXTO — BTC no tiene
// flujo de opciones en este proyecto, así que todo el motor sale de precio y
// volumen (ver lib/btcElliottWave.ts y lib/btcMomentum.ts). Dos tarjetas de
// recomendación independientes: una basada SOLO en Elliott, otra en
// Momentum/Volumen/MACD/VWAP que además usa a Elliott como confirmación o
// contradicción (sube/baja la confianza, nunca reemplaza la señal).

import { useCallback, useEffect, useRef, useState } from "react";
import BtcPriceChart, { type BtcChartLevelLine } from "./BtcPriceChart";
import PriceChart, { type ChartSeries, type ChartTarget, type WaveMarker } from "@/app/prueba-de-fuego/_components/chart/PriceChart";
import { BTC_CHART_TIMEFRAMES, DEFAULT_BTC_TIMEFRAME, type BtcTimeframeId } from "@/lib/pdf/btcTimeframes";
import type { TfBar } from "@/lib/pdf/types";
import type { LevelsReport } from "@/lib/pdf/levels";
import type { MacdPoint } from "@/lib/pdf/technicalIndicators";
import type { ElliottWaveSignal, WaveBias, WavePoint } from "@/lib/pdf/btcElliottWave";
import type { MomentumSignal } from "@/lib/pdf/btcMomentum";

const REFRESH_MS = 60_000;

interface BtcData {
  timeframe: BtcTimeframeId;
  asOf: string;
  bars: TfBar[];
  spot: number;
  levels: LevelsReport;
  vwap: Array<number | null>;
  macd: MacdPoint[];
  elliottWave: ElliottWaveSignal;
  momentumSignal: MomentumSignal;
}

export default function BtcTab() {
  const [tf, setTf] = useState<BtcTimeframeId>(DEFAULT_BTC_TIMEFRAME);
  const [data, setData] = useState<BtcData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const requestedTfRef = useRef<BtcTimeframeId>(tf);

  const load = useCallback(async (timeframe: BtcTimeframeId) => {
    requestedTfRef.current = timeframe;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pdf/btc?tf=${timeframe}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (requestedTfRef.current !== timeframe) return;
      setData(json as BtcData);
      setLastUpdated(new Date());
    } catch (e) {
      if (requestedTfRef.current !== timeframe) return;
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      if (requestedTfRef.current === timeframe) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(tf);
    const id = setInterval(() => load(tf), REFRESH_MS);
    return () => clearInterval(id);
  }, [tf, load]);

  const chartLevels: BtcChartLevelLine[] = data
    ? [
        ...data.levels.supports.map((l) => ({ price: l.price, kind: "piso" as const, touches: l.sources.touches })),
        ...data.levels.resistances.map((l) => ({ price: l.price, kind: "techo" as const, touches: l.sources.touches })),
      ]
    : [];

  const lastBar = data && data.bars.length > 0 ? data.bars[data.bars.length - 1] : null;
  const ewProjection = data?.elliottWave.projection ?? [];
  const ewHorizonDays =
    lastBar && ewProjection.length > 0
      ? Math.max(0.05, (ewProjection[ewProjection.length - 1].time - lastBar.time) / 86_400)
      : 1;
  const ewColor = data
    ? data.elliottWave.bias === "long" ? "#1f9d68" : data.elliottWave.bias === "short" ? "#d9524f" : "#9aa5c0"
    : "#9aa5c0";
  const ewSeries: ChartSeries[] =
    data && lastBar && ewProjection.length > 0
      ? [
          {
            key: "elliott",
            points: [{ price: lastBar.close }, ...ewProjection.map((p) => ({ price: p.price }))],
            color: ewColor,
            width: 2.5,
          },
        ]
      : [];
  const ewTargets: ChartTarget[] =
    ewProjection.length > 0
      ? [{ key: "ew-target", price: ewProjection[ewProjection.length - 1].price, label: "Proyección", color: "#f5c542", weight: 1 }]
      : [];
  const ewWaveMarkers: WaveMarker[] =
    data?.elliottWave.waveSequence.map((w) => ({
      time: w.time, price: w.price, kind: w.kind, label: shortWaveLabel(w.label),
    })) ?? [];

  return (
    <div className="btc-wrap">
      <style>{CSS}</style>

      <header className="btc-head">
        <div>
          <h1>BTC — Ondas de Elliott + Momentum/Volumen</h1>
          <p>
            Bitcoin no tiene flujo de opciones en este proyecto — todo acá sale de precio y volumen. El conteo de
            Ondas de Elliott es una lectura subjetiva por naturaleza: se muestra como capa de contexto, no como
            predicción certera. Con confianza baja, ambas tarjetas caen a &quot;no operar&quot; en vez de forzar
            una entrada.
          </p>
        </div>
        <div className="btc-controls">
          {lastUpdated && (
            <span className="btc-updated">actualizado {lastUpdated.toLocaleTimeString("es-ES", { hour12: false })}</span>
          )}
          <button onClick={() => load(tf)} disabled={loading}>
            {loading ? "Cargando…" : "🔄 Actualizar"}
          </button>
        </div>
      </header>

      <div className="btc-tf-picker">
        {BTC_CHART_TIMEFRAMES.map((t) => (
          <button key={t.id} className={tf === t.id ? "active" : ""} onClick={() => setTf(t.id as BtcTimeframeId)}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="btc-error">⚠ {error}</div>}

      {data && (
        <div className="btc-price-box">
          <span className="btc-price-label">BTC/USD · {BTC_CHART_TIMEFRAMES.find((t) => t.id === tf)?.label}</span>
          <span className="btc-price-value">${data.spot.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
        </div>
      )}

      {data && data.bars.length > 0 && (
        <section className="btc-chart-box">
          <header>
            <h2>Precio + zonas de liquidez + VWAP + MACD</h2>
            <p>Líneas punteadas = soporte/resistencia · línea naranja sobre las velas = VWAP · panel inferior = MACD.</p>
          </header>
          <div className="btc-chart">
            <BtcPriceChart bars={data.bars} levels={chartLevels} vwap={data.vwap} macd={data.macd} />
          </div>
        </section>
      )}

      {data && (
        <section className="btc-chart-box">
          <header>
            <h2>Proyección — solo Ondas de Elliott</h2>
            <p>{data.elliottWave.waveLabel} · sin mezclar MACD/VWAP acá, a propósito.</p>
          </header>
          <div className="btc-chart">
            <PriceChart
              bars={data.bars}
              spot={data.spot}
              horizonDays={ewHorizonDays}
              series={ewSeries}
              targets={ewTargets}
              waveMarkers={ewWaveMarkers}
              waveMarkerColor={ewColor}
              theme="dark"
              height="100%"
              showSpot
            />
          </div>
        </section>
      )}

      {data && (
        <AdviceCard
          title="Ondas de Elliott"
          tag={data.elliottWave.waveLabel}
          signal={data.elliottWave}
          waveSequence={data.elliottWave.waveSequence}
        />
      )}
      {data && (
        <AdviceCard
          title="Momentum / Volumen / MACD / VWAP"
          tag={agreementLabel(data.momentumSignal.elliottAgreement)}
          signal={data.momentumSignal}
        />
      )}

      <p className="btc-foot">
        Se actualiza sola cada 60s. BTC opera 24/7 — sin horario de mercado. Ninguna de las dos tarjetas es una
        orden ni un consejo financiero; dinero simulado.
      </p>
    </div>
  );
}

/** "Onda 4 (en curso)" → "4", "Onda C (completa)" → "C", "Techo previo" → "Techo" — compacto para caber sobre la vela. */
function shortWaveLabel(label: string): string {
  if (label === "Inicio") return "0";
  return label
    .replace(/^Onda\s*/, "")
    .replace(/\s*\(.*\)$/, "")
    .replace(/\s*previo$/i, "");
}

function agreementLabel(a: MomentumSignal["elliottAgreement"]): string | null {
  if (a === "agrees") return "✓ confirma Elliott";
  if (a === "conflicts") return "⚠ contradice Elliott";
  return null;
}

function biasClass(bias: WaveBias): string {
  return bias === "long" ? "btc-advice-call" : bias === "short" ? "btc-advice-put" : "btc-advice-lateral";
}

function biasLabel(bias: WaveBias): string {
  return bias === "long" ? "🟢 LONG" : bias === "short" ? "🔴 SHORT" : "🟡 NO OPERAR";
}

interface AdviceLike {
  bias: WaveBias;
  stopLoss: number | null;
  target: number | null;
  reason: string;
  confidence: number;
}

function AdviceCard({
  title,
  tag,
  signal,
  waveSequence,
}: {
  title: string;
  tag: string | null;
  signal: AdviceLike;
  waveSequence?: WavePoint[];
}) {
  return (
    <section className={`btc-advice ${biasClass(signal.bias)}`}>
      <div className="btc-advice-top">
        <span className="btc-advice-dir">
          {biasLabel(signal.bias)} — {title}
        </span>
        {tag && <span className="btc-advice-tag">{tag}</span>}
      </div>
      {waveSequence && waveSequence.length > 0 && (
        <div className="btc-wave-seq">
          {waveSequence.map((w, i) => (
            <span key={`${w.label}-${w.time}`} className="btc-wave-seq-item">
              <span className="btc-wave-seq-label">{w.label}</span>
              <span className="btc-wave-seq-price">${Math.round(w.price).toLocaleString("en-US")}</span>
              {i < waveSequence.length - 1 && <span className="btc-wave-seq-arrow">→</span>}
            </span>
          ))}
        </div>
      )}
      {signal.bias !== "neutral" && (
        <div className="btc-targets-row">
          <div className="btc-chip">
            <div className="btc-chip-label">Target</div>
            <div className="btc-chip-value">{signal.target != null ? `$${Math.round(signal.target).toLocaleString("en-US")}` : "—"}</div>
          </div>
          <div className="btc-chip btc-chip-stop">
            <div className="btc-chip-label">Stop</div>
            <div className="btc-chip-value">{signal.stopLoss != null ? `$${Math.round(signal.stopLoss).toLocaleString("en-US")}` : "—"}</div>
          </div>
          <div className="btc-chip">
            <div className="btc-chip-label">Confianza</div>
            <div className="btc-chip-value">{Math.round(signal.confidence * 100)}%</div>
          </div>
        </div>
      )}
      <p>{signal.reason}</p>
    </section>
  );
}

const CSS = `
.btc-wrap { max-width: 1200px; margin: 0 auto; padding: 0 0 40px; font-size: 15px; }
.btc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.btc-head h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.2px; }
.btc-head p { margin: 0; max-width: 640px; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
.btc-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.btc-controls button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  background: var(--accent); border: 1px solid var(--accent); color: #fff; font-weight: 600; }
.btc-controls button:disabled { opacity: .6; cursor: default; }
.btc-updated { font-size: 12.5px; color: var(--faint); font-variant-numeric: tabular-nums; }

.btc-tf-picker { display: flex; gap: 4px; flex-wrap: wrap; margin: 16px 0; }
.btc-tf-picker button { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 6px;
  cursor: pointer; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); }
.btc-tf-picker button.active { background: var(--accent); border-color: var(--accent); color: #fff; }

.btc-error { background: var(--red-bg); border: 1px solid var(--red-soft); color: #7a271a;
  padding: 12px 14px; border-radius: 8px; margin: 16px 0; }

.btc-price-box { border: 1px solid var(--border); background: var(--panel); border-radius: 12px;
  padding: 12px 18px; display: inline-flex; flex-direction: column; gap: 3px; min-width: 200px; margin: 0 0 14px; }
.btc-price-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; }
.btc-price-value { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; }

.btc-chart-box { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.btc-chart-box header { margin-bottom: 8px; }
.btc-chart-box h2 { margin: 0; font-size: 15px; }
.btc-chart-box p { margin: 2px 0 0; font-size: 12px; color: var(--faint); }
.btc-chart { height: clamp(340px, 46vw, 520px); position: relative; }
.btc-chart-canvas { width: 100%; height: 100%; }

.btc-advice { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; background: var(--panel); }
.btc-advice-call { border-color: var(--green); background: var(--green-bg); }
.btc-advice-put { border-color: var(--red-soft); background: var(--red-bg); }
.btc-advice-lateral { border-color: var(--amber-border); background: var(--amber-bg); }
.btc-advice-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
.btc-advice-dir { font-size: 18px; font-weight: 800; }
.btc-advice-tag { font-size: 11.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--border); }
.btc-advice p { margin: 8px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--text); }

.btc-wave-seq { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 10px; }
.btc-wave-seq-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.btc-wave-seq-label { color: var(--muted); font-weight: 600; }
.btc-wave-seq-price { font-weight: 800; font-variant-numeric: tabular-nums; background: var(--panel-2);
  border: 1px solid var(--border-soft); border-radius: 6px; padding: 2px 7px; }
.btc-wave-seq-arrow { color: var(--faint); }

.btc-targets-row { display: flex; gap: 12px; flex-wrap: wrap; }
.btc-chip { background: var(--panel-2); border: 1px solid var(--border-soft); border-radius: 8px;
  padding: 10px 14px; min-width: 130px; }
.btc-chip-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
.btc-chip-value { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.btc-chip-stop { border-color: var(--amber-border); }

.btc-foot { color: var(--faint); font-size: 12px; margin-top: 8px; line-height: 1.5; }
`;
