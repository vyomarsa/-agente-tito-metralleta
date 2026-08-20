"use client";

import type { IvContextScore } from "@/lib/ivcontext";
import { int, money, px } from "../format";

const REGIME_LABEL: Record<string, string> = {
  dormida: "Acción dormida",
  compresion: "Volatilidad comprimida",
  expansion: "Volatilidad estirada",
  inflada: "Prima inflada",
  normal: "Volatilidad normal",
  desconocido: "Sin contexto",
};

function ivColor(ivPct: number): string {
  if (ivPct >= 90) return "#f04438";
  if (ivPct >= 61) return "#f79009";
  if (ivPct >= 40) return "#12b76a";
  return "#667085";
}

/** Fecha real + días restantes — nunca uno sin el otro. */
function expLabel(expiration: string | null, dte: number | null): string {
  if (!expiration) return "—";
  return dte == null ? expiration : `${expiration} (${dte}d)`;
}

/**
 * Sub-agente 5 — Contexto IV. Muestra lo que pide el documento: promedio de IV
 * por vencimiento y los contratos de mayor IV, más el IV Rank y su régimen.
 */
export default function IvContextCard({ s }: { s: IvContextScore }) {
  const cls = s.score >= 7 ? "up" : s.score <= 3 ? "down" : "neutral";
  const maxIvExp = Math.max(...s.byExpiration.map((e) => e.avgIv), 1);

  return (
    <>
      <section className="scorecard cv-card">
        <div className="score-main">
          <div className="score-cat">Contexto IV</div>
          <div className={`score-num ${cls}`}>{s.score}<span className="score-den">/10</span></div>
          <div className="score-q">¿IV limpia o inflada?</div>
        </div>

        <div className="score-detail">
          <div className={`score-verdict ${cls}`}>{REGIME_LABEL[s.regime] ?? s.regime}</div>

          <div className="cv-metrics">
            <div className="cv-metric">
              <div className="cv-metric-label">IV actual</div>
              <div className="cv-metric-value" style={{ color: s.iv.current != null ? ivColor(s.iv.current) : undefined }}>
                {s.iv.current != null ? `${s.iv.current.toFixed(1)}%` : "—"}
              </div>
              <div className="cv-metric-pts">{s.iv.points}<span className="muted">/10</span></div>
              <div className="cv-metric-hint muted">
                {s.iv.band} · {s.iv.source === "chain"
                  ? "cadena completa (ATM), ponderada por prima abierta"
                  : "trades del flujo, ponderada por premium"}
              </div>
            </div>

            <div className="cv-metric">
              <div className="cv-metric-label">IV Rank</div>
              <div className="cv-metric-value">
                {s.rank.value != null ? `${s.rank.value.toFixed(0)}%` : "—"}
                {s.rank.source === "tastytrade" && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--green)", marginLeft: 6 }}
                        title="IV Rank real de Tastytrade, no estimado">
                    · real
                  </span>
                )}
              </div>
              <div className="cv-metric-pts">{s.rank.points}<span className="muted">/10</span></div>
              <div className="cv-metric-hint muted">
                {s.rank.band}
                {s.rank.low != null && s.rank.high != null &&
                  ` · rango ${s.rank.low.toFixed(0)}-${s.rank.high.toFixed(0)}%`}
              </div>
            </div>

            <div className="cv-metric">
              <div className="cv-metric-label">Skew del frente</div>
              <div className="cv-metric-value" style={{ color: (s.frontSkew ?? 0) > 10 ? "#f04438" : undefined }}>
                {s.frontSkew != null ? `${s.frontSkew >= 0 ? "+" : ""}${s.frontSkew.toFixed(1)} pts` : "—"}
              </div>
              <div className="cv-metric-hint muted">
                {s.frontSkew != null && s.frontSkew > 10
                  ? "el vencimiento cercano cotiza mucho más caro: evento encima"
                  : "vencimiento cercano vs el resto"}
              </div>
            </div>
          </div>

          <div className="iv-note">{s.note}</div>

          {s.iv.special && (
            <div className="iv-special">
              ⚠ <b>Categoría especial del documento:</b> IV ≥100%. La prima está tan inflada
              que el movimiento suele estar ya descontado — comprar aquí es apostar a que
              el movimiento supere lo que el mercado ya pagó.
            </div>
          )}

          <div className="iv-source muted">
            IV Rank calculado con{" "}
            {s.rank.source === "tastytrade"
              ? <><b>IV Rank REAL de Tastytrade</b> — el rank oficial del proveedor, no una estimación.</>
              : s.rank.source === "iv-history"
              ? <><b>historial propio de IV</b> — {s.rank.days} días acumulados</>
              : s.rank.source === "realized-proxy"
                ? <>
                    <b>proxy de volatilidad realizada</b> ({s.rank.days} días del subyacente).
                    Ninguna fuente nos vende 52 semanas de IV histórica, así que se guarda una
                    foto diaria: a los 60 días el rank real reemplaza al proxy.
                  </>
                : "sin historia suficiente"}
          </div>
        </div>
      </section>

      {s.byExpiration.length > 0 && (
        <div className="clusters">
          <h2 className="clusters-title">
            IV promedio por fecha de vencimiento
            <span className="muted"> — {s.iv.contracts} contratos con IV</span>
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vencimiento</th>
                  <th className="num">Trades</th>
                  <th className="num">IV promedio</th>
                  <th className="num">IV máxima</th>
                  <th className="num">Premium</th>
                  <th>Nivel</th>
                </tr>
              </thead>
              <tbody>
                {s.byExpiration.map((e) => (
                  <tr key={e.expiration}>
                    <td><b>{expLabel(e.expiration, e.dte)}</b></td>
                    <td className="num">{int.format(e.trades)}</td>
                    <td className="num" style={{ color: ivColor(e.avgIv), fontWeight: 700 }}>
                      {e.avgIv.toFixed(1)}%
                    </td>
                    <td className="num muted">{e.maxIv.toFixed(1)}%</td>
                    <td className="num">{money.format(e.premium)}</td>
                    <td>
                      <div className="iv-bar">
                        <div style={{ width: `${(e.avgIv / maxIvExp) * 100}%`, background: ivColor(e.avgIv) }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {s.topContracts.length > 0 && (
        <div className="clusters">
          <h2 className="clusters-title">
            Contratos con mayor IV
            <span className="muted"> — donde el mercado paga más por el movimiento</span>
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Contrato</th>
                  <th>Tipo</th>
                  <th>Vencimiento</th>
                  <th className="num">IV</th>
                  <th className="num">Contratos</th>
                  <th className="num">Premium</th>
                </tr>
              </thead>
              <tbody>
                {s.topContracts.map((c) => (
                  <tr key={c.id}>
                    <td><b>${c.strike != null ? px.format(c.strike) : "?"}</b></td>
                    <td>
                      <span className={`pill ${c.type === "call" ? "call" : "put"}`}>
                        {c.type === "call" ? "CALL" : "PUT"}
                      </span>
                    </td>
                    <td>{expLabel(c.expiration, c.dte)}</td>
                    <td className="num" style={{ color: ivColor(c.iv), fontWeight: 700 }}>
                      {c.iv.toFixed(1)}%
                    </td>
                    <td className="num">{int.format(c.size)}</td>
                    <td className="num">{money.format(c.premium)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
