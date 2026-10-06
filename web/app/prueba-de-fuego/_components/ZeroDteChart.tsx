"use client";

// Chart de velas de SPX con los niveles del agente dibujados como líneas
// horizontales: violeta = strikes de mayor volumen (call/put), gris = imán del
// GEX, naranja = flip gamma, amarillo = target de cierre, azul punteado =
// precio actual. Barras desde /api/0dte/bars (Schwab pricehistory).

import { useEffect, useState } from "react";

interface Bar { time: number; open: number; high: number; low: number; close: number; }

interface Level {
  price: number;
  color: string;
  bg: string;
  text: string;
  label: string;
  dashed?: boolean;
  width?: number;
}

export default function ZeroDteChart({
  ticker,
  reloadKey,
  maxCall,
  maxPut,
  magnet,
  flip,
  target,
  spot,
}: {
  ticker: string;
  reloadKey?: string;
  maxCall: number | null;
  maxPut: number | null;
  magnet: number | null;
  flip: number | null;
  target: number | null;
  spot: number | null;
}) {
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/pdf/0dte/bars?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) setErr(j.error);
        setBars(Array.isArray(j.bars) ? j.bars : []);
      })
      .catch(() => alive && setBars([]));
    return () => { alive = false; };
  }, [ticker, reloadKey]);

  const levels: Level[] = [];
  const add = (price: number | null, color: string, bg: string, text: string, label: string, extra: Partial<Level> = {}) => {
    if (price != null) levels.push({ price, color, bg, text, label, ...extra });
  };
  add(maxCall, "#7c3aed", "#f3eefe", "#5b21b6", `Muro Call ${maxCall} · máx vol`);
  add(maxPut, "#7c3aed", "#f3eefe", "#5b21b6", `Muro Put ${maxPut} · máx vol`);
  add(magnet, "#6b7280", "#f1f2f4", "#374151", `🧲 Imán ${magnet}`);
  add(flip, "#ea580c", "#ffedd5", "#9a3412", `Flip gamma ${flip}`);
  add(target, "#eab308", "#fef3c7", "#92400e", `Target cierre ${target}`, { width: 2.5 });
  add(spot, "#2f6bff", "#e6efff", "#1d4ed8", `Precio ${spot?.toFixed(2)}`, { dashed: true, width: 1.5 });

  const W = 720, H = 360;
  const top = 18, bottom = H - 22;
  const chartL = 8, gutter = 178, chartR = W - gutter;

  if (bars == null) return <div className="z-chart-msg">Cargando gráfica…</div>;
  if (bars.length === 0) {
    return (
      <div className="z-chart-msg">
        {err ? `Sin gráfica: ${err}` : "Sin barras (mercado cerrado o sin sesión hoy)."}
      </div>
    );
  }

  const prices = [...bars.flatMap((b) => [b.high, b.low]), ...levels.map((l) => l.price)];
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  const pad = (max - min) * 0.04 || 1;
  min -= pad; max += pad;

  const y = (p: number) => top + ((max - p) / (max - min)) * (bottom - top);
  const n = bars.length;
  const step = (chartR - chartL) / Math.max(1, n);
  const bw = Math.max(1.5, Math.min(9, step * 0.62));
  const cx = (i: number) => chartL + step * (i + 0.5);

  // Anti-colisión simple de etiquetas: ordena por y y separa 18px mínimo.
  const labelYs = levels.map((l, i) => ({ i, y: y(l.price) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < labelYs.length; k++) {
    if (labelYs[k].y - labelYs[k - 1].y < 18) labelYs[k].y = labelYs[k - 1].y + 18;
  }
  const labelYof = new Map(labelYs.map((o) => [o.i, o.y]));
  const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);

  return (
    <div className="z-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Chart de ${ticker} con niveles del agente`}>
        <rect x="0" y="0" width={W} height={H} fill="var(--panel)" />
        {ticks.map((p, i) => (
          <g key={i}>
            <line x1={chartL} y1={y(p)} x2={chartR} y2={y(p)} stroke="var(--border-soft)" strokeWidth="1" />
            <text x={chartL} y={y(p) - 3} fill="var(--faint)" fontSize="9">{p.toFixed(0)}</text>
          </g>
        ))}

        {bars.map((b, i) => {
          const up = b.close >= b.open;
          const col = up ? "#12b76a" : "#f04438";
          const bodyTop = y(Math.max(b.open, b.close));
          const bodyBot = y(Math.min(b.open, b.close));
          return (
            <g key={i}>
              <line x1={cx(i)} x2={cx(i)} y1={y(b.high)} y2={y(b.low)} stroke={col} strokeWidth="1" />
              <rect x={cx(i) - bw / 2} y={bodyTop} width={bw} height={Math.max(1, bodyBot - bodyTop)} fill={col} />
            </g>
          );
        })}

        {levels.map((l, i) => (
          <g key={i}>
            <line
              x1={chartL} y1={y(l.price)} x2={chartR} y2={y(l.price)}
              stroke={l.color} strokeWidth={l.width ?? 2}
              strokeDasharray={l.dashed ? "2 3" : "6 4"}
            />
            <rect x={chartR + 6} y={(labelYof.get(i) ?? y(l.price)) - 9} width={gutter - 12} height="18" rx="4" fill={l.bg} />
            <text x={chartR + 12} y={(labelYof.get(i) ?? y(l.price)) + 4} fill={l.text} fontSize="10.5">{l.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
