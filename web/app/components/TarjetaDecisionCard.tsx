"use client";

// Tarjeta de Decisión visual (framework The Scout / FLOW). Renderiza el struct
// que produce `lib/decisionCard.ts` con el sistema de diseño de la app (tokens de
// globals.css). No calcula nada: solo presenta el go/no-go.

import type { DecisionCard, Decision, Bias, Setup, ConfluenceFactor } from "@/lib/decisionCard";

const CSS_VAR = (v: string) => `var(${v})`;

function decisionColor(d: Decision): string {
  if (d === "EJECUTAR") return CSS_VAR("--green");
  if (d === "ESPERAR TRIGGER") return CSS_VAR("--amber");
  return CSS_VAR("--red");
}
function decisionDot(d: Decision): string {
  return d === "EJECUTAR" ? "🟢" : d === "ESPERAR TRIGGER" ? "🟡" : "🔴";
}
function biasColor(b: Bias): string {
  if (b === "ALCISTA") return CSS_VAR("--green");
  if (b === "BAJISTA") return CSS_VAR("--red");
  return CSS_VAR("--muted");
}
function setupColor(s: Setup): string {
  if (s === "A") return CSS_VAR("--green");
  if (s === "B") return CSS_VAR("--amber");
  return CSS_VAR("--red");
}
function factorColor(f: ConfluenceFactor): string {
  if (f.status === "ok") return CSS_VAR("--green");
  if (f.status === "partial") return CSS_VAR("--amber");
  if (f.status === "fail") return CSS_VAR("--red");
  return CSS_VAR("--muted");
}

const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
const price = (n: number | null) => (n == null ? "—" : n.toFixed(2));
const stampFmt = (iso: string) => {
  try { return new Date(iso).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return iso; }
};

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 8, background: "var(--track)", borderRadius: 4, overflow: "hidden", flex: 1 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: color, borderRadius: 4 }} />
    </div>
  );
}

export default function TarjetaDecisionCard({ card }: { card: DecisionCard }) {
  const dCol = decisionColor(card.decision);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* HERO */}
      <div className="card" style={{ borderLeft: `6px solid ${dCol}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" }}>{card.ticker}</span>
              <span style={{ color: "var(--muted)", fontSize: 13 }}>{card.company}</span>
            </div>
            <div style={{ fontFamily: "var(--mono, monospace)", fontSize: 26, fontWeight: 700, marginTop: 4 }}>
              {card.spot.toFixed(2)}
            </div>
            <div style={{ color: "var(--faint)", fontSize: 11, marginTop: 4 }}>{stampFmt(card.stamp)}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end", textAlign: "right" }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: biasColor(card.bias) }}>● BIAS: {card.bias}</span>
            <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 800, fontSize: 13, background: setupColor(card.setup), color: "#0b0f1a", padding: "4px 12px", borderRadius: 8 }}>
              SETUP {card.setup}
            </span>
            <span style={{ fontSize: 15, fontWeight: 800, color: dCol }}>
              {decisionDot(card.decision)} {card.decision}
            </span>
            <span style={{ color: "var(--faint)", fontSize: 11, maxWidth: 260 }}>{card.decisionNote}</span>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>Confianza {Math.round(card.confidence)}%</span>
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* PLAN CONDICIONAL */}
        <div className="card">
          <div className="card-title">Plan condicional</div>
          <table style={{ width: "100%", fontSize: 13.5, borderCollapse: "collapse" }}>
            <tbody>
              {[
                ["Trigger", card.plan.trigger, "var(--amber)"],
                ["Entrada (ref)", price(card.plan.entry), "var(--text)"],
                ["Invalidación", price(card.plan.invalidation), "var(--red)"],
                ["Target 1", price(card.plan.t1), "var(--green)"],
                ["Target 2", price(card.plan.t2), "var(--green)"],
              ].map(([k, v, col]) => (
                <tr key={k as string} style={{ borderTop: "1px solid var(--border-soft)" }}>
                  <td style={{ color: "var(--muted)", padding: "8px 0", fontWeight: 600 }}>{k}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--mono, monospace)", fontWeight: 700, color: col as string }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--muted)" }}>
            <span>R:R a T1 <b style={{ color: "var(--text)" }}>{card.plan.rr1 ?? "—"}</b></span>
            <span>R:R a T2 <b style={{ color: "var(--text)" }}>{card.plan.rr2 ?? "—"}</b></span>
            <span>Espacio a T2 <b style={{ color: "var(--text)" }}>{card.plan.roomPct != null ? `${card.plan.roomPct}%` : "—"}</b></span>
          </div>
          <p style={{ marginTop: 10, fontSize: 12, color: "var(--faint)" }}>{card.plan.riesgo}</p>
        </div>

        {/* RÉGIMEN GEX + GAMMA LADDER */}
        <div className="card">
          <div className="card-title">Régimen GEX y gamma ladder</div>
          <p style={{ fontSize: 13, color: "var(--text)", margin: "0 0 8px" }}>{card.gexRegimeText}</p>
          {card.ivRank != null && (
            <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 12px" }}>
              🌡️ {card.ivNote} <span style={{ color: "var(--green)", fontWeight: 700 }}>· Tastytrade</span>
            </p>
          )}
          {card.gammaLadder.length === 0 ? (
            <p className="na" style={{ fontSize: 12 }}>Sin nodos de gamma disponibles.</p>
          ) : (
            card.gammaLadder.map((g) => {
              const max = Math.max(...card.gammaLadder.map((x) => x.gamma)) || 1;
              return (
                <div key={g.strike} style={{ display: "grid", gridTemplateColumns: "56px 1fr auto", gap: 8, alignItems: "center", marginBottom: 7, fontSize: 12 }}>
                  <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 700, textAlign: "right", color: g.isWall ? "var(--red)" : "var(--muted)" }}>{g.strike}{g.isWall ? " ◄" : ""}</span>
                  <Bar pct={(g.gamma / max) * 100} color={g.isWall ? "var(--red)" : "var(--accent)"} />
                  <span style={{ fontFamily: "var(--mono, monospace)", color: "var(--muted)", fontSize: 11 }}>{money(g.gamma)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* SCORECARD DE CONFLUENCIA */}
      <div className="card">
        <div className="card-title">
          Scorecard de confluencia <span style={{ color: "var(--faint)", fontWeight: 500, fontSize: 12 }}>· 0–14 · A≥11 · B 8–10 · C≤7</span>
        </div>
        {card.factors.map((f) => (
          <div key={f.key} style={{ display: "grid", gridTemplateColumns: "1fr 120px 30px", gap: 10, alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--border-soft)" }}>
            <div>
              <div style={{ fontSize: 13 }}>{f.label}</div>
              <div style={{ fontSize: 11, color: "var(--faint)" }}>{f.why}</div>
            </div>
            <Bar pct={(f.points / 2) * 100} color={factorColor(f)} />
            <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 700, textAlign: "right", color: factorColor(f) }}>{f.points}</span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: "2px solid var(--border)", fontWeight: 700 }}>
          <span>TOTAL · Setup {card.setup}</span>
          <span style={{ fontFamily: "var(--mono, monospace)", fontSize: 20, color: setupColor(card.setup) }}>{card.scoreTotal} / 14</span>
        </div>
      </div>

      {/* FLOW TAPE */}
      {card.flowTape.length > 0 && (
        <div className="card">
          <div className="card-title">Institutional Flow Tape <span style={{ color: "var(--faint)", fontWeight: 500, fontSize: 12 }}>· prints reales · MarketSnack</span></div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                  <th style={{ padding: "6px 8px" }}>Contrato</th><th style={{ padding: "6px 8px" }}>Lado</th>
                  <th style={{ padding: "6px 8px" }}>Tamaño</th><th style={{ padding: "6px 8px" }}>Premium</th><th style={{ padding: "6px 8px" }}>Sesgo</th>
                </tr>
              </thead>
              <tbody style={{ fontFamily: "var(--mono, monospace)" }}>
                {card.flowTape.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "7px 8px" }}>{r.contract}</td>
                    <td style={{ padding: "7px 8px", fontWeight: 700, color: r.side === "BUY" ? "var(--green)" : r.side === "SELL" ? "var(--red)" : "var(--muted)" }}>{r.side}</td>
                    <td style={{ padding: "7px 8px" }}>{r.size}</td>
                    <td style={{ padding: "7px 8px" }}>{money(r.premium)}</td>
                    <td style={{ padding: "7px 8px" }}>
                      <span style={{ fontFamily: "var(--sans, sans-serif)", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 5, background: r.sentiment === "bull" ? "var(--green-bg)" : r.sentiment === "bear" ? "var(--red-bg)" : "var(--chip-bg)", color: r.sentiment === "bull" ? "var(--green)" : r.sentiment === "bear" ? "var(--red)" : "var(--muted)" }}>
                        {r.sentiment === "bull" ? "alcista" : r.sentiment === "bear" ? "bajista" : "neutral"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* READOUT ¿PUEDO TOMAR POSICIÓN? */}
      <div className="card">
        <div className="card-title">¿Puedo tomar posición?</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[
            { n: "SÍ — si…", body: card.readout.si, border: "var(--green)" },
            { n: "ESPERA — si…", body: card.readout.espera, border: "var(--amber)" },
            { n: "NO — si…", body: card.readout.no, border: "var(--red)" },
          ].map((s) => (
            <div key={s.n} style={{ background: "var(--panel-2)", border: `1px solid ${s.border}`, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontFamily: "var(--mono, monospace)", fontWeight: 800, color: s.border, fontSize: 13 }}>{s.n}</div>
              <div style={{ fontWeight: 700, fontSize: 13, margin: "4px 0 3px" }}>{s.body.title}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.45 }}>{s.body.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* AVISOS: degradaciones + datos faltantes */}
      {(card.degradations.length > 0 || card.missingData.length > 0) && (
        <div className="card">
          {card.missingData.length > 0 && (
            <p style={{ fontSize: 12, color: "var(--amber-text, var(--amber))", margin: "0 0 6px" }}>
              <b>DATO NO DISPONIBLE:</b> {card.missingData.join(" · ")} — la confianza baja en consecuencia.
            </p>
          )}
          {card.degradations.map((d, i) => (
            <p key={i} style={{ fontSize: 12, color: "var(--muted)", margin: "2px 0" }}>⚠ {d}</p>
          ))}
        </div>
      )}

      <p style={{ fontSize: 11, color: "var(--faint)", textAlign: "center", lineHeight: 1.6, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
        Análisis educativo estructurado (framework The Scout) sobre datos de MarketSnack/Massive/Schwab. No es asesoría
        de inversión ni una orden de compra/venta. La IA estructura evidencia; la decisión final y el riesgo son tuyos.
      </p>
    </div>
  );
}
