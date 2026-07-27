"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import RiskProfileCard, { DEFAULT_PROFILE, loadProfile } from "@/app/components/RiskProfileCard";
import SpreadCard from "@/app/components/SpreadCard";
import SpreadsTable from "@/app/components/SpreadsTable";
import NavTabs from "@/app/components/NavTabs";
import type { Bias, SpreadCandidate, SpreadScan } from "@/lib/creditSpread";
import type { RiskProfile } from "@/lib/risk";
import type { SpreadSseEvent } from "./types";

const KEY_VIEW = "tito.view";
const KEY_BIAS = "tito.spreads.bias";

type SpreadMeta = {
  bias: Bias;
  scanned: number;
  failed: number;
  withCandidates: number;
  discarded: number;
  degraded: boolean;
  macroStale: boolean;
};

const BIASES: { id: Bias; label: string; hint: string }[] = [
  { id: "alcista", label: "📈 Alcista", hint: "solo Put Credit Spreads" },
  { id: "neutral", label: "➖ Neutral", hint: "puts y calls" },
  { id: "bajista", label: "📉 Bajista", hint: "solo Call Credit Spreads" },
];

export default function SpreadsPage() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_PROFILE);
  const [view, setView] = useState<"estudiante" | "pro">("estudiante");
  const [bias, setBias] = useState<Bias>("neutral");

  const [scans, setScans] = useState<SpreadScan[] | null>(null);
  const [meta, setMeta] = useState<SpreadMeta | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; kind?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setProfile(loadProfile());
    const v = window.localStorage.getItem(KEY_VIEW);
    if (v === "pro" || v === "estudiante") setView(v);
    const b = window.localStorage.getItem(KEY_BIAS);
    if (b === "alcista" || b === "bajista" || b === "neutral") setBias(b);
  }, []);

  const scan = useCallback((which: Bias) => {
    esRef.current?.close();
    setBusy(true); setError(null); setSteps([]); setScans(null); setMeta(null);
    const es = new EventSource(`/api/spreads?bias=${which}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as SpreadSseEvent;
      if (data.type === "step") setSteps((s) => [...s, data.label]);
      else if (data.type === "done") { setScans(data.scans); setMeta(data.meta); setBusy(false); es.close(); }
      else if (data.type === "error") { setError({ message: data.message, kind: data.kind }); setBusy(false); es.close(); }
    };
    es.onerror = () => { setError({ message: "Se cortó la conexión con el escáner." }); setBusy(false); es.close(); };
  }, []);

  useEffect(() => { scan(bias); return () => esRef.current?.close(); }, [scan, bias]);

  const pickBias = (b: Bias) => { setBias(b); window.localStorage.setItem(KEY_BIAS, b); };
  const pickView = (v: "estudiante" | "pro") => { setView(v); window.localStorage.setItem(KEY_VIEW, v); };

  // Aplana los candidatos de todos los escaneos, ya ordenados por la ruta.
  const candidates: SpreadCandidate[] = useMemo(() => {
    if (!scans) return [];
    return scans.flatMap((s) => s.candidates);
  }, [scans]);

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo">T</div>
          <div className="hb-name">Tito Metralleta</div>
          <div className="hb-chip">Credit Spreads · 5–7 DTE</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        <section className="card spread-bias">
          <div className="risk-head">
            <h2>Sesgo direccional</h2>
            <span className="muted">El mandato exige elegir dirección — no se inventa en silencio.</span>
          </div>
          <div className="bias-toggle">
            {BIASES.map((b) => (
              <button
                key={b.id}
                className={bias === b.id ? "active" : ""}
                onClick={() => pickBias(b.id)}
                type="button"
              >
                <b>{b.label}</b>
                <small>{b.hint}</small>
              </button>
            ))}
          </div>
        </section>

        <RiskProfileCard profile={profile} onChange={setProfile} />

        <div className="ideas-controls">
          <div className="view-toggle">
            <button className={view === "estudiante" ? "active" : ""} onClick={() => pickView("estudiante")}>👤 Estudiante</button>
            <button className={view === "pro" ? "active" : ""} onClick={() => pickView("pro")}>⚡ Pro</button>
          </div>
          <button className="rescan" onClick={() => scan(bias)} disabled={busy}>↻ Volver a escanear</button>
        </div>

        {busy && (
          <div className="card wheel-empty">
            {steps.length > 0 ? steps[steps.length - 1] : "Escaneando acciones…"}
          </div>
        )}

        {error && (
          <div className="error">
            ⚠ {error.message}
            {error.kind === "schwab" && (
              <> <Link href="/schwab" className="spread-link">Ir a conectar Schwab →</Link></>
            )}
          </div>
        )}

        {scans && meta && !error && (
          <>
            <div className="wheel-status">
              Escaneadas {meta.scanned} · {meta.withCandidates} con candidatos · {meta.discarded} descartadas
              {meta.degraded && <span className="wheel-tag warn"> datos parciales: falló más de la mitad</span>}
              {meta.macroStale && <span className="wheel-tag warn"> calendario macro en cache viejo</span>}
            </div>
            <p className="wheel-disclaimer">
              Delta e IV son <b>reales de Schwab</b>. Aun así, las cotizaciones pueden estar retrasadas:
              estos son candidatos, no órdenes. Confirma el precio y el crédito en tu bróker antes de operar.
              El crédito se calcula sobre el <b>MID</b>.
            </p>

            {candidates.length === 0 ? (
              <div className="card wheel-empty">
                Ninguna acción cumple TODOS los filtros hoy con sesgo <b>{bias}</b>. Es una salida
                correcta y frecuente — el escáner nunca relaja un parámetro para producir un resultado.
                Mira el detalle abajo para ver por qué.
              </div>
            ) : (
              <div className="wheel-list">
                {candidates.map((c) => (
                  <SpreadCard
                    key={`${c.ticker}-${c.type}-${c.shortLeg.strike}-${c.longLeg.strike}-${c.expiration}`}
                    c={c}
                    view={view}
                    profile={profile}
                  />
                ))}
              </div>
            )}

            <SpreadsTable scans={scans} />
          </>
        )}
      </div>
    </main>
  );
}
