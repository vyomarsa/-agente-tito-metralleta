"use client";

export interface SentimentPart {
  name: string;
  note: string;
  score: number | null; // 0-10, null = pendiente
  weight: number;
}

function colorFor(score100: number): string {
  return score100 >= 60 ? "#12b76a" : score100 >= 45 ? "#667085" : "#f04438";
}

/**
 * AI Sentiment Score: los promedios de las tablas de cada sub-agente,
 * ponderados por su peso del scorecard, escalados a 0-100.
 */
export default function SentimentCard({ ticker, parts }: { ticker: string; parts: SentimentPart[] }) {
  const active = parts.filter((p) => p.score != null);
  const activeWeight = active.reduce((s, p) => s + p.weight, 0);
  const pts = active.reduce((s, p) => s + (p.score! / 10) * p.weight, 0);
  const score = activeWeight > 0 ? Math.round((pts / activeWeight) * 100) : 0;
  const scoreColor = colorFor(score);
  const scoreLabel = score >= 60 ? "Bullish" : score >= 45 ? "Neutral" : "Bearish";

  return (
    <section className="card">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div className="card-title">AI Sentiment Score</div>
          <div className="card-sub">
            Qué tan positivo o negativo se ve el mercado para {ticker} ahora mismo, de 0 a 100.
            {active.length < parts.length && <> Basado en {active.length} de {parts.length} señales.</>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="sent-score" style={{ color: scoreColor }}>{score}</div>
          <div className="sent-label" style={{ color: scoreColor }}>{scoreLabel}</div>
        </div>
      </div>

      <div>
        <div style={{ position: "relative", paddingTop: 10 }}>
          <div className="sent-marker" style={{ left: `${score}%` }} />
          <div className="sent-band">
            <div style={{ borderRadius: "6px 2px 2px 6px", background: "#f97066" }} />
            <div style={{ background: "#d9a0a0" }} />
            <div style={{ background: "#d0d5dd" }} />
            <div style={{ background: "#9adbb9" }} />
            <div style={{ borderRadius: "2px 6px 6px 2px", background: "#32d583" }} />
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
          <div>Bearish</div><div>Neutral</div><div>Bullish</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <div className="sent-head-label">Desglose por señal (promedios de cada sub-agente)</div>
        {parts.map((p) => {
          const s100 = p.score != null ? p.score * 10 : null;
          const c = s100 != null ? colorFor(s100) : "#d0d5dd";
          return (
            <div key={p.name} className="sent-part">
              <div>
                <div className="sent-part-name">{p.name}</div>
                <div className="sent-part-note">{p.note}</div>
              </div>
              <div className="sent-track">
                <div className="sent-fill" style={{ width: `${s100 ?? 0}%`, background: c }} />
              </div>
              <div className="sent-part-score" style={{ color: c }}>{s100 != null ? s100 : "—"}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
