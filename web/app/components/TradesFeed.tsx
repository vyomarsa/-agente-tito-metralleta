"use client";

import { useState } from "react";
import type { UnusualRow } from "./UnusualityCard";
import RepeatBadge, { buildRepeatCounts, repeatKey } from "./RepeatBadge";
import { int, money, px, timeET } from "../format";

const GRID = "70px 1.9fr 70px 80px 95px 1.5fr 80px";

function contractLabel(r: UnusualRow): string {
  const t = r.type === "call" ? "Call" : r.type === "put" ? "Put" : "?";
  const exp = r.expiration ?? "—";
  const dte = r.dte != null ? ` (${r.dte}d)` : "";
  return `${r.underlying} $${r.strike != null ? px.format(r.strike) : "?"} ${t} · ${exp}${dte}`;
}

function signalFor(r: UnusualRow): string {
  const s: string[] = [];
  if (r.aggression === "ask") s.push("Compra agresiva al ask");
  else if (r.aggression === "bid") s.push("Venta al bid");
  if (r.flags.exceededOI) s.push("vol > interés abierto");
  if (r.flags.repeated) s.push("comprador repetido");
  if (r.flags.multileg) s.push("estrategia combinada");
  else if (r.flags.leap) s.push("apuesta a largo plazo");
  if (s.length === 0) s.push(r.conditionName ?? "Ticket notable");
  return s.slice(0, 2).join(" · ");
}

/**
 * Feed de trades inusuales + pestaña de predicciones (se activa con Prediction Pro).
 * El Score /100 sale del puntaje de Inusualidad de cada trade (promedio de griegos ×10).
 */
export default function TradesFeed({ rows }: { rows: UnusualRow[] }) {
  const [tab, setTab] = useState<"trades" | "preds">("trades");
  const top = rows.slice(0, 8);
  const repeatCounts = buildRepeatCounts(rows);

  return (
    <section className="card">
      <div className="feed-tabs">
        <button type="button" className={`hb-tab ${tab === "trades" ? "on" : ""}`} onClick={() => setTab("trades")}>
          Unusual Trades Feed
        </button>
        <button type="button" className={`hb-tab ${tab === "preds" ? "on" : ""}`} onClick={() => setTab("preds")}>
          Agent Predictions &amp; Accuracy
        </button>
      </div>

      {tab === "trades" && (
        <>
          <div className="card-sub">
            Feed de trades de opciones inusualmente grandes — cuando alguien apuesta millones,
            el agente lo marca y puntúa qué tan inusual es.
          </div>
          <div className="feed-head" style={{ gridTemplateColumns: GRID }}>
            <div>Hora</div><div>Contrato</div><div>Tipo</div><div>Contratos</div><div>Premium</div><div>Señal</div><div style={{ textAlign: "right" }}>Score</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {top.map((r) => {
              const score100 = Math.round(r.unusualScores.total * 10);
              const scoreColor = score100 >= 80 ? "#d92d20" : score100 >= 60 ? "#f79009" : "#667085";
              return (
                <div key={r.id} className="feed-row" style={{ gridTemplateColumns: GRID }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>{timeET(r.timestamp).slice(0, 5)}</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {contractLabel(r)}
                    {r.flags.repeated && <RepeatBadge count={repeatCounts.get(repeatKey(r)) ?? 2} />}
                  </div>
                  <div>
                    <span className={`pill ${r.type === "call" ? "call" : "put"}`}>{r.type === "call" ? "CALL" : "PUT"}</span>
                  </div>
                  <div style={{ fontSize: 13 }}>{int.format(r.size)}</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{money.format(r.premium)}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>{signalFor(r)}</div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor }}>{score100}/100</span>
                  </div>
                </div>
              );
            })}
            {top.length === 0 && <div className="feed-empty">Sin trades inusuales todavía — busca un ticker.</div>}
          </div>
        </>
      )}

      {tab === "preds" && (
        <div className="feed-empty">
          📈 <b>Prediction Pro — próximamente.</b><br />
          Aquí verás cada predicción del agente para el ticker y si acertó (hit rate).
          Se activa cuando estén los 6 sub-agentes; los promedios de las tablas de cada
          categoría son los que alimentan la predicción.
        </div>
      )}
    </section>
  );
}
