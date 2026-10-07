"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExtendedScan } from "@/lib/pdf/premarketMovers";

// Pestaña "Pre-market" (pedido del dueño, 2026-10-07): en pantalla, lo mismo que
// la alerta de Telegram de las 9:15/9:30 ET — las empresas del S&P 500 que más se
// mueven en la sesión extendida contra el cierre regular anterior. Mismo cálculo
// (lib/pdf/premarketMovers.ts): MarketSnack primero, Tastytrade de respaldo.
// Fuera de pre-market enseña el after-hours si MarketSnack lo trae.

const REFRESH_MS = 5 * 60_000;
const THRESHOLDS = [2, 3, 5, 10];
const DEFAULT_THRESHOLD = 5;

const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-ES", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

export default function PremarketTab() {
  const [data, setData] = useState<ExtendedScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);

  const load = useCallback(async (fresh: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/pdf/premarket${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j as ExtendedScan);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const movers = useMemo(
    () => (data?.moves ?? []).filter((m) => Math.abs(m.pct) >= threshold),
    [data, threshold],
  );
  const up = movers.filter((m) => m.pct > 0);
  const down = movers.filter((m) => m.pct < 0);

  const sessionLabel =
    data?.session === "After hours" ? "after-hours" : data?.session === "Pre-market" ? "pre-market" : "sesión extendida";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Pre-market · S&amp;P 500</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              {data
                ? <>Fuente <b>{data.source}</b> · {sessionLabel} · {data.moves.length} empresas con dato
                    {data.skipped > 0 ? ` (${data.skipped} sin dato)` : ""} · {fmtTime(data.asOf)} ET</>
                : "Cargando…"}
            </div>
          </div>
          <button className="rescan" onClick={() => void load(true)} disabled={busy} style={{ margin: 0 }}>
            {busy ? "Escaneando…" : "Actualizar"}
          </button>
        </div>

        <div className="view-toggle" style={{ alignSelf: "flex-start" }}>
          {THRESHOLDS.map((t) => (
            <button key={t} className={threshold === t ? "active" : ""} onClick={() => setThreshold(t)}>
              ±{t}%
            </button>
          ))}
        </div>

        <p className="muted" style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>
          Movimiento contra el cierre regular anterior. La alerta de Telegram avisa de los de ±5% a las 9:15
          y 9:30 ET. En el pre-market temprano un movimiento grande puede ser una sola operación con poco
          volumen: se confirma mejor cerca de la apertura. Se actualiza sola cada 5 min.
        </p>
      </div>

      {error && <div className="card wheel-empty">⚠ {error}</div>}

      {data && !error && data.moves.length === 0 && (
        <div className="card wheel-empty">
          Ahora no hay sesión extendida (pre-market 4:00–9:30 ET, after-hours 16:00–20:00 ET).
        </div>
      )}

      {data && data.moves.length > 0 && movers.length === 0 && (
        <div className="card wheel-empty">Ninguna empresa del S&amp;P 500 se mueve ±{threshold}% ahora mismo.</div>
      )}

      {movers.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          {[
            { title: `Suben (${up.length})`, list: up, color: "var(--green)" },
            { title: `Bajan (${down.length})`, list: down, color: "var(--red)" },
          ].map((col) => (
            <div key={col.title} className="card" style={{ gap: 6 }}>
              <div style={{ fontWeight: 600, color: col.color }}>{col.title}</div>
              {col.list.length === 0 && <div className="muted" style={{ fontSize: 13 }}>—</div>}
              {col.list.map((m) => (
                <div
                  key={m.ticker}
                  style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, padding: "4px 0", borderTop: "1px solid var(--border-soft)" }}
                >
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <b>{m.ticker}</b> <span className="muted">{m.name}</span>
                  </span>
                  <span style={{ whiteSpace: "nowrap" }}>
                    {m.price != null && <span className="muted">${m.price.toFixed(2)} · </span>}
                    <b style={{ color: col.color }}>{fmtPct(m.pct)}</b>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
