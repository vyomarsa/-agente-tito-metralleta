"use client";

import type { ProPrediction, Scenario } from "@/lib/prediction";
import { HORIZONS } from "@/lib/prediction";
import type { FlowRow } from "@/lib/flow";
import { money, px } from "../format";

const KIND: Record<Scenario["kind"], { label: string; color: string; bg: string }> = {
  bear: { label: "Bear case", color: "var(--red-strong)", bg: "var(--red-bg)" },
  base: { label: "Base case", color: "var(--text)", bg: "var(--panel-2)" },
  bull: { label: "Bull case", color: "var(--green-strong)", bg: "var(--green-bg)" },
};

function ScenarioBox({ s }: { s: Scenario }) {
  const k = KIND[s.kind];
  return (
    <div className="sc-box" style={{ background: k.bg, borderColor: "var(--border)" }}>
      <div className="sc-head" style={{ color: k.color }}>{k.label}</div>
      <div className="sc-target" style={{ color: k.color }}>${px.format(s.target)}</div>
      <div className="sc-chg" style={{ color: k.color }}>
        {s.changePct >= 0 ? "+" : ""}{s.changePct.toFixed(1)}%
      </div>
      <div className="sc-prob">
        <div className="sc-prob-bar">
          <div style={{ width: `${Math.round(s.probability * 100)}%`, background: k.color }} />
        </div>
        <span>{(s.probability * 100).toFixed(0)}% de tocarlo</span>
      </div>
      <div className="sc-driver">{s.driver}</div>
    </div>
  );
}

/**
 * Prediction Pro — los tres escenarios (bear / base / bull) con su probabilidad,
 * el resumen del agente y los 3 flows más notables que sostienen la lectura.
 */
export default function PredictionCard({
  ticker,
  prediction,
  horizonDays,
  onHorizon,
  topFlows,
}: {
  ticker: string;
  prediction: ProPrediction | null;
  horizonDays: number;
  onHorizon: (d: number) => void;
  topFlows: FlowRow[];
}) {
  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="card-title">
            Prediction Pro <span className="pro-badge" style={{ marginLeft: 6 }}>PRO</span>
          </div>
          <div className="card-sub">
            Los tres escenarios de {ticker} según dónde está el dinero y cuánto puede moverse
            el precio por volatilidad.
          </div>
        </div>
        <div className="hz-tabs">
          {HORIZONS.map((h) => (
            <button
              key={h.days}
              type="button"
              className={`hz-tab ${horizonDays === h.days ? "on" : ""}`}
              onClick={() => onHorizon(h.days)}
            >
              {h.days}d
            </button>
          ))}
        </div>
      </div>

      {!prediction ? (
        <div className="feed-empty">Calculando escenarios…</div>
      ) : (
        <>
          <div className="sc-grid">
            <ScenarioBox s={prediction.bear} />
            <ScenarioBox s={prediction.base} />
            <ScenarioBox s={prediction.bull} />
          </div>

          <div className="pred-summary">
            <div className="pred-summary-head">
              Resumen del agente
              <span className="pred-conf">
                confianza {prediction.confidence}% · señales {prediction.score}/100 ·{" "}
                {prediction.active}/6 sub-agentes
              </span>
            </div>
            <p>{prediction.summary}</p>
            {prediction.caveat && <div className="pred-caveat">⚠ {prediction.caveat}</div>}
          </div>

          {topFlows.length > 0 && (
            <div>
              <div className="news-head">Top 3 flows notables</div>
              <div className="tf-list">
                {topFlows.slice(0, 3).map((f) => {
                  const alcista =
                    (f.type === "call" && f.aggression === "ask") ||
                    (f.type === "put" && f.aggression === "bid");
                  return (
                    <div key={f.id} className="tf-row">
                      <span className={`pill ${f.type === "call" ? "call" : "put"}`}>
                        {f.type === "call" ? "CALL" : "PUT"}
                      </span>
                      <div className="tf-body">
                        <div className="tf-title">
                          ${f.strike != null ? px.format(f.strike) : "?"}
                          <span className="muted">
                            {" "}· vence {f.expiration ?? "—"}
                            {f.dte != null && ` (${f.dte}d)`}
                          </span>
                        </div>
                        <div className="tf-sub">
                          {f.aggression === "ask" ? "Compra agresiva al ask" :
                            f.aggression === "bid" ? "Venta al bid" : "Ejecutado al medio"}
                          {" · "}
                          <b style={{ color: alcista ? "#027a48" : "#d92d20" }}>
                            {alcista ? "apuesta alcista" : "apuesta bajista"}
                          </b>
                        </div>
                      </div>
                      <div className="tf-prem">{money.format(f.premium)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
