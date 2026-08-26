"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import SpreadCard from "@/app/components/SpreadCard";
import SpreadsTable from "@/app/components/SpreadsTable";
import { loadProfile } from "@/app/components/RiskProfileCard";
import type { Bias, SpreadCandidate, SpreadScan } from "@/lib/creditSpread";
import type { SpreadSseEvent, Source } from "./types";

const KEY_VIEW = "tito.view";
const KEY_BIAS = "tito.spreads.bias";
const KEY_SOURCE = "tito.spreads.source";
const KEY_EXPERT = "tito.spreads.expert";

type SpreadMeta = {
  bias: Bias;
  source: Source;
  scanned: number;
  failed: number;
  withCandidates: number;
  discarded: number;
  degraded: boolean;
  macroStale: boolean;
  expert: boolean;
};

const SOURCES: { id: Source; label: string; hint: string }[] = [
  { id: "tastytrade", label: "Tastytrade", hint: "fuente principal — greeks, delta, IV y volumen reales por el streamer" },
  { id: "marketsnack", label: "MarketSnack", hint: "siempre disponible" },
  { id: "schwab", label: "Schwab", hint: "greeks de bróker" },
];

/** Nombre visible de cada fuente. Sin esto, Tastytrade se pintaba como "MarketSnack". */
const SOURCE_LABEL: Record<Source, string> = {
  tastytrade: "Tastytrade",
  marketsnack: "MarketSnack",
  schwab: "Schwab",
};

const BIASES: { id: Bias; label: string; hint: string }[] = [
  { id: "alcista", label: "📈 Alcista", hint: "solo Put Credit Spreads" },
  { id: "neutral", label: "➖ Neutral", hint: "puts y calls" },
  { id: "bajista", label: "📉 Bajista", hint: "solo Call Credit Spreads" },
];

export default function SpreadsPage() {
  const [view, setView] = useState<"estudiante" | "pro">("estudiante");
  const [bias, setBias] = useState<Bias>("neutral");
  const [source, setSource] = useState<Source>("tastytrade");
  const [expert, setExpert] = useState(false);
  // Capital para dimensionar. Comparte la clave `tito.risk.accountSize` con
  // /ideas a propósito: "mi cuenta" es UN dato, no uno por pantalla. Vive en
  // localStorage y nunca viaja al servidor.
  const [accountSize, setAccountSize] = useState(0);
  const [accountDraft, setAccountDraft] = useState("");

  const [scans, setScans] = useState<SpreadScan[] | null>(null);
  const [meta, setMeta] = useState<SpreadMeta | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; kind?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const prof = loadProfile();
    setAccountSize(prof.accountSize);
    setAccountDraft(String(prof.accountSize));
    const v = window.localStorage.getItem(KEY_VIEW);
    if (v === "pro" || v === "estudiante") setView(v);
    const b = window.localStorage.getItem(KEY_BIAS);
    if (b === "alcista" || b === "bajista" || b === "neutral") setBias(b);
    const s = window.localStorage.getItem(KEY_SOURCE);
    if (s === "marketsnack" || s === "schwab") setSource(s);
    // El modo experto se enciende por localStorage O por ?expert=1 en la URL (link
    // directo para el iPhone). Si el link lo trae, se persiste para las próximas visitas.
    const fromUrl = new URLSearchParams(window.location.search).get("expert") === "1";
    const x = window.localStorage.getItem(KEY_EXPERT);
    if (fromUrl || x === "1") {
      setExpert(true);
      if (fromUrl) window.localStorage.setItem(KEY_EXPERT, "1");
    }
  }, []);

  const scan = useCallback((which: Bias, src: Source, exp: boolean) => {
    esRef.current?.close();
    setBusy(true); setError(null); setSteps([]); setScans(null); setMeta(null);
    const es = new EventSource(`/api/spreads?bias=${which}&source=${src}${exp ? "&expert=1" : ""}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as SpreadSseEvent;
      if (data.type === "step") setSteps((s) => [...s, data.label]);
      else if (data.type === "done") { setScans(data.scans); setMeta(data.meta); setBusy(false); es.close(); }
      else if (data.type === "error") { setError({ message: data.message, kind: data.kind }); setBusy(false); es.close(); }
    };
    es.onerror = () => { setError({ message: "Se cortó la conexión con el escáner." }); setBusy(false); es.close(); };
  }, []);

  useEffect(() => { scan(bias, source, expert); return () => esRef.current?.close(); }, [scan, bias, source, expert]);

  const pickBias = (b: Bias) => { setBias(b); window.localStorage.setItem(KEY_BIAS, b); };
  const pickView = (v: "estudiante" | "pro") => { setView(v); window.localStorage.setItem(KEY_VIEW, v); };
  const commitAccount = (raw: string) => {
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    const next = Number.isFinite(n) && n > 0 ? n : 0;
    setAccountSize(next);
    setAccountDraft(String(next));
    try { window.localStorage.setItem("tito.risk.accountSize", String(next)); } catch { /* noop */ }
  };
  const pickSource = (s: Source) => { setSource(s); window.localStorage.setItem(KEY_SOURCE, s); };
  const toggleExpert = () => {
    setExpert((prev) => {
      const next = !prev;
      window.localStorage.setItem(KEY_EXPERT, next ? "1" : "0");
      return next;
    });
  };

  // Aplana los candidatos de todos los escaneos, ya ordenados por la ruta.
  const candidates: SpreadCandidate[] = useMemo(() => {
    if (!scans) return [];
    return scans.flatMap((s) => s.candidates);
  }, [scans]);

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-title">Venta de Prima <span className="hb-chip">4–7 DTE · Δ 0.10–0.15</span></div>
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

          {/* Capital para dimensionar. La ficha traduce cada candidato a
              contratos con el mandato §8 (2–3% de riesgo por operación) usando
              el MISMO `sizeFor` que la cuenta de paper, así que lo que ves aquí
              es lo que abriría el ejecutor. El saldo no sale del navegador. */}
          <div className="spread-capital">
            <label htmlFor="spread-capital">Mi capital</label>
            <input
              id="spread-capital"
              inputMode="numeric"
              value={accountDraft}
              onChange={(e) => setAccountDraft(e.target.value)}
              onBlur={(e) => commitAccount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitAccount((e.target as HTMLInputElement).value); }}
            />
            <span className="muted">
              Cada ficha te dirá cuántos contratos caben arriesgando el 2–3% por operación.
              Solo se guarda en este navegador.
            </span>
          </div>
        </section>

        <div className="ideas-controls">
          <div className="view-toggle">
            <button className={view === "estudiante" ? "active" : ""} onClick={() => pickView("estudiante")}>👤 Estudiante</button>
            <button className={view === "pro" ? "active" : ""} onClick={() => pickView("pro")}>⚡ Pro</button>
          </div>
          <div className="view-toggle">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                className={source === s.id ? "active" : ""}
                onClick={() => pickSource(s.id)}
                title={s.hint}
                type="button"
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            className={expert ? "view-toggle-expert active" : "view-toggle-expert"}
            onClick={toggleExpert}
            title="Degrada los filtros de contexto (macro, tendencia, nivel guardián y 1σ) a avisos visibles: ves TODOS los candidatos con su bandera de riesgo y decides tú. Mantiene 4–7 DTE, delta 0.10–0.15 y toda la validación de liquidez."
            type="button"
          >
            {expert ? "🔓 Modo experto" : "🔒 Modo seguro"}
          </button>
          <button className="rescan" onClick={() => scan(bias, source, expert)} disabled={busy}>↻ Volver a escanear</button>
        </div>

        {expert && (
          <div className="wheel-status warn">
            ⚡ <b>Modo experto activo.</b> Los filtros de contexto —evento macro (FOMC/CPI/PCE),
            tendencia, soporte/resistencia guardián y 1σ— ya <b>no descartan</b>: aparecen como
            avisos en cada ficha. La banda 4–7 DTE, delta 0.10–0.15 y toda la validación de
            liquidez siguen intactas. Tú asumes el riesgo con criterio propio.
          </div>
        )}

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
              <span className="wheel-tag"> fuente: {SOURCE_LABEL[meta.source]}</span>
              {meta.source !== source && (
                <span className="wheel-tag warn">
                  {" "}{SOURCE_LABEL[source]} no disponible: se usó {SOURCE_LABEL[meta.source]}
                </span>
              )}
              {meta.degraded && <span className="wheel-tag warn"> datos parciales: falló más de la mitad</span>}
              {meta.macroStale && <span className="wheel-tag warn"> calendario macro en cache viejo</span>}
            </div>
            <p className="wheel-disclaimer">
              Delta e IV son <b>reales de {SOURCE_LABEL[meta.source]}</b>. Aun así,
              las cotizaciones pueden estar retrasadas: estos son candidatos, no órdenes. Confirma el precio
              y el crédito en tu bróker antes de operar. El crédito se calcula sobre el <b>MID</b>.
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
                    accountSize={accountSize}
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
