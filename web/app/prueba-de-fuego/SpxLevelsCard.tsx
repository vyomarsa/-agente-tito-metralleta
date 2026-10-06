"use client";

import { useCallback, useEffect, useState } from "react";
import type { SpxLevelRow, TopVolumeContract } from "@/lib/pdf/spxLevels";
import type { SpxLevelsResponse } from "./types";

const SPX_LEVELS_POLL_MS = 60_000;

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtGex(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "+";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000_000).toFixed(0)}M`;
  return `${sign}${abs.toFixed(0)}`;
}

function askPct(summary: { askPremium: number; bidPremium: number } | null): string {
  if (!summary) return "—";
  const total = summary.askPremium + summary.bidPremium;
  if (total <= 0) return "—";
  return `${Math.round((summary.askPremium / total) * 100)}%`;
}

function badgeLabel(badge: SpxLevelRow["badge"]): string | null {
  if (badge === "call_wall") return "🧱 Call Wall";
  if (badge === "put_wall") return "🧱 Put Wall";
  return null;
}

function LevelRow({ row }: { row: SpxLevelRow }) {
  const badge = badgeLabel(row.badge);
  return (
    <tr>
      <td style={{ padding: "6px 10px", textAlign: "right", color: "#f04438" }}>
        {row.put ? `${fmtMoney(row.put.netPremium)} ${askPct(row.put)}` : "—"}
      </td>
      <td style={{ padding: "6px 10px", textAlign: "center", fontWeight: 700 }}>{row.strike}</td>
      <td style={{ padding: "6px 10px", textAlign: "left", color: "#12b76a" }}>
        {row.call ? `${fmtMoney(row.call.netPremium)} ${askPct(row.call)}` : "—"}
      </td>
      <td style={{ padding: "6px 10px", textAlign: "right", color: row.netGex >= 0 ? "#12b76a" : "#f04438" }}>
        {fmtGex(row.netGex)}
        {badge && <div style={{ fontSize: 11, color: "var(--muted)" }}>{badge}</div>}
      </td>
      <td style={{ padding: "6px 10px", fontSize: 12 }}>
        {row.conflict ? "⚠ " : row.confluence ? "⭐ " : ""}
        {row.lectura}
      </td>
    </tr>
  );
}

function sideLabel(side: TopVolumeContract["dominantSideHere"]): string {
  if (side === "call") return "🟢 calls dominan";
  if (side === "put") return "🔴 puts dominan";
  return "— parejo";
}

function TopVolumeTable({ title, rows, color }: { title: string; rows: TopVolumeContract[]; color: string }) {
  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, color }}>{title}</div>
      {rows.length === 0 ? (
        <div className="wheel-empty" style={{ fontSize: 12 }}>Sin datos todavía.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--muted)", fontSize: 11 }}>
              <th style={{ padding: "3px 8px", textAlign: "center" }}>Strike</th>
              <th style={{ padding: "3px 8px", textAlign: "right" }}>Volumen</th>
              <th style={{ padding: "3px 8px", textAlign: "right" }}>Net premium</th>
              <th style={{ padding: "3px 8px", textAlign: "left" }}>En ese strike</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.type}-${r.strike}`}>
                <td style={{ padding: "3px 8px", textAlign: "center", fontWeight: 600 }}>{r.strike}</td>
                <td style={{ padding: "3px 8px", textAlign: "right" }}>{r.volume.toLocaleString()}</td>
                <td style={{ padding: "3px 8px", textAlign: "right", color: r.netPremium >= 0 ? "#12b76a" : "#f04438" }}>
                  {fmtMoney(r.netPremium)}
                </td>
                <td style={{ padding: "3px 8px", fontSize: 11 }}>{sideLabel(r.dominantSideHere)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SpxLevelsCard() {
  const [data, setData] = useState<SpxLevelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/pdf/spx-levels")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad response"))))
      .then((body: SpxLevelsResponse) => {
        setData(body);
        setError(null);
      })
      .catch(() => setError("No se pudieron leer los niveles de SPX."));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, SPX_LEVELS_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (error && !data) return <div className="card wheel-empty">⚠ {error}</div>;
  if (!data) return <div className="card wheel-empty">Cargando niveles de SPX…</div>;

  const { spot, expiration, gexStats, rows, topVolume } = data;

  let dividerInserted = false;
  const rowNodes: React.ReactNode[] = [];
  for (const row of rows) {
    if (!dividerInserted && row.strike < spot) {
      dividerInserted = true;
      rowNodes.push(
        <tr key="spot-divider" style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
          <td colSpan={5} style={{ padding: "6px 10px", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
            — spot ${spot.toFixed(2)} —
            {gexStats?.gamma_flip != null && ` · Gamma Flip ≈ $${gexStats.gamma_flip.toFixed(0)}`}
          </td>
        </tr>,
      );
    }
    rowNodes.push(<LevelRow key={row.strike} row={row} />);
  }
  if (!dividerInserted) {
    rowNodes.push(
      <tr key="spot-divider">
        <td colSpan={5} style={{ padding: "6px 10px", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
          — spot ${spot.toFixed(2)} —
        </td>
      </tr>,
    );
  }

  return (
    <div className="card" style={{ gap: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 15 }}>🧲 Soportes y Resistencias en vivo — SPX</div>
      <p className="wheel-disclaimer" style={{ fontSize: 12 }}>
        Spot ${spot.toFixed(2)} · vencimiento {expiration}. Net premium = flujo real de hoy (MarketSnack). GEX =
        posicionamiento de dealers, también real de MarketSnack (no una aproximación). ⭐ = confluencia (los dos
        coinciden) · ⚠ = conflicto (no coinciden). Se refresca solo cada minuto.
      </p>
      {gexStats && (
        <p className="wheel-disclaimer" style={{ fontSize: 12 }}>
          Call Wall ${gexStats.call_wall.toFixed(0)} · Put Wall ${gexStats.put_wall.toFixed(0)} · Magnet $
          {gexStats.magnet.toFixed(0)} · Gamma Flip{" "}
          {gexStats.gamma_flip != null ? `$${gexStats.gamma_flip.toFixed(0)}` : "sin dato todavía"} · Net GEX{" "}
          {fmtGex(gexStats.net_gex)}
        </p>
      )}
      {rows.length === 0 ? (
        <div className="wheel-empty">Sin datos de opciones todavía para hoy.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "var(--muted)", fontSize: 11 }}>
                <th style={{ padding: "4px 10px", textAlign: "right" }}>PUT net (%ask)</th>
                <th style={{ padding: "4px 10px", textAlign: "center" }}>STRIKE</th>
                <th style={{ padding: "4px 10px", textAlign: "left" }}>CALL net (%ask)</th>
                <th style={{ padding: "4px 10px", textAlign: "right" }}>GEX (γ)</th>
                <th style={{ padding: "4px 10px", textAlign: "left" }}>Lectura</th>
              </tr>
            </thead>
            <tbody>{rowNodes}</tbody>
          </table>
        </div>
      )}
      {topVolume && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>📊 Top 10 por volumen — 0DTE</div>
          <p className="wheel-disclaimer" style={{ fontSize: 12, marginBottom: 8 }}>
            Los contratos más operados hoy, informativo — no cambia el contrato ni el target sugerido arriba.
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <TopVolumeTable title="Top 10 Calls" rows={topVolume.calls} color="#12b76a" />
            <TopVolumeTable title="Top 10 Puts" rows={topVolume.puts} color="#f04438" />
          </div>
        </div>
      )}
    </div>
  );
}
