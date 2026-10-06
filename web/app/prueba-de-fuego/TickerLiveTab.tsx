"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContractSuggestion } from "@/lib/pdf/dayTrade";
import { buildPosition, pnlOf, type DayTradePosition } from "@/lib/pdf/dayTradePosition";
import { loadPosition, savePosition } from "@/lib/pdf/dayTradePositionLocal";
import { isMarketOpen } from "@/lib/pdf/marketHours";
import { buildOccSymbol } from "@/lib/pdf/occ";
import SpxLevelsCard from "./SpxLevelsCard";
import type { DayTradeSseEvent } from "./types";

const POLL_MS = 20_000;
// Pedido explícito (2026-08-04): "cada 5 minuto una actualización
// para dónde está yendo el mercado" — mismo refresco automático que ya tenía
// SpxVecinosTab, aplicado acá (este componente ya quedó SPX-only desde que
// TSLA se movió al motor de pared). La "posición de HOY" (PnL fijo) de abajo
// NO se toca por este refresco — sigue anclada a la primera sugerencia real
// del día, es un concepto aparte del análisis en vivo de arriba.
const REFRESH_MS = 5 * 60_000;

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export default function TickerLiveTab({ ticker }: { ticker: "TSLA" | "SPX" }) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [spot, setSpot] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<ContractSuggestion | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [position, setPosition] = useState<DayTradePosition | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const run = useCallback(() => {
    esRef.current?.close();
    setBusy(true);
    setError(null);
    setSteps([]);

    const es = new EventSource(`/api/pdf/daytrade?ticker=${ticker}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as DayTradeSseEvent;
      if (d.type === "step") {
        setSteps((s) => [...s.slice(-6), d.label]);
      } else if (d.type === "done") {
        setSpot(d.spot);
        setTarget(d.target);
        setConfidence(d.confidence ?? null);
        setMarketOpen(d.marketOpen);
        setSuggestion(d.suggestion);
        setBusy(false);
        setLastUpdated(new Date());
        es.close();

        // Una sola posición por día: si ya hay una guardada para hoy, no se pisa.
        // Si no hay ninguna y llegó una sugerencia, se toma la foto de entrada.
        const newSuggestion = d.suggestion;
        if (newSuggestion) {
          setPosition((current) => {
            if (current) return current;
            const now = new Date();
            const symbol = buildOccSymbol({
              underlying: newSuggestion.occRoot,
              expiration: newSuggestion.expiration,
              type: newSuggestion.type,
              strike: newSuggestion.strike,
            });
            fetch(`/api/pdf/option-quote?underlying=${ticker}&symbol=${encodeURIComponent(symbol)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((body: { quote?: { mid: number | null; lastTrade: number | null } } | null) => {
                const entryPrice = body?.quote?.mid ?? body?.quote?.lastTrade ?? null;
                if (entryPrice == null) return;
                const pos = buildPosition(newSuggestion, entryPrice, now);
                savePosition(ticker, pos);
                setPosition(pos);
              })
              .catch(() => null);
            return current;
          });
        }
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

  // Al montar: carga la posición guardada de HOY (si existe), arranca el
  // análisis y reprograma un refresco cada 5 min.
  useEffect(() => {
    setPosition(loadPosition(ticker, new Date()));
    run();
    timerRef.current = setInterval(run, REFRESH_MS);
    return () => {
      esRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  // Polling del precio en vivo del contrato, solo con mercado abierto y posición activa.
  useEffect(() => {
    if (!position) return;
    let cancelled = false;
    const poll = () => {
      if (document.visibilityState !== "visible" || !isMarketOpen()) return;
      fetch(`/api/pdf/option-quote?underlying=${position.ticker}&symbol=${encodeURIComponent(position.symbol)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { quote?: { mid: number | null; lastTrade: number | null } } | null) => {
          if (cancelled) return;
          const price = body?.quote?.mid ?? body?.quote?.lastTrade ?? null;
          if (price != null) setLivePrice(price);
        })
        .catch(() => null);
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [position]);

  const forceNewSuggestion = useCallback(() => {
    savePosition(ticker, null);
    setPosition(null);
    setLivePrice(null);
    if (timerRef.current) clearInterval(timerRef.current);
    run();
    timerRef.current = setInterval(run, REFRESH_MS);
  }, [ticker, run]);

  const pnl = position ? pnlOf(position.entryPrice, livePrice) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="wheel-status">
        {ticker} · {marketOpen ? "🟢 mercado abierto" : "🔴 mercado cerrado"}
        {spot != null && <> · spot ${spot.toFixed(2)}</>}
        {target != null && <> · target ${target.toFixed(2)}</>}
        {confidence != null && <> · confianza {confidence}%</>}
        {lastUpdated && (
          <> · actualizado {lastUpdated.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</>
        )}
      </div>

      {busy && (
        <div className="card wheel-empty">
          {steps.length > 0 ? steps[steps.length - 1] : "Analizando…"}
        </div>
      )}
      {error && <div className="error">⚠ {error}</div>}

      {!busy && !error && !suggestion && (
        <div className="card wheel-empty">Sin señal clara hoy — no hay compra agresiva confirmada todavía.</div>
      )}

      {suggestion && (
        <div className="card" style={{ gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>
            {ticker} está en ${suggestion.spot.toFixed(2)} y va a ${suggestion.target.toFixed(2)} — entrá en el{" "}
            {suggestion.type === "call" ? "call" : "put"} ${suggestion.strike} ({suggestion.expiration})
          </div>
          <p className="wheel-disclaimer" style={{ fontSize: 12 }}>
            {suggestion.reason}
            {suggestion.role === "gex_only" && " (sin confirmar todavía con flujo agresivo real)"}
          </p>
          {suggestion.reversalWarning && (
            <p className="wheel-disclaimer" style={{ fontSize: 12, color: "var(--amber-text)" }}>
              ⚠ {suggestion.reversalWarning}
            </p>
          )}
        </div>
      )}

      {position && (
        <div className="card" style={{ gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            Posición de hoy: {position.type === "call" ? "call" : "put"} ${position.strike} ({position.expiration})
          </div>
          <div className="stats">
            <div className="stat">
              <div className="stat-label">Precio de entrada</div>
              <div className="stat-value">${position.entryPrice.toFixed(2)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Precio actual</div>
              <div className="stat-value">{livePrice != null ? `$${livePrice.toFixed(2)}` : "—"}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Ganancia / pérdida %</div>
              <div className="stat-value" style={{ color: (pnl?.pctChange ?? 0) >= 0 ? "#12b76a" : "#f04438" }}>
                {pnl?.pctChange != null ? pct(pnl.pctChange) : "—"}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Ganancia / pérdida $</div>
              <div className="stat-value" style={{ color: (pnl?.usdChange ?? 0) >= 0 ? "#12b76a" : "#f04438" }}>
                {pnl?.usdChange != null ? money(pnl.usdChange) : "—"}
              </div>
            </div>
          </div>
        </div>
      )}

      {ticker === "SPX" && <SpxLevelsCard />}

      <button className="rescan" onClick={forceNewSuggestion} disabled={busy}>
        🔄 Nueva sugerencia
      </button>

      <div className="disclaimer">
        Day-trading en vivo, dinero simulado — no es consejo financiero. El análisis de arriba se actualiza solo
        cada 5 minutos (o al tocar el botón). La posición de HOY (si hay) se fija una sola vez por día de mercado.
      </div>
    </div>
  );
}
