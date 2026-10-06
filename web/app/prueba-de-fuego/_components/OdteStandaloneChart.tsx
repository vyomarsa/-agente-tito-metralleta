"use client";

// Chart de velas del subyacente con los niveles del agente dibujados como
// líneas horizontales: violeta = strikes de mayor volumen (call/put), gris =
// imán del GEX, amarillo = target de cierre, azul punteado = precio actual.
// Barras desde /api/0dte/bars (Schwab pricehistory). Ver Proceso 0DTE.

import { useEffect, useState } from "react";
import type { Lang } from "@/lib/pdf/odteStandalone/i18n";

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
  basis = 0,
  lang = "en",
}: {
  ticker: string;
  reloadKey?: string;
  maxCall: number | null;
  maxPut: number | null;
  magnet: number | null;
  flip: number | null;
  target: number | null;
  spot: number | null;
  basis?: number;
  lang?: Lang;
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

  // En futuros (/ES, /NQ) los niveles y las velas se muestran en el precio del
  // futuro: índice + basis, al tick de 0.25. Con basis 0 es identidad.
  const cv = (v: number | null) => (v == null ? null : Math.round((v + basis) * 4) / 4);
  const levels: Level[] = [];
  const add = (price: number | null, color: string, bg: string, text: string, label: string, extra: Partial<Level> = {}) => {
    if (price != null) levels.push({ price, color, bg, text, label, ...extra });
  };
  const L = lang === "es"
    ? { call: "Muro Call", put: "Muro Put", maxVol: "máx vol", magnet: "🧲 Imán", flip: "Flip gamma", target: "Target cierre", price: "Precio" }
    : { call: "Call Wall", put: "Put Wall", maxVol: "max vol", magnet: "🧲 Magnet", flip: "Gamma flip", target: "Close target", price: "Price" };
  add(cv(maxCall), "#7c3aed", "#f3eefe", "#5b21b6", `${L.call} ${cv(maxCall)} · ${L.maxVol}`);
  add(cv(maxPut), "#7c3aed", "#f3eefe", "#5b21b6", `${L.put} ${cv(maxPut)} · ${L.maxVol}`);
  add(cv(magnet), "#6b7280", "#f1f2f4", "#374151", `${L.magnet} ${cv(magnet)}`);
  add(cv(flip), "#ea580c", "#ffedd5", "#9a3412", `${L.flip} ${cv(flip)}`);
  add(cv(target), "#eab308", "#fef3c7", "#92400e", `${L.target} ${cv(target)}`, { width: 2.5 });
  add(cv(spot), "#2f6bff", "#e6efff", "#1d4ed8", `${L.price} ${cv(spot)?.toFixed(2)}`, { dashed: true, width: 1.5 });

  // ---- geometría ----
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

  // Las velas de FUTUROS (/ES, /NQ) vienen del ÍNDICE (SPX/NDX), pero los niveles y
  // el spot son del futuro nativo. Se alinean desplazando las velas por el basis
  // VIVO = spot(futuro) − último cierre del índice (que ≈ spot del índice). En
  // índices/ETF el basis es 0 y las velas no se tocan.
  const isFut = ticker.trim().startsWith("/");
  const lastClose = bars[bars.length - 1].close;
  const barShift = basis || (isFut && spot != null ? spot - lastClose : 0);
  const dBars = barShift
    ? bars.map((b) => ({ ...b, open: b.open + barShift, high: b.high + barShift, low: b.low + barShift, close: b.close + barShift }))
    : bars;

  const prices = [
    ...dBars.flatMap((b) => [b.high, b.low]),
    ...levels.map((l) => l.price),
  ];
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  const pad = (max - min) * 0.04 || 1;
  min -= pad; max += pad;

  const y = (p: number) => top + ((max - p) / (max - min)) * (bottom - top);
  const n = dBars.length;
  const step = (chartR - chartL) / Math.max(1, n);
  const bw = Math.max(1.5, Math.min(9, step * 0.62));
  const cx = (i: number) => chartL + step * (i + 0.5);

  // Anti-colisión simple de etiquetas: ordena por y y separa 18px mínimo.
  const labelYs = levels
    .map((l, i) => ({ i, y: y(l.price) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < labelYs.length; k++) {
    if (labelYs[k].y - labelYs[k - 1].y < 18) labelYs[k].y = labelYs[k - 1].y + 18;
  }
  const labelYof = new Map(labelYs.map((o) => [o.i, o.y]));

  // Rótulos de precio del eje (5 niveles).
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

        {dBars.map((b, i) => {
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
