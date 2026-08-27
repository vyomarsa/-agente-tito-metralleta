"use client";

import { useEffect, useMemo, useState } from "react";
import type { TfBar } from "@/lib/types";
import { conePoints } from "@/lib/expectedMove";
import PriceChart, { type ChartTarget } from "../components/chart/PriceChart";
import { useTheme } from "../components/useTheme";
import type { ZeroDteAnalysis } from "./types";

/**
 * Gráfica intradía con los niveles del agente encima.
 *
 * Los números del 0DTE (imán, flip, muros de volumen, objetivo de cierre) solo se
 * entienden cuando se ven CONTRA el precio: "el imán está en 7700" no dice nada
 * hasta que se ve que el precio lleva dos horas rebotando ahí. Se pintan velas de
 * 5 minutos y cada nivel entra como `target` de PriceChart, con su chip a la
 * derecha, así que el encuadre lo resuelve la propia gráfica.
 *
 * Los índices (SPX) no tienen barras de minuto en Massive; en ese caso la tarjeta
 * lo dice y no finge un gráfico vacío.
 */

const COLORS = {
  volCall: "#8b5cf6",   // violeta — strike de más volumen (call)
  volPut: "#a855f7",    // violeta — strike de más volumen (put)
  magnet: "#98a2b3",    // gris — imán del GEX
  flip: "#f79009",      // naranja — flip gamma (ancla ↔ aceleración)
  close: "#eab308",     // amarillo — objetivo de cierre (escenario base)
};

export default function ZeroDteChart({ ticker, a }: { ticker: string; a: ZeroDteAnalysis }) {
  const [bars, setBars] = useState<TfBar[] | null>(null);
  const theme = useTheme();

  useEffect(() => {
    let cancelled = false;
    setBars(null);
    fetch(`/api/bars?ticker=${encodeURIComponent(ticker)}&tf=5m5d`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setBars(Array.isArray(d.bars) ? d.bars.slice(-78) : []); })
      .catch(() => { if (!cancelled) setBars([]); });
    return () => { cancelled = true; };
  }, [ticker]);

  const cone = useMemo(
    // `horizonDaysUsed`, no `horizonDays`: es el MISMO horizonte con el que se
    // calcularon la banda de 1σ y las probabilidades. Con el crudo, al filo del
    // cierre el cono se cerraba a un punto mientras la cabecera seguía diciendo
    // ±0,52 pts — el mismo dibujo contradiciendo a su propio pie.
    () => (a.spot > 0 ? conePoints(a.spot, a.iv, a.horizonDaysUsed, 16) : []),
    [a.spot, a.iv, a.horizonDaysUsed],
  );

  // Un nivel por concepto. `weight` manda en el encuadre: el objetivo de cierre y
  // el imán pesan más porque son los que la vista quiere tener siempre visibles.
  const targets = useMemo<ChartTarget[]>(() => {
    const out: ChartTarget[] = [];
    const push = (
      key: string, price: number | null | undefined, label: string,
      color: string, weight: number, sublabel?: string,
    ) => {
      if (price == null || !Number.isFinite(price) || price <= 0) return;
      out.push({ key, price, label, color, weight, sublabel });
    };
    push("close", a.scenarios.base.target, "Cierre", COLORS.close, 1, "escenario base");
    push("magnet", a.magnet, "Imán", COLORS.magnet, 0.9, "más gamma");
    push("flip", a.flipStrike, "Flip γ", COLORS.flip, 0.8, a.regime === "positive" ? "↓ acelera" : "↑ ancla");
    push("volcall", a.topVolumeCall?.strike, "Vol CALL", COLORS.volCall, 0.6, "más volumen");
    push("volput", a.topVolumePut?.strike, "Vol PUT", COLORS.volPut, 0.6, "más volumen");
    return out;
  }, [a]);

  return (
    <div className="z-chart-card">
      <div className="z-chart-head">Gráfica de {ticker} con los niveles del agente</div>

      {bars === null && <p className="z-chart-msg">Cargando velas de 5 min…</p>}
      {bars !== null && bars.length === 0 && (
        <p className="z-chart-msg">
          Sin barras intradía para {ticker} (los índices no cotizan velas de minuto en la fuente
          actual). Los niveles siguen valiendo: mira la cadena y las tarjetas de arriba.
        </p>
      )}
      {bars !== null && bars.length > 0 && (
        <div className="z-chart-wrap">
          <PriceChart
            bars={bars}
            spot={a.spot}
            horizonDays={a.horizonDays}
            cone={cone}
            targets={targets}
            theme={theme}
            height="100%"
            showCone1
          />
        </div>
      )}

      <p className="z-chart-legend">
        <span style={{ color: COLORS.volCall }}>■ strike de más volumen</span>
        <span style={{ color: COLORS.magnet }}>■ imán del GEX</span>
        <span style={{ color: COLORS.flip }}>■ flip gamma (ancla ↔ aceleración)</span>
        <span style={{ color: COLORS.close }}>■ objetivo de cierre</span>
        <span>— — precio actual</span>
      </p>
    </div>
  );
}
