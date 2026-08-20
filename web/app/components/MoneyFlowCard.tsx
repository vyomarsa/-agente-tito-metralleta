"use client";

import { useMemo } from "react";
import type { ConvictionScore, FlowRow } from "@/lib/flow";
import type { StructureScore } from "@/lib/structure";
import { money, px } from "../format";

/**
 * Today's Money Flow — de todo el dinero notable en opciones, cuánto apuesta
 * al alza (calls) vs a la baja (puts), + los promedios clave de los sub-agentes.
 */
export default function MoneyFlowCard({
  ticker,
  rows,
  conviction,
  structure,
}: {
  ticker: string;
  rows: FlowRow[];
  conviction: ConvictionScore | null;
  structure: StructureScore | null;
}) {
  const { callPct, putPct, biggest } = useMemo(() => {
    let call = 0, put = 0;
    let top: FlowRow | null = null;
    for (const r of rows) {
      if (r.type === "call") call += r.premium;
      else if (r.type === "put") put += r.premium;
      if (!top || r.premium > top.premium) top = r;
    }
    const total = call + put;
    return {
      callPct: total > 0 ? Math.round((call / total) * 100) : 50,
      putPct: total > 0 ? 100 - Math.round((call / total) * 100) : 50,
      biggest: top,
      pcRatio: call > 0 ? put / call : null,
    };
  }, [rows]);

  const pcRatio = useMemo(() => {
    let call = 0, put = 0;
    for (const r of rows) {
      if (r.type === "call") call += r.premium;
      else if (r.type === "put") put += r.premium;
    }
    return call > 0 ? put / call : null;
  }, [rows]);

  const tiles = [
    biggest && {
      label: "Trade más grande",
      value: money.format(biggest.premium),
      sub: `${biggest.underlying} ${biggest.strike != null ? px.format(biggest.strike) : ""}${biggest.type === "call" ? "C" : "P"} · vence ${biggest.expiration ?? "—"}`,
      color: biggest.type === "call" ? "#12b76a" : "#f04438",
    },
    pcRatio != null && {
      label: "Ratio Put/Call",
      value: pcRatio.toFixed(2),
      sub: pcRatio < 0.7 ? "Alcista (< 0.7)" : pcRatio > 1 ? "Bajista (> 1.0)" : "Equilibrado",
      color: pcRatio < 0.7 ? "#12b76a" : pcRatio > 1 ? "#f04438" : "var(--text)",
    },
    conviction && {
      label: "Spread promedio",
      value: conviction.spread.avgPct != null ? `${conviction.spread.avgPct.toFixed(2)}%` : "—",
      sub: conviction.spread.avgPct != null && conviction.spread.avgPct < 2 ? "Muy líquido" : "Liquidez media",
      color: "var(--text)",
    },
    structure && {
      label: "Volumen > Open Interest",
      value: `${structure.volOI.pct.toFixed(0)}%`,
      sub: "Posiciones nuevas abriéndose",
      color: structure.volOI.pct >= 50 ? "#12b76a" : "var(--text)",
    },
  ].filter(Boolean) as { label: string; value: string; sub: string; color: string }[];

  return (
    <section className="card">
      <div>
        <div className="card-title">Today's Money Flow</div>
        <div className="card-sub">
          De todo el dinero notable en opciones de {ticker}, cuánto apuesta al alza vs a la baja.
        </div>
      </div>
      <div>
        <div className="mf-bar">
          <div style={{ background: "#12b76a", width: `${callPct}%` }} />
          <div style={{ background: "#f97066", width: `${putPct}%` }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12 }}>
          <div style={{ fontWeight: 600, color: "#12b76a" }}>{callPct}% alcista</div>
          <div style={{ fontWeight: 600, color: "#f04438" }}>{putPct}% bajista</div>
        </div>
      </div>
      <div className="mf-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="mf-tile">
            <div className="mf-tile-label">{t.label}</div>
            <div className="mf-tile-value" style={{ color: t.color }}>{t.value}</div>
            <div className="mf-tile-sub">{t.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
