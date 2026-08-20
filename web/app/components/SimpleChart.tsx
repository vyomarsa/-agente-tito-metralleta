"use client";

import { useEffect, useMemo, useState } from "react";
import type { TfBar } from "@/lib/types";
import type { LevelsReport } from "@/lib/levels";
import { conePoints, predictionPath } from "@/lib/expectedMove";
import PriceChart, { type ChartSeries, type ChartTarget } from "./chart/PriceChart";
import { useTheme } from "./useTheme";

export interface Scenarios { bear: number; base: number; bull: number }

const SCEN: { key: keyof Scenarios; color: string; seed: number; label: string }[] = [
  { key: "bull", color: "#12b76a", seed: 1.7, label: "Alcista" },
  { key: "base", color: "#2f6bff", seed: 4.1, label: "Base" },
  { key: "bear", color: "#f04438", seed: 8.3, label: "Bajista" },
];

/**
 * Camino simulado hacia un target con MOVIMIENTO. Parte de la ruta suave (raíz del
 * tiempo) y le añade oscilación proporcional a la volatilidad de ese instante, con un
 * sobre que vale 0 al inicio y al final (así arranca en el precio actual y aterriza justo
 * en el target). El `seed` da a cada escenario una forma distinta. Determinista.
 */
function wigglePath(
  spot: number, target: number, iv: number, days: number, seed: number, steps = 30,
): { points: { price: number }[]; target: number } {
  const base = predictionPath(spot, target, iv, days, steps);
  const n = Math.max(1, base.points.length - 1);
  const points = base.points.map((p, i) => {
    const f = i / n;
    const sigma = spot * iv * Math.sqrt(Math.max(0, f) * days / 365);
    const envelope = Math.sin(Math.PI * f); // 0 en extremos → ancla inicio y target
    const wob =
      Math.sin(f * 8 + seed) * 0.6 +
      Math.sin(f * 19 + seed * 1.7) * 0.28 +
      Math.sin(f * 37 + seed * 2.6) * 0.12;
    return { price: p.price + sigma * 0.5 * envelope * wob };
  });
  return { points, target: base.target };
}

/**
 * Chart de la vista Estudiante: velas + soportes/resistencias cercanos + los 3 escenarios
 * (bajista/base/alcista) como líneas que SE MUEVEN dentro del cono de volatilidad. Se
 * dibujan una vez al cargar y quedan fijas. Ilustrativo, no una predicción exacta.
 *
 * El dibujo lo hace `PriceChart` (SVG propio). Aquí solo se piden las velas y se arman
 * los escenarios: sin overlays ni geometría cazada a mano.
 */
export default function SimpleChart({
  ticker,
  spot,
  iv,
  horizonDays,
  scenarios,
  levels,
}: {
  ticker: string;
  spot: number;
  iv: number;
  horizonDays: number;
  scenarios: Scenarios | null;
  levels: LevelsReport | null;
}) {
  const [bars, setBars] = useState<TfBar[] | null>(null);
  const theme = useTheme();

  useEffect(() => {
    let cancelled = false;
    setBars(null);
    fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=1y`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setBars(Array.isArray(d.bars) ? d.bars.slice(-70) : []); })
      .catch(() => { if (!cancelled) setBars([]); });
    return () => { cancelled = true; };
  }, [ticker]);

  const cone = useMemo(
    () => (spot > 0 ? conePoints(spot, iv, horizonDays, 24) : []),
    [spot, iv, horizonDays],
  );

  // Los 3 caminos con movimiento, uno por escenario.
  const scen = useMemo(() => {
    if (!scenarios || !(spot > 0)) return [];
    return SCEN.map((s) => ({
      ...s,
      path: wigglePath(spot, scenarios[s.key], iv, horizonDays, s.seed),
    }));
  }, [scenarios, spot, iv, horizonDays]);

  const series: ChartSeries[] = scen.map((s) => ({
    key: s.key, points: s.path.points, color: s.color, width: 2.4,
  }));

  // El target es el de `predictionPath` (ya recortado al cono), no el crudo.
  const targets: ChartTarget[] = scen.map((s) => ({
    key: s.key, price: s.path.target, label: s.label, color: s.color, weight: 1,
  }));

  // Menos ruido: solo los 2 soportes y 2 resistencias más CERCANOS y con fuerza real.
  const nearLevels = useMemo(() => {
    const pick = (arr: LevelsReport["supports"]) =>
      arr.filter((l) => l.strength >= 25)
        .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
        .slice(0, 2);
    return [...pick(levels?.supports ?? []), ...pick(levels?.resistances ?? [])]
      .map((l) => ({ price: l.price, kind: l.kind, strength: l.strength }));
  }, [levels]);

  return (
    <section className="simple-chart card">
      <div>
        <div className="card-title">¿Cómo se podría mover {ticker}?</div>
        <div className="card-sub">
          Las líneas de colores son las 3 rutas posibles: <b style={{ color: "#12b76a" }}>alcista</b>,
          {" "}<b style={{ color: "#2f6bff" }}>base</b> y <b style={{ color: "#f04438" }}>bajista</b>.
          Las punteadas son soportes/resistencias cercanos. Simulación ilustrativa, no exacta.
        </div>
      </div>

      <div className="simple-chart-area">
        {bars === null && <div className="simple-chart-loading">Cargando gráfica…</div>}
        {bars !== null && bars.length === 0 && (
          <div className="simple-chart-loading">Sin datos de precio para {ticker}.</div>
        )}
        {bars !== null && bars.length > 0 && (
          <PriceChart
            bars={bars}
            spot={spot}
            horizonDays={horizonDays}
            cone={cone}
            series={series}
            targets={targets}
            levels={nearLevels}
            theme={theme}
            height="100%"
            animate
          />
        )}
      </div>

      <div className="simple-chart-foot">
        Simulación ilustrativa basada en volatilidad y flujo de opciones. No es consejo financiero.
      </div>
    </section>
  );
}
