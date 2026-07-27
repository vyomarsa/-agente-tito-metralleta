"use client";

import { useState } from "react";
import type { SpreadCandidate } from "@/lib/creditSpread";
import type { RiskProfile } from "@/lib/risk";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const pct0 = (n: number) => `${n.toFixed(0)}%`;

const TYPE_LABEL: Record<string, string> = {
  put: "Put Credit Spread",
  call: "Call Credit Spread",
};

/**
 * Dimensionamiento en cliente (2–3% del capital, mandato §8). El saldo vive en
 * localStorage y NUNCA llega al servidor. Devuelve el TECHO de contratos según
 * el riesgo por trade del perfil, más las referencias del 2% y 3% del mandato.
 */
function sizing(maxRisk: number, profile: RiskProfile) {
  const account = profile.accountSize > 0 ? profile.accountSize : 0;
  const budget = (account * profile.tolerancePct) / 100;
  const at = (p: number) => (maxRisk > 0 ? Math.floor((account * p) / 100 / maxRisk) : 0);
  return {
    budget,
    maxContracts: maxRisk > 0 ? Math.floor(budget / maxRisk) : 0,
    at2: at(2),
    at3: at(3),
  };
}

export default function SpreadCard({
  c,
  view,
  profile,
}: {
  c: SpreadCandidate;
  view: "estudiante" | "pro";
  profile: RiskProfile;
}) {
  const [open, setOpen] = useState(false);
  const e = c.economics;
  const s = c.stats;
  const m = c.management;
  const size = sizing(e.maxRisk, profile);

  const dirWord = c.type === "put" ? "por debajo de" : "por encima de";

  return (
    <div className="card wheel-row spread-row">
      <button className="wheel-row-head" onClick={() => setOpen((v) => !v)} type="button">
        <span>
          <b>{c.ticker}</b> · {TYPE_LABEL[c.type]} · {c.expiration} ({c.dte}d)
        </span>
        <span className="wheel-score">
          {money2(e.credit)}<small> crédito</small>
        </span>
      </button>

      <div className="spread-legs">
        <span className="spread-leg sell">
          VENDE <b>${c.shortLeg.strike}</b> {c.type} · Δ {c.shortLeg.delta.toFixed(2)}
        </span>
        <span className="spread-leg buy">
          COMPRA <b>${c.longLeg.strike}</b> {c.type} · Δ {c.longLeg.delta.toFixed(2)}
        </span>
        <span className="spread-width">ancho ${e.width.toFixed(2)}</span>
        <span className="wheel-tag" title={`El strike vendido queda ${c.type === "put" ? "por debajo de un soporte" : "por encima de una resistencia"} importante en ${money2(c.guard.price)} (fuerza ${c.guard.strength}/100).`}>
          {c.type === "put" ? "🛡 soporte" : "🛡 resistencia"} ${c.guard.price.toFixed(0)}
        </span>
        {s.elevatedDelta && <span className="wheel-tag warn">⚠ ZONA DE DELTA ELEVADO</span>}
        {c.ivRankLow && (
          <span className="wheel-tag" title="IV Rank por debajo del piso preferido (>40): la prima no está especialmente rica.">
            IV Rank bajo
          </span>
        )}
        {!c.longDeltaInBand && (
          <span className="wheel-tag" title="La pata larga cayó fuera del objetivo Δ0.02–0.05; el ancho $1–$2 mandó.">
            Δ largo fuera de objetivo
          </span>
        )}
      </div>

      {view === "estudiante" ? (
        <p className="wheel-plain">
          Vendes este spread y cobras <b>{money(e.credit * 100)}</b> por contrato. Tu riesgo máximo
          es <b>{money(e.maxRisk)}</b>. Ganas mientras {c.ticker} no cierre {dirWord}{" "}
          <b>{money2(e.breakeven)}</b> (a {pct(e.distanceToBreakevenPct)} del precio actual de{" "}
          {money2(c.spot)}). Estadísticamente el corto expira sin valor ~
          <b>{Math.round(s.probOtmPct)}%</b> de las veces. Tu strike vendido queda{" "}
          {c.type === "put" ? "protegido por un soporte" : "tapado por una resistencia"} en{" "}
          <b>{money2(c.guard.price)}</b>{c.ivRank != null ? <>, con IV Rank <b>{pct0(c.ivRank)}</b></> : null}.
          {size.maxContracts > 0 ? (
            <> Con tu perfil ({profile.tolerancePct}% de riesgo) tu techo es <b>{size.maxContracts}</b> contrato{size.maxContracts === 1 ? "" : "s"}.</>
          ) : (
            <> Con tu perfil no alcanza ni para 1 contrato sin pasarte del riesgo.</>
          )}
        </p>
      ) : (
        <div className="wheel-grid">
          <span>Crédito <b>{money2(e.credit)}</b> <small>({pct(e.creditPct)} del ancho)</small></span>
          <span>Riesgo máx <b>{money(e.maxRisk)}</b> <small>/contrato</small></span>
          <span>Breakeven <b>{money2(e.breakeven)}</b> <small>({pct(e.distanceToBreakevenPct)})</small></span>
          <span>Mov. esperado 1σ <b>{pct(e.expectedMovePct)}</b></span>
          <span>IV <b>{pct(c.iv * 100)}</b></span>
          <span>IV Rank <b>{c.ivRank != null ? pct0(c.ivRank) : "—"}</b>{c.ivRankLow ? <small className="warn"> bajo</small> : null}</span>
          <span>{c.type === "put" ? "Soporte" : "Resistencia"} respaldo <b>{money2(c.guard.price)}</b> <small>(fuerza {c.guard.strength})</small></span>
          <span>Corto fuera 1σ <b>{e.shortOutside1Sigma ? "sí ✓" : "no"}</b></span>
          <span>Prob. OTM <b>{pct(s.probOtmPct)}</b></span>
          <span>Hit-rate equilibrio <b>{pct(s.breakevenHitRatePct)}</b></span>
          <span>Margen sobre equilibrio <b>{s.marginOverBreakevenPts.toFixed(1)} pts</b></span>
        </div>
      )}

      {open && (
        <div className="wheel-outcomes">
          <div className="spread-block">
            <b>Realidad estadística (§7):</b> la probabilidad de que el corto expire OTM (
            {pct(s.probOtmPct)}) contrasta con el hit-rate de equilibrio ({pct(s.breakevenHitRatePct)}).
            El margen entre ambas ({s.marginOverBreakevenPts.toFixed(1)} pts) es tu ventaja real: si
            fuera ≤0, la prima no paga el riesgo asumido.
          </div>
          <div className="spread-block">
            <b>Gestión (§8):</b> cierra al 85% del crédito → ganancia ~{money(m.takeProfitGain)}. Stop
            a 2× el crédito → pérdida ~{money(m.stopLossLoss)}. Rola/cierra si el Δ del corto supera{" "}
            {m.deltaRollAlert.toFixed(2)}.{" "}
            {m.gammaAlert && <b>⚠ Zona gamma: quedan ≤2 DTE.</b>}
          </div>
          <div className="spread-block">
            <b>Liquidez de contrato:</b> corto OI {c.shortLeg.openInterest.toLocaleString()} · vol{" "}
            {c.shortLeg.volume.toLocaleString()} · bid-ask {money2(c.shortLeg.spreadAbs)}. Largo OI{" "}
            {c.longLeg.openInterest.toLocaleString()} · vol {c.longLeg.volume.toLocaleString()} · bid-ask{" "}
            {money2(c.longLeg.spreadAbs)}.
          </div>
          <div className="spread-block">
            <b>Tu dimensionamiento (2–3% del capital, mandato §8):</b> con {money(profile.accountSize)} de
            cuenta, el 2% son {size.at2} contrato{size.at2 === 1 ? "" : "s"} y el 3% son {size.at3}. Tu
            slider ({profile.tolerancePct}%) da un techo de <b>{size.maxContracts}</b>. El saldo nunca
            sale de tu navegador.
          </div>
        </div>
      )}
    </div>
  );
}
