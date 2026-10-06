"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContractSuggestion } from "@/lib/pdf/dayTrade";
import type { DayTradeSseEvent } from "./types";

// Pedido explícito (2026-08-03): a diferencia del TickerLiveTab
// clásico (una sola sugerencia fija por día), "vecinos" es un feed en vivo —
// se refresca solo cada 5 minutos (o al tocar el botón) y nunca "fija" una
// posición del día. Por eso vive en su propio componente en vez de sumar más
// ramas a TickerLiveTab: son dos comportamientos distintos, no una variante
// del mismo.
//
// Generalizado a TSLA (2026-08-04, pedido explícito: "todo el
// proceso que haces en SPX vecinos quiero que lo hagas con TSLA", en el mismo
// botón "TSLA" de siempre, sin pestaña nueva) — el componente ya era genérico
// salvo el ticker hardcodeado; `ticker` ahora es prop, con SPX de default para
// no tocar la pestaña "SPX vecinos" existente.
//
// Vista deliberadamente chica (2026-08-03, pedido explícito): SIN la tabla de
// niveles/GEX de SpxLevelsCard — solo precio, techo, piso, la decisión call/put,
// y los dos targets con su net premium para poder juzgar a ojo si el primero
// aguanta o el precio sigue al segundo.
const REFRESH_MS = 5 * 60_000;

const money0 = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default function SpxVecinosTab({ ticker = "SPX" }: { ticker?: "SPX" | "TSLA" }) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<ContractSuggestion | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const run = useCallback(() => {
    esRef.current?.close();
    setBusy(true);
    setError(null);
    setSteps([]);

    const es = new EventSource(`/api/pdf/daytrade-wall?ticker=${ticker}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as DayTradeSseEvent;
      if (d.type === "step") {
        setSteps((s) => [...s.slice(-6), d.label]);
      } else if (d.type === "done") {
        setMarketOpen(d.marketOpen);
        setSuggestion(d.suggestion);
        setBusy(false);
        setLastUpdated(new Date());
        es.close();
      } else if (d.type === "error") {
        setError(d.message);
        setBusy(false);
        es.close();
      }
    };
    es.onerror = () => {
      setError("Se cortó la conexión con el análisis en vivo.");
      setBusy(false);
      es.close();
    };
  }, [ticker]);

  // Arranca al montar y reprograma un refresco cada 5 min.
  useEffect(() => {
    run();
    timerRef.current = setInterval(run, REFRESH_MS);
    return () => {
      esRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Botón manual: reinicia el reloj de 5 min para no disparar dos refrescos casi seguidos.
  const forceRefresh = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    run();
    timerRef.current = setInterval(run, REFRESH_MS);
  }, [run]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="wheel-status">
        {ticker} (vecinos) · {marketOpen ? "🟢 mercado abierto" : "🔴 mercado cerrado"}
        {lastUpdated && (
          <> · actualizado {lastUpdated.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</>
        )}
      </div>

      {busy && (
        <div className="card wheel-empty">{steps.length > 0 ? steps[steps.length - 1] : "Analizando…"}</div>
      )}
      {error && <div className="error">⚠ {error}</div>}

      {!busy && !error && !suggestion && (
        <div className="card wheel-empty">Sin pared clara ahora mismo — no hay desbalance real confirmado.</div>
      )}

      {!busy && !error && suggestion && (
        <div className="card" style={{ gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>
            {suggestion.type === "call" ? "🟢 COMPRÁ CALL" : "🔴 COMPRÁ PUT"} ${suggestion.strike} ({suggestion.expiration})
          </div>

          <div className="stats">
            <div className="stat">
              <div className="stat-label">Precio de la acción</div>
              <div className="stat-value">${suggestion.spot.toFixed(2)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Resistencia (techo)</div>
              <div className="stat-value">
                {suggestion.resistance ? `$${suggestion.resistance.strike}` : "—"}
              </div>
              {suggestion.resistance && (
                <div className="stat-sub">{money0(suggestion.resistance.netPremium)}</div>
              )}
            </div>
            <div className="stat">
              <div className="stat-label">Soporte (piso)</div>
              <div className="stat-value">{suggestion.support ? `$${suggestion.support.strike}` : "—"}</div>
              {suggestion.support && <div className="stat-sub">{money0(suggestion.support.netPremium)}</div>}
            </div>
          </div>

          <div className="stats">
            <div className="stat">
              <div className="stat-label">Target 1</div>
              <div className="stat-value">${suggestion.target}</div>
              {suggestion.targetNetPremium != null && (
                <div className="stat-sub">{money0(suggestion.targetNetPremium)}</div>
              )}
            </div>
            <div className="stat">
              <div className="stat-label">Target 2</div>
              <div className="stat-value">{suggestion.target2 ? `$${suggestion.target2.strike}` : "—"}</div>
              {suggestion.target2 && <div className="stat-sub">{money0(suggestion.target2.netPremium)}</div>}
            </div>
          </div>

          <p className="wheel-disclaimer" style={{ fontSize: 12 }}>
            {suggestion.reason}
          </p>
        </div>
      )}

      <button className="rescan" onClick={forceRefresh} disabled={busy}>
        🔄 Nueva sugerencia
      </button>

      <div className="disclaimer">
        Day-trading en vivo, dinero simulado — no es consejo financiero. Se actualiza solo cada 5 minutos (o al
        tocar el botón de arriba).
      </div>
    </div>
  );
}
