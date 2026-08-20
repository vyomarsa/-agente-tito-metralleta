"use client";

import { useCallback, useRef, useState } from "react";
import TarjetaDecisionCard from "@/app/components/TarjetaDecisionCard";
import type { DecisionCard } from "@/lib/decisionCard";
import type { TarjetaSseEvent, TarjetaMeta } from "./types";

const HORIZONS = [
  { days: 10, label: "Esta semana" },
  { days: 20, label: "2 semanas" },
  { days: 30, label: "1 mes" },
];

export default function TarjetaPage() {
  const [ticker, setTicker] = useState("");
  const [horizon, setHorizon] = useState(10);
  const [card, setCard] = useState<DecisionCard | null>(null);
  const [meta, setMeta] = useState<TarjetaMeta | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const generate = useCallback((t: string, h: number) => {
    const tk = t.trim().toUpperCase();
    if (!tk) return;
    esRef.current?.close();
    setBusy(true); setError(null); setSteps([]); setCard(null); setMeta(null);
    const es = new EventSource(`/api/tarjeta?ticker=${encodeURIComponent(tk)}&horizon=${h}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as TarjetaSseEvent;
      if (data.type === "step") setSteps((s) => [...s, data.label]);
      else if (data.type === "done") { setCard(data.card); setMeta(data.meta); setBusy(false); es.close(); }
      else if (data.type === "error") { setError(data.message); setBusy(false); es.close(); }
    };
    es.onerror = () => { setError("Se cortó la conexión con el generador."); setBusy(false); es.close(); };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!busy) generate(ticker, horizon);
  };

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-title">Tarjeta de Decisión <span className="hb-chip">¿puedo tomar posición?</span></div>
      </div>

      <div className="ideas-body">
        <form className="card" onSubmit={submit} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <input
            autoFocus
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="Ticker (p. ej. AAPL, NVDA, SPX)"
            aria-label="Ticker"
            style={{ flex: "1 1 200px", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text)", fontSize: 15 }}
          />
          <div className="view-toggle">
            {HORIZONS.map((h) => (
              <button key={h.days} type="button" className={horizon === h.days ? "active" : ""} onClick={() => setHorizon(h.days)}>{h.label}</button>
            ))}
          </div>
          <button type="submit" className="rescan" disabled={busy || !ticker.trim()}>
            {busy ? "Generando…" : "Generar tarjeta"}
          </button>
        </form>

        {busy && (
          <div className="card wheel-empty">
            {steps.length > 0 ? steps[steps.length - 1] : "Reuniendo datos…"}
          </div>
        )}
        {error && <div className="error">⚠ {error}</div>}

        {card && (
          <>
            {meta?.greeksSource === "estimated" && (
              <div className="wheel-status">
                <span className="wheel-tag warn">GEX estimado por Black-Scholes (sin greeks reales para {meta.ticker})</span>
              </div>
            )}
            <TarjetaDecisionCard card={card} />
          </>
        )}

        {!card && !busy && !error && (
          <p className="wheel-disclaimer">
            Escribe un ticker y genera la <b>Tarjeta de Decisión</b>: sintetiza estructura, GEX/walls, flujo y noticias en un
            veredicto go/no-go con plan condicional. No inventa datos: lo que falte se marca <b>DATO NO DISPONIBLE</b>.
          </p>
        )}
      </div>
    </main>
  );
}
