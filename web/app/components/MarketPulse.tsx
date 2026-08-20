"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { MarketSentiment, VixState } from "@/lib/marketPulse";
import { VIX_BREAKS, VIX_GAUGE_MAX, vixGaugePos } from "@/lib/marketPulse";

// Dos medidores de aguja al pie de la barra lateral: sentimiento del mercado y VIX.
// Los datos salen de /api/market-pulse, que ya viene cacheado 5 min en el servidor
// (esta tarjeta vive en TODAS las páginas, así que no puede disparar un escaneo de
// mercado por navegación).
const REFRESH_MS = 5 * 60_000;

interface PulseResponse {
  vix: {
    value: number;
    change: number | null;
    changePercent: number | null;
    state: VixState;
    closed: boolean;
    sessionChangePct: number | null;
  } | null;
  vixStatus: "ok" | "needs_auth" | "error";
  vixError: string | null;
  sentiment: MarketSentiment;
  updatedAt: string;
  missing: string[];
}

// ---------------------------------------------------------------------------
// Geometría del arco (semicírculo de 180°, de izquierda a derecha por arriba)
// ---------------------------------------------------------------------------

const R = 38;      // radio del arco
const CX = 50;     // centro
const CY = 46;
const STROKE = 11; // grosor de las bandas de color

/** Punto del arco para una posición t ∈ [0,1] (0 = izquierda, 1 = derecha). */
function pointAt(t: number, radius = R): { x: number; y: number } {
  const angle = Math.PI * (1 - Math.min(Math.max(t, 0), 1)); // π → 0
  return { x: CX + radius * Math.cos(angle), y: CY - radius * Math.sin(angle) };
}

/** Path de un tramo del arco entre dos posiciones. */
function arcPath(t0: number, t1: number): string {
  const a = pointAt(t0), b = pointAt(t1);
  // sweep = 1: de izquierda a derecha pasando por ARRIBA.
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

interface Segment { from: number; to: number; color: string }

function Gauge({
  caption, segments, value, label, sub, muted,
}: {
  caption: string;
  segments: Segment[];
  /** Posición de la aguja 0-1, o null si no hay dato. */
  value: number | null;
  label: string;
  sub: string;
  muted?: boolean;
}) {
  const tip = value != null ? pointAt(value, R - 4) : null;
  const base = value != null ? pointAt(value, 5) : null;
  return (
    <div className={`mp-gauge ${muted ? "muted" : ""}`}>
      <div className="mp-cap">{caption}</div>
      <svg viewBox="0 0 100 56" className="mp-svg" role="img" aria-label={`${caption} ${label}: ${sub}`}>
        {segments.map((s) => (
          <path
            key={`${s.from}-${s.to}`}
            d={arcPath(s.from, s.to)}
            stroke={s.color}
            strokeWidth={STROKE}
            fill="none"
            opacity={muted ? 0.25 : 1}
          />
        ))}
        {tip && base && (
          <>
            <line
              x1={base.x} y1={base.y} x2={tip.x} y2={tip.y}
              className="mp-needle" strokeWidth={2.6} strokeLinecap="round"
            />
            <circle cx={CX} cy={CY} r={3.6} className="mp-hub" />
          </>
        )}
      </svg>
      <div className="mp-value">{label}</div>
      <div className="mp-sub">{sub}</div>
    </div>
  );
}

// Bandas del sentimiento (0-100 → 0-1). Rojo = miedo, verde = codicia.
const SENTIMENT_SEGMENTS: Segment[] = [
  { from: 0.00, to: 0.24, color: "#ef4444" },
  { from: 0.25, to: 0.44, color: "#f97316" },
  { from: 0.45, to: 0.55, color: "#eab308" },
  { from: 0.56, to: 0.75, color: "#84cc16" },
  { from: 0.76, to: 1.00, color: "#22c55e" },
];

// Bandas del VIX sobre la escala 0-VIX_GAUGE_MAX, en los cortes del cuadro
// de interpretación de nivel. Se derivan de VIX_BREAKS para que nunca se
// desincronicen del motor.
const VIX_COLORS = ["#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444"];
const VIX_SEGMENTS: Segment[] = [0, ...VIX_BREAKS].map((from, i) => {
  const to = i < VIX_BREAKS.length ? VIX_BREAKS[i] : VIX_GAUGE_MAX;
  return { from: from / VIX_GAUGE_MAX, to: to / VIX_GAUGE_MAX, color: VIX_COLORS[i] };
});

export default function MarketPulse() {
  const [data, setData] = useState<PulseResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch("/api/market-pulse", { cache: "no-store" });
        if (!r.ok) throw new Error("bad status");
        const d = (await r.json()) as PulseResponse;
        if (alive) { setData(d); setFailed(false); }
      } catch {
        if (alive && !data) setFailed(true);
      }
    };
    void pull();
    const id = setInterval(pull, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) return null; // sin datos no se ocupa sitio en la barra

  const s = data?.sentiment;
  const score = s?.score ?? null;
  const vix = data?.vix ?? null;

  // Aviso honesto: con menos de los 3 componentes el índice sigue siendo válido
  // (los pesos se renormalizan) pero es menos representativo, y hay que decirlo.
  const partial = s != null && s.available > 0 && s.available < s.components.length;

  return (
    <div className="mp">
      <div className="mp-title">Pulso del mercado</div>

      <div className="mp-gauges">
        <Gauge
          caption="Sentimiento"
          segments={SENTIMENT_SEGMENTS}
          value={score != null ? score / 100 : null}
          label={score != null ? String(score) : "—"}
          sub={s?.band?.label ?? (data ? "sin datos" : "cargando…")}
          muted={score == null}
        />
        <Gauge
          caption="VIX"
          segments={VIX_SEGMENTS}
          value={vix ? vixGaugePos(vix.value) : null}
          label={vix ? vix.value.toFixed(2) : "—"}
          sub={vix ? vix.state.label : data?.vixStatus === "needs_auth" ? "Schwab desconectado" : "sin dato"}
          muted={!vix}
        />
      </div>

      {/* Con el mercado CERRADO, Schwab manda netChange 0: pintar "0.00% hoy" se lee
          como "el VIX no se movió", que es falso. Ahí se enseña el movimiento de la
          última SESIÓN (apertura → cierre), que sí dice algo.
          Un VIX que SUBE es malo para el mercado: los colores van al revés a propósito. */}
      {vix && (() => {
        const pct = vix.closed ? vix.sessionChangePct : vix.changePercent;
        if (pct == null) return null;
        return (
          <div className={`mp-note ${pct > 0 ? "down" : "up"}`}>
            VIX {pct > 0 ? "+" : ""}{pct.toFixed(2)}% {vix.closed ? "última sesión" : "hoy"}
          </div>
        );
      })()}
      {!vix && data?.vixStatus === "needs_auth" && (
        <Link href="/schwab" className="mp-fix">Conectar Schwab →</Link>
      )}
      {partial && (
        <div className="mp-note" title={data?.missing.join(" · ")}>
          ⚠ sentimiento con {s!.available} de {s!.components.length} componentes
        </div>
      )}
      {s && s.available > 0 && (
        <ul className="mp-legend">
          {s.components.map((c) => (
            <li key={c.key} className={c.score == null ? "off" : ""} title={c.detail}>
              <span className="mp-dot" style={{ opacity: c.score == null ? 0.3 : 1 }} />
              {c.label.replace(/\s*\(.*\)$/, "")}
              <b>{c.score != null ? Math.round(c.score) : "—"}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
