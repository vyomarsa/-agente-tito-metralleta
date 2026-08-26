"use client";

import { useState } from "react";
import type { SpreadCandidate } from "@/lib/creditSpread";
import { RISK_PER_TRADE_MAX_PCT, RISK_PER_TRADE_PCT, sizeFor } from "@/lib/primaPaper";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const pct0 = (n: number) => `${n.toFixed(0)}%`;

const TYPE_LABEL: Record<string, string> = {
  put: "Put Credit Spread",
  call: "Call Credit Spread",
};

export default function SpreadCard({
  c,
  view,
  accountSize,
}: {
  c: SpreadCandidate;
  view: "estudiante" | "pro";
  /** Capital del usuario para dimensionar. 0/undefined = no se dimensiona. */
  accountSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const e = c.economics;
  const s = c.stats;
  const m = c.management;

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
        {c.guard && (
          <span className="wheel-tag" title={`El strike vendido queda ${c.type === "put" ? "por debajo de un soporte" : "por encima de una resistencia"} importante en ${money2(c.guard.price)} (fuerza ${c.guard.strength}/100).`}>
            {c.type === "put" ? "🛡 soporte" : "🛡 resistencia"} ${c.guard.price.toFixed(0)}
          </span>
        )}
        {c.warnings.map((w) => (
          <span key={w} className="wheel-tag danger" title="Modo experto: filtro DURO degradado a aviso. Tú decides si operas.">
            ⚡ {w}
          </span>
        ))}
        {s.elevatedDelta && (
          <span className="wheel-tag warn" title="El delta del corto (>0.14) está en el tope de la banda de venta de prima (0.10–0.15): es el extremo más agresivo aceptable. El objetivo es 0.12.">
            ⚠ Δ EN EL TOPE (0.14–0.15)
          </span>
        )}
        {c.softMacroEvents.length > 0 && (
          <span
            className="wheel-tag warn"
            title={`Reporte de empleo (NFP) dentro de la ventana (${c.softMacroEvents
              .map((e) => e.date)
              .join(", ")}). Mueve el precio un día y suele revertir — no descarta, pero opera con el aviso presente.`}
          >
            ⚠ NFP en la ventana
          </span>
        )}
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
          <b>{Math.round(s.probOtmPct)}%</b> de las veces.{" "}
          {c.guard ? (
            <>
              Tu strike vendido queda{" "}
              {c.type === "put" ? "protegido por un soporte" : "tapado por una resistencia"} en{" "}
              <b>{money2(c.guard.price)}</b>
            </>
          ) : (
            <>
              <b>Sin {c.type === "put" ? "soporte" : "resistencia"} que respalde el strike</b> (modo
              experto)
            </>
          )}
          {c.ivRank != null ? <>, con IV Rank <b>{pct0(c.ivRank)}</b></> : null}.
        </p>
      ) : (
        <div className="wheel-grid">
          <span>Crédito <b>{money2(e.credit)}</b> <small>({pct(e.creditPct)} del ancho)</small></span>
          <span>Riesgo máx <b>{money(e.maxRisk)}</b> <small>/contrato</small></span>
          <span>Breakeven <b>{money2(e.breakeven)}</b> <small>({pct(e.distanceToBreakevenPct)})</small></span>
          <span>Mov. esperado 1σ <b>{pct(e.expectedMovePct)}</b></span>
          <span>IV <b>{pct(c.iv * 100)}</b></span>
          <span>IV Rank <b>{c.ivRank != null ? pct0(c.ivRank) : "—"}</b>{c.ivRankLow ? <small className="warn"> bajo</small> : null}</span>
          <span>{c.type === "put" ? "Soporte" : "Resistencia"} respaldo <b>{c.guard ? money2(c.guard.price) : "—"}</b> {c.guard ? <small>(fuerza {c.guard.strength})</small> : <small className="warn">sin nivel</small>}</span>
          <span>Corto fuera 1σ <b>{e.shortOutside1Sigma ? "sí ✓" : "no"}</b></span>
          <span>Prob. OTM <b>{pct(s.probOtmPct)}</b></span>
          <span>Hit-rate equilibrio <b>{pct(s.breakevenHitRatePct)}</b></span>
          <span>Margen sobre equilibrio <b>{s.marginOverBreakevenPts.toFixed(1)} pts</b></span>
        </div>
      )}

      {accountSize != null && accountSize > 0 && (
        <SpreadSizing c={c} accountSize={accountSize} />
      )}

      {open && (
        <div className="wheel-outcomes">
          <div className="spread-block">
            <b>Realidad estadística (§7):</b> la probabilidad de que el corto expire OTM (
            {pct(s.probOtmPct)}) contrasta con el hit-rate de equilibrio ({pct(s.breakevenHitRatePct)}) —
            margen {s.marginOverBreakevenPts.toFixed(1)} pts. En venta de prima far-OTM este margen suele
            rondar 0 o ser algo negativo <em>a vencimiento</em>: el edge NO está en aguantar hasta el
            final, sino en <b>vender IV cara y cerrar al 50%</b> capturando el decaimiento theta. Por eso
            se toma ganancia temprano y se respeta el stop.
          </div>
          <div className="spread-block">
            <b>Gestión (§8):</b> toma de ganancias al 50% del máximo → ganancia ~{money(m.takeProfitGain)}.
            Stop a 2.5× el crédito → pérdida ~{money(m.stopLossLoss)}. Rola/cierra si el Δ del corto
            supera {m.deltaRollAlert.toFixed(2)}.{" "}
            {m.gammaAlert && <b>⚠ Zona gamma: quedan ≤2 DTE.</b>}
          </div>
          <div className="spread-block">
            <b>Liquidez de contrato:</b> corto OI {c.shortLeg.openInterest.toLocaleString()} · vol{" "}
            {c.shortLeg.volume.toLocaleString()} · bid-ask {money2(c.shortLeg.spreadAbs)}. Largo OI{" "}
            {c.longLeg.openInterest.toLocaleString()} · vol {c.longLeg.volume.toLocaleString()} · bid-ask{" "}
            {money2(c.longLeg.spreadAbs)}.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Cuántos contratos caben con TU capital.
 *
 * El mandato §8 de venta de prima acota el riesgo por operación al 2–3% del
 * capital, así que se enseñan los DOS extremos: es un rango, y publicar un solo
 * número invita a tomarlo como "el" tamaño correcto.
 *
 * Reusa `sizeFor` del motor de la cuenta de paper (`lib/primaPaper`) A PROPÓSITO:
 * si el screener manual y el ejecutor automático dimensionaran distinto, la cuenta
 * de paper dejaría de medir lo mismo que haces a mano, y el win rate que sale de
 * ahí ya no diría nada sobre tu operativa real.
 *
 * El capital vive en localStorage y NO viaja al servidor — la misma regla que el
 * perfil de riesgo de /ideas.
 */
function SpreadSizing({ c, accountSize }: { c: SpreadCandidate; accountSize: number }) {
  const min = sizeFor(c, accountSize, RISK_PER_TRADE_PCT);
  const max = sizeFor(c, accountSize, RISK_PER_TRADE_MAX_PCT);
  const riskPerContract = c.economics.maxRisk;
  const creditPerContract = c.economics.credit * 100;
  const lo = RISK_PER_TRADE_PCT * 100;
  const hi = RISK_PER_TRADE_MAX_PCT * 100;

  if (max < 1) {
    // Capital para que UN contrato quepa en el borde alto del mandato.
    const need = riskPerContract / RISK_PER_TRADE_MAX_PCT;
    return (
      <div className="spread-size none">
        <b>0 contratos.</b> Un contrato arriesga {money(riskPerContract)}, más del {pct0(hi)} de
        tus {money(accountSize)}. Para que entre uno harían falta ~{money(need)}.
      </div>
    );
  }

  const range = (a: number, b: number, fmt: (n: number) => string) =>
    b > a ? `${fmt(a)}–${fmt(b)}` : fmt(a);

  return (
    <div className="spread-size">
      <span className="spread-size-n">
        <b>{range(min, max, (n) => String(n))}</b>
        <small>contrato{max === 1 ? "" : "s"}</small>
      </span>
      <span>
        Arriesgas <b>{range(min * riskPerContract, max * riskPerContract, money)}</b>{" "}
        <small>({pct0(lo)}–{pct0(hi)} de {money(accountSize)})</small>
      </span>
      <span>
        Cobras <b>{range(min * creditPerContract, max * creditPerContract, money)}</b>{" "}
        <small>de crédito</small>
      </span>
    </div>
  );
}
