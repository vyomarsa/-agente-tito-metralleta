"use client";

import { useMemo } from "react";
import type { FlowRow } from "@/lib/flow";
import { dateET, int, money } from "../format";

/**
 * Unusual Options Activity — premium notable por día: verde = calls (apuestas al alza),
 * rojo = puts (apuestas a la baja). Datos reales de las transacciones revisadas (30 días).
 */
export default function ActivityCard({ rows, unusualCount }: { rows: FlowRow[]; unusualCount: number }) {
  const days = useMemo(() => {
    const byDay = new Map<string, { call: number; put: number }>();
    for (const r of rows) {
      const d = dateET(r.timestamp);
      if (!d) continue;
      const e = byDay.get(d) ?? { call: 0, put: 0 };
      if (r.type === "call") e.call += r.premium;
      else if (r.type === "put") e.put += r.premium;
      byDay.set(d, e);
    }
    // dateET da "Jul 23" — ordenar por el timestamp real del primer trade de cada día
    const firstTs = new Map<string, number>();
    for (const r of rows) {
      const d = dateET(r.timestamp);
      const t = Date.parse(r.timestamp);
      if (!firstTs.has(d) || t < firstTs.get(d)!) firstTs.set(d, t);
    }
    return [...byDay.entries()]
      .sort((a, b) => (firstTs.get(a[0]) ?? 0) - (firstTs.get(b[0]) ?? 0))
      .slice(-7)
      .map(([day, v]) => ({ day, ...v }));
  }, [rows]);

  const maxV = Math.max(1, ...days.map((d) => Math.max(d.call, d.put)));
  const today = days[days.length - 1];

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="card-title">Unusual Options Activity</div>
          <div className="card-sub">
            Dinero grande detectado cada día. Verde = apuestas a que sube (calls),
            rojo = a que baja (puts).
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span className="legend-dot" style={{ background: "#12b76a" }} />Calls</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span className="legend-dot" style={{ background: "#f97066" }} />Puts</div>
        </div>
      </div>

      <div className="act-bars">
        {days.map((d) => (
          <div key={d.day} className="act-col">
            <div className="act-pair" title={`${d.day}: Calls ${money.format(d.call)} · Puts ${money.format(d.put)}`}>
              <div className="act-bar" style={{ background: "#12b76a", height: `${Math.max(3, Math.round((d.call / maxV) * 150))}px` }} />
              <div className="act-bar" style={{ background: "#f97066", height: `${Math.max(3, Math.round((d.put / maxV) * 150))}px` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="act-days">
        {days.map((d, i) => (
          <div key={d.day} className="act-day">{i === days.length - 1 ? "Hoy" : d.day}</div>
        ))}
      </div>

      <div className="act-stats">
        <div>
          <div className="act-stat-label">Premium en calls (últ. día)</div>
          <div className="act-stat-value" style={{ color: "#12b76a" }}>{today ? money.format(today.call) : "—"}</div>
        </div>
        <div>
          <div className="act-stat-label">Premium en puts (últ. día)</div>
          <div className="act-stat-value" style={{ color: "#f04438" }}>{today ? money.format(today.put) : "—"}</div>
        </div>
        <div>
          <div className="act-stat-label">Trades inusuales detectados</div>
          <div className="act-stat-value">{int.format(unusualCount)}</div>
        </div>
      </div>
    </section>
  );
}
