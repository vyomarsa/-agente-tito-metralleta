"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TfBar } from "@/lib/pdf/types";
import type { ConePoint } from "@/lib/pdf/expectedMove";
import { buildScales, packLabels, smartDomain } from "@/lib/pdf/chartGeometry";
import type { Padding } from "@/lib/pdf/chartGeometry";
import ChartCrosshair, { type HoverInfo } from "./ChartCrosshair";
import { useLocale } from "@/lib/pdf/i18n";
import { px } from "../../_format";

/** Una ruta proyectada (escenario). Los puntos van de t=0 al horizonte, equiespaciados. */
export interface ChartSeries {
  key: string;
  points: { price: number }[];
  color: string;
  width?: number;
}

/** Un objetivo con su chip a la derecha. `weight` (0-1) manda en el encuadre y la banda. */
export interface ChartTarget {
  key: string;
  price: number;
  label: string;
  sublabel?: string;
  color: string;
  weight: number;
  /** Pinta además una banda de heatmap a la altura del nivel (vista Pro). */
  bandColor?: string;
}

export interface ChartLevel {
  price: number;
  kind: "soporte" | "resistencia";
  strength: number;
}

/** Un punto YA FORMADO de un conteo (ej. Onda de Elliott) para dibujar sobre el histórico. */
export interface WaveMarker {
  time: number;
  price: number;
  label: string;
  kind: "high" | "low";
}

export interface PriceChartProps {
  bars: TfBar[];
  spot: number;
  horizonDays: number;
  cone?: ConePoint[];
  series?: ChartSeries[];
  targets?: ChartTarget[];
  levels?: ChartLevel[];
  /** Ondas ya formadas (histórico) — se dibujan conectadas con etiquetas sobre las velas. */
  waveMarkers?: WaveMarker[];
  waveMarkerColor?: string;
  theme: "light" | "dark";
  /** Alto del contenedor. Acepta CSS (`clamp(...)`) — el SVG se mide solo. */
  height: number | string;
  /** Trazo progresivo de las series (se dibuja una vez). */
  animate?: boolean;
  /** Dibujar también la banda de 1σ, más marcada que la de 2σ. */
  showCone1?: boolean;
  showSpot?: boolean;
}

interface Tokens {
  grid: string; axis: string; up: string; down: string; wick: string;
  divider: string; nowText: string; futureTint: string;
  cone1: string; cone2: string; spot: string; guide: string;
}

const THEMES: Record<"light" | "dark", Tokens> = {
  light: {
    grid: "#f2f4f7", axis: "#98a2b3",
    up: "#12b76a", down: "#f04438", wick: "#98a2b3",
    divider: "rgba(16,24,40,0.22)", nowText: "#98a2b3",
    futureTint: "rgba(47,107,255,0.028)",
    cone1: "rgba(47,107,255,0.10)", cone2: "rgba(47,107,255,0.05)",
    spot: "rgba(16,24,40,0.35)", guide: "rgba(16,24,40,0.22)",
  },
  dark: {
    grid: "rgba(255,255,255,0.055)", axis: "#5c6a85",
    up: "#e3ecfb", down: "#7f8db0", wick: "#93a5c6",
    divider: "rgba(255,255,255,0.28)", nowText: "#8593ad",
    futureTint: "rgba(245,197,66,0.035)",
    cone1: "rgba(245,197,66,0.16)", cone2: "rgba(245,197,66,0.07)",
    spot: "rgba(255,255,255,0.32)", guide: "rgba(255,255,255,0.26)",
  },
};

/** El `right` es el gutter de los chips — sin él los targets se pisan con el eje. */
const PADDING: Padding = { top: 18, right: 132, bottom: 30, left: 10 };
const CHIP_GAP = 5;

/** Marcas "redondas" del eje de precio. */
function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const mag = Math.pow(10, Math.floor(Math.log10(span / count)));
  const norm = span / count / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

function shortDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Gráfica de precio + proyección, en un solo SVG.
 *
 * Presentacional: recibe todo ya calculado (`conePoints`, `predictionPath`,
 * `levelProbabilities`) y solo lo pinta. Toda la geometría sale de
 * `lib/chartGeometry`, así que aquí no hay ni una cuenta que testear.
 */
export default function PriceChart({
  bars, spot, horizonDays, cone = [], series = [], targets = [], levels = [],
  waveMarkers = [], waveMarkerColor,
  theme, height, animate = false, showCone1 = false, showSpot = true,
}: PriceChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { t: tr } = useLocale();
  const t = THEMES[theme];
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [drawn, setDrawn] = useState(false);
  const { w: width, h: boxH } = size;

  // Un único ResizeObserver: el alto puede venir de CSS (`clamp`), no de un número.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // El trazo progresivo arranca una vez que hay geometría, no en cada resize.
  useEffect(() => {
    if (!animate || width <= 0 || bars.length === 0) return;
    const id = setTimeout(() => setDrawn(true), 220);
    return () => clearTimeout(id);
  }, [animate, width, bars.length]);

  const last = cone.length ? cone[cone.length - 1] : null;

  const domain = useMemo(
    () => smartDomain({
      bars, spot,
      sigma1: last ? { lower: last.lower1, upper: last.upper1 } : undefined,
      sigma2: last ? { lower: last.lower2, upper: last.upper2 } : undefined,
      targets: targets.map((x) => ({ price: x.price, weight: x.weight })),
      levels: levels.map((l) => ({ price: l.price })),
    }),
    [bars, spot, last, targets, levels],
  );

  const scales = useMemo(
    () => buildScales({
      bars, domain, horizonDays, width, height: boxH, padding: PADDING, futureRatio: 0.4,
    }),
    [bars, domain, horizonDays, width, boxH],
  );

  const chipH = targets.some((x) => x.sublabel) ? 34 : 26;
  const chips = useMemo(() => {
    const items = targets.map((x) => ({ ...x, y: scales.yOfPrice(x.price) }));
    if (showSpot && spot > 0) {
      items.push({
        key: "__spot", price: spot, label: tr("chart.now"), sublabel: undefined,
        color: theme === "dark" ? "#8593ad" : "#667085", weight: 0,
        bandColor: undefined, y: scales.yOfPrice(spot),
      });
    }
    return packLabels(items, {
      top: scales.plotTop, bottom: scales.plotBottom, labelH: chipH, gap: CHIP_GAP,
    });
  }, [targets, spot, showSpot, theme, scales, chipH]);

  // Ubica cada onda ya formada sobre la vela histórica más cercana en el tiempo.
  // Las que quedaron fuera de la ventana visible (recortada por ancho legible)
  // se descartan en vez de dibujarse apiladas en el borde izquierdo.
  const waveDots = useMemo(() => {
    const vb = scales.visibleBars;
    if (waveMarkers.length === 0 || vb.length === 0) return [];
    const out: Array<{ x: number; y: number; label: string; kind: "high" | "low" }> = [];
    for (const m of waveMarkers) {
      if (m.time < vb[0].time) continue;
      let lo = 0, hi = vb.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (vb[mid].time < m.time) lo = mid + 1; else hi = mid;
      }
      const idx = lo > 0 && Math.abs(vb[lo - 1].time - m.time) <= Math.abs(vb[lo].time - m.time) ? lo - 1 : lo;
      out.push({ x: scales.xOfIndex(idx), y: scales.yOfPrice(m.price), label: m.label, kind: m.kind });
    }
    return out;
  }, [waveMarkers, scales]);
  const waveColor = waveMarkerColor ?? (theme === "dark" ? "#c9d3ea" : "#475467");

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = hostRef.current;
    if (!el || width <= 0) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < scales.plotLeft || x > scales.plotRight || y < scales.plotTop || y > scales.plotBottom) {
      setHover(null);
      return;
    }
    if (x <= scales.xNow) {
      const n = scales.candles.length;
      const slot = (scales.xNow - scales.plotLeft) / Math.max(1, n);
      const i = Math.min(n - 1, Math.max(0, Math.floor((x - scales.plotLeft) / slot)));
      const c = scales.candles[i];
      if (!c) { setHover(null); return; }
      setHover({ x: c.cx, y, price: scales.priceOfY(y), bar: c.bar, tDays: null });
    } else {
      const frac = (x - scales.xNow) / Math.max(1, scales.plotRight - scales.xNow);
      setHover({ x, y, price: scales.priceOfY(y), bar: null, tDays: frac * horizonDays });
    }
  }, [scales, width, horizonDays]);

  const ticks = useMemo(() => niceTicks(domain.min, domain.max), [domain]);
  const ready = width > 0 && boxH > 0 && bars.length > 0;

  // Puntos del cono, ya en píxeles. `sel` elige la banda (upper1, lower2, …).
  const conePath = (sel: (c: ConePoint) => number, reverse = false) => {
    const pts = cone.map((c) => `${scales.xOfFuture(c.t)},${scales.yOfPrice(sel(c))}`);
    return reverse ? pts.reverse() : pts;
  };

  return (
    <div
      ref={hostRef}
      className={`pc-host pc-${theme}`}
      style={{ height }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      {ready && (
        <svg className="pc-svg" width={width} height={boxH} role="img">
          <defs>
            {/* Desvanece el cono contra el borde cuando el 2σ no cupo entero. */}
            <linearGradient id={`fade${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fff" stopOpacity={domain.clampedTo2Sigma ? 0 : 1} />
              <stop offset="14%" stopColor="#fff" stopOpacity="1" />
              <stop offset="86%" stopColor="#fff" stopOpacity="1" />
              <stop offset="100%" stopColor="#fff" stopOpacity={domain.clampedTo2Sigma ? 0 : 1} />
            </linearGradient>
            <mask id={`mask${uid}`}>
              <rect x="0" y="0" width={width} height={boxH} fill={`url(#fade${uid})`} />
            </mask>
          </defs>

          {/* 1 · rejilla y eje de precio */}
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={scales.plotLeft} x2={scales.plotRight}
                y1={scales.yOfPrice(v)} y2={scales.yOfPrice(v)}
                stroke={t.grid} strokeWidth={1}
              />
              <text
                className="pc-axis-y" x={scales.plotLeft + 3} y={scales.yOfPrice(v) - 4}
                fill={t.axis}
              >
                {px.format(v)}
              </text>
            </g>
          ))}

          {/* 2 · zona de futuro + frontera AHORA */}
          <rect
            x={scales.xNow} y={scales.plotTop}
            width={Math.max(0, scales.plotRight - scales.xNow)}
            height={scales.plotBottom - scales.plotTop}
            fill={t.futureTint}
          />
          <line
            x1={scales.xNow} x2={scales.xNow} y1={scales.plotTop} y2={scales.plotBottom}
            stroke={t.divider} strokeWidth={1} strokeDasharray="3 3"
          />
          <text className="pc-now" x={scales.xNow + 5} y={scales.plotTop + 9} fill={t.nowText}>
            {tr("chart.now").toUpperCase()}
          </text>

          {/* 3 · bandas de heatmap por target (solo Pro) */}
          {targets.filter((x) => x.bandColor).map((x) => {
            const y = scales.yOfPrice(x.price);
            const h = Math.max(14, (scales.plotBottom - scales.plotTop) * 0.036);
            return (
              <rect
                key={`band-${x.key}`}
                x={scales.plotLeft} y={y - h / 2}
                width={scales.plotRight - scales.plotLeft} height={h}
                fill={x.bandColor}
              />
            );
          })}

          {/* 4 · cono de volatilidad */}
          {cone.length > 1 && (
            <g mask={`url(#mask${uid})`}>
              <polygon
                points={[...conePath((c) => c.upper2), ...conePath((c) => c.lower2, true)].join(" ")}
                fill={t.cone2}
              />
              {showCone1 && (
                <polygon
                  points={[...conePath((c) => c.upper1), ...conePath((c) => c.lower1, true)].join(" ")}
                  fill={t.cone1}
                />
              )}
            </g>
          )}

          {/* 5 · soportes y resistencias */}
          {levels.map((l, i) => (
            <line
              key={`lvl-${i}-${l.price}`}
              x1={scales.plotLeft} x2={scales.plotRight}
              y1={scales.yOfPrice(l.price)} y2={scales.yOfPrice(l.price)}
              stroke={l.kind === "soporte" ? "rgba(18,183,106,0.6)" : "rgba(240,68,56,0.6)"}
              strokeWidth={1} strokeDasharray="4 4"
            />
          ))}

          {/* 6 · velas */}
          <g>
            {scales.candles.map((c, i) => (
              <g key={`c-${i}-${c.bar.time}`}>
                <line
                  x1={c.cx} x2={c.cx} y1={c.yHigh} y2={c.yLow}
                  stroke={t.wick} strokeWidth={1}
                />
                <rect
                  x={c.x} y={Math.min(c.yOpen, c.yClose)}
                  width={c.w} height={Math.abs(c.yClose - c.yOpen)}
                  fill={c.up ? t.up : t.down} rx={1}
                />
              </g>
            ))}
          </g>

          {/* 6b · ondas ya formadas (histórico), conectadas con su etiqueta */}
          {waveDots.length > 1 && (
            <polyline
              className="pc-wave-line"
              points={waveDots.map((w) => `${w.x},${w.y}`).join(" ")}
              stroke={waveColor}
            />
          )}
          {waveDots.map((w, i) => (
            <g key={`wave-${i}-${w.label}`}>
              <circle cx={w.x} cy={w.y} r={3.5} className="pc-wave-dot" fill={waveColor} stroke={theme === "dark" ? "#0d1220" : "#fff"} />
              <text
                x={w.x} y={w.kind === "high" ? w.y - 9 : w.y + 16}
                textAnchor="middle" className="pc-wave-label" fill={waveColor}
              >
                {w.label}
              </text>
            </g>
          ))}

          {/* 7 · precio actual */}
          {showSpot && spot > 0 && (
            <line
              x1={scales.plotLeft} x2={scales.plotRight}
              y1={scales.yOfPrice(spot)} y2={scales.yOfPrice(spot)}
              stroke={t.spot} strokeWidth={1} strokeDasharray="2 4"
            />
          )}

          {/* 8 · rutas proyectadas */}
          {series.map((s) => {
            const n = Math.max(1, s.points.length - 1);
            if (s.points.length < 2) return null;
            const pts = s.points
              .map((p, i) => `${scales.xOfFuture((i / n) * horizonDays)},${scales.yOfPrice(p.price)}`)
              .join(" ");
            return (
              <polyline
                key={s.key}
                className={`pc-series ${animate ? "pc-anim" : ""} ${drawn ? "drawn" : ""}`}
                points={pts}
                pathLength={1}
                stroke={s.color}
                strokeWidth={s.width ?? 2.2}
              />
            );
          })}

          {/* 9 · guías del chip a su precio real */}
          {chips.map((c) => (
            <polyline
              key={`g-${c.key}`}
              className="pc-guide"
              points={`${scales.plotRight},${c.yAnchor} ${scales.plotRight + 7},${c.yAnchor} ${scales.plotRight + 12},${c.y}`}
              stroke={t.guide}
            />
          ))}
        </svg>
      )}

      {/* 10 · chips de target, ya sin colisiones */}
      {ready && chips.map((c) => (
        <div
          key={c.key}
          className={`pc-chip ${animate ? "pc-anim-chip" : ""} ${drawn || !animate ? "show" : ""} ${c.key === "__spot" ? "pc-chip-spot" : ""}`}
          style={{
            left: scales.plotRight + 13,
            top: c.y,
            maxWidth: PADDING.right - 15,
            ...(c.key === "__spot" ? { color: c.color } : { background: c.color, borderColor: c.color }),
          }}
        >
          <span className="pc-chip-label">{c.label}</span>
          <span className="pc-chip-price">${px.format(c.price)}</span>
          {c.sublabel && <span className="pc-chip-sub">{c.sublabel}</span>}
        </div>
      ))}

      {/* eje de fechas */}
      {ready && scales.visibleBars.length > 1 && (
        <div className="pc-axis-x" style={{ top: scales.plotBottom + 6 }}>
          <span style={{ left: scales.plotLeft }}>{shortDate(scales.visibleBars[0].time)}</span>
          <span style={{ left: scales.xNow, transform: "translateX(-100%)" }}>
            {shortDate(scales.visibleBars[scales.visibleBars.length - 1].time)}
          </span>
          <span style={{ left: scales.plotRight, transform: "translateX(-100%)" }}>
            +{horizonDays}d
          </span>
        </div>
      )}

      {ready && (
        <ChartCrosshair
          hover={hover}
          plotTop={scales.plotTop} plotBottom={scales.plotBottom}
          plotLeft={scales.plotLeft} plotRight={scales.plotRight}
        />
      )}
    </div>
  );
}
