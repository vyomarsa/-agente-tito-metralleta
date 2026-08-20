"use client";

import type { CompanyInfo } from "@/lib/types";
import type { FlowRow } from "@/lib/flow";
import { int, money, px, pct } from "../format";

interface Props {
  company: CompanyInfo | null;
  callPct: number | null;
  convRows: FlowRow[] | null;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="ks-row">
      <span className="ks-label">{label}</span>
      <span className={`ks-value${strong ? " strong" : ""}`}>{value}</span>
    </div>
  );
}

export default function KeyStatsCard({ company, callPct, convRows }: Props) {
  if (!company) return null;

  // Posición del precio dentro del rango del día (0 = mínimo, 1 = máximo).
  const rangePos =
    company.price != null && company.dayLow != null && company.dayHigh != null && company.dayHigh > company.dayLow
      ? Math.min(1, Math.max(0, (company.price - company.dayLow) / (company.dayHigh - company.dayLow)))
      : null;

  // Premium de calls/puts del flujo de convicción — la dirección del dinero real.
  let callPrem = 0;
  let putPrem = 0;
  for (const r of convRows ?? []) {
    if (r.type === "call") callPrem += r.premium;
    else if (r.type === "put") putPrem += r.premium;
  }
  const totalPrem = callPrem + putPrem;
  const up = company.changePercent != null && company.changePercent >= 0;

  return (
    <aside className="keystats">
      <div className="ks-head">
        <div className="ks-tick">{company.ticker}</div>
        {company.price != null && (
          <div className="ks-px">
            <span className="ks-pxbig">{px.format(company.price)}</span>
            {company.changePercent != null && (
              <span className={`ks-chg ${up ? "up" : "down"}`}>
                {company.change != null && <>{px.format(company.change)} </>}
                ({pct.format(company.changePercent)}%)
              </span>
            )}
          </div>
        )}
        <div className="ks-sub">
          {[company.exchange, company.sector].filter(Boolean).join(" · ") || "—"}
        </div>
      </div>

      <div className="ks-block">
        <div className="ks-block-head">Valuación</div>
        <Row label="Market Cap" value={company.marketCap != null ? money.format(company.marketCap) : "—"} strong />
        <Row label="Empleados" value={company.employees != null ? int.format(company.employees) : "—"} />
      </div>

      <div className="ks-block">
        <div className="ks-block-head">Rango del día</div>
        {rangePos != null && (
          <div className="ks-range">
            <div className="ks-range-bar">
              <div className="ks-range-dot" style={{ left: `${rangePos * 100}%` }} />
            </div>
            <div className="ks-range-ends">
              <span>{px.format(company.dayLow!)}</span>
              <span>{px.format(company.dayHigh!)}</span>
            </div>
          </div>
        )}
        <Row label="Apertura" value={company.dayOpen != null ? px.format(company.dayOpen) : "—"} />
        <Row label="Cierre previo" value={company.prevClose != null ? px.format(company.prevClose) : "—"} />
      </div>

      <div className="ks-block">
        <div className="ks-block-head">Volumen</div>
        <Row label="Acciones (día)" value={company.dayVolume != null ? int.format(company.dayVolume) : "—"} strong />
      </div>

      {totalPrem > 0 && callPct != null && (
        <div className="ks-block">
          <div className="ks-block-head">Flujo de opciones</div>
          <div className="ks-flow-bar">
            <div className="ks-flow-call" style={{ width: `${callPct}%` }} />
            <div className="ks-flow-put" style={{ width: `${100 - callPct}%` }} />
          </div>
          <div className="ks-flow-legend">
            <span><span className="ks-dot call" /> Calls {money.format(callPrem)}</span>
            <span><span className="ks-dot put" /> Puts {money.format(putPrem)}</span>
          </div>
          <Row label="% en calls" value={`${callPct}%`} strong />
        </div>
      )}
    </aside>
  );
}
