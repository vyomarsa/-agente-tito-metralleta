"use client";

import type { SpreadScan, SpreadStatus, Trend } from "@/lib/creditSpread";

const STATUS_LABEL: Record<SpreadStatus, string> = {
  candidato: "Candidato",
  descartado: "Descartado",
  no_elegible: "No elegible",
  sin_candidatos: "Sin estructura",
};

const TREND_LABEL: Record<Trend, string> = {
  alcista: "↑ alcista",
  bajista: "↓ bajista",
  lateral: "→ lateral",
};

const STATUS_CLASS: Record<SpreadStatus, string> = {
  candidato: "ok",
  descartado: "danger",
  no_elegible: "warn",
  sin_candidatos: "muted",
};

/**
 * Tabla resumen (Sección 9-A): TODOS los escaneos con su estado y motivo. Deja ver
 * por qué se descartó cada acción — "cero candidatos" es una salida correcta y el
 * mandato exige mostrar la causa, no esconderla.
 */
export default function SpreadsTable({ scans }: { scans: SpreadScan[] }) {
  if (scans.length === 0) return null;
  return (
    <details className="spread-summary">
      <summary>
        Detalle del escaneo — {scans.length} acciones ({scans.filter((s) => s.candidates.length > 0).length}{" "}
        con candidatos)
      </summary>
      <div className="spread-table-wrap">
        <table className="spread-table">
          <thead>
            <tr>
              <th>Acción</th>
              <th>Sector</th>
              <th>Tendencia</th>
              <th>Estado</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {scans.map((s) => (
              <tr key={s.ticker}>
                <td><b>{s.ticker}</b></td>
                <td className="muted">{s.sector}</td>
                <td className="muted">{TREND_LABEL[s.trend]}</td>
                <td>
                  <span className={`wheel-tag ${STATUS_CLASS[s.status]}`}>
                    {STATUS_LABEL[s.status]}
                    {s.status === "candidato" && ` (${s.candidates.length})`}
                  </span>
                </td>
                <td className="muted">
                  {s.reason ?? "—"}
                  {s.eligibilityFails.length > 1 && (
                    <small> · +{s.eligibilityFails.length - 1} motivo{s.eligibilityFails.length - 1 === 1 ? "" : "s"} más</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
