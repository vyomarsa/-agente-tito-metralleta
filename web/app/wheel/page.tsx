"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RiskProfileCard, { DEFAULT_PROFILE, loadProfile } from "@/app/components/RiskProfileCard";
import WheelPresetCard from "@/app/components/WheelPresetCard";
import WheelTable from "@/app/components/WheelTable";
import { sortByAffordThenScore } from "@/lib/wheelAfford";
import type { PresetId, WheelCandidate } from "@/lib/wheel";
import type { RiskProfile } from "@/lib/risk";
import type { WheelSseEvent } from "./types";

const KEY_VIEW = "tito.view";
const KEY_PRESET = "tito.wheel.preset";

type WheelMeta = { scanned: number; failed: number; withCandidates: number; degraded: boolean };

export default function WheelPage() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_PROFILE);
  const [view, setView] = useState<"estudiante" | "pro">("estudiante");
  const [preset, setPreset] = useState<PresetId>("balanceado");

  const [candidates, setCandidates] = useState<WheelCandidate[] | null>(null);
  const [meta, setMeta] = useState<WheelMeta | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setProfile(loadProfile());
    const v = window.localStorage.getItem(KEY_VIEW);
    if (v === "pro" || v === "estudiante") setView(v);
    const p = window.localStorage.getItem(KEY_PRESET);
    if (p === "conservador" || p === "balanceado" || p === "agresivo") setPreset(p);
  }, []);

  const scan = useCallback((which: PresetId) => {
    esRef.current?.close();
    setBusy(true); setError(null); setSteps([]); setCandidates(null); setMeta(null);
    const es = new EventSource(`/api/wheel?preset=${which}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as WheelSseEvent;
      if (data.type === "step") setSteps((s) => [...s, data.label]);
      else if (data.type === "done") { setCandidates(data.candidates); setMeta(data.meta); setBusy(false); es.close(); }
      else if (data.type === "error") { setError(data.message); setBusy(false); es.close(); }
    };
    es.onerror = () => { setError("Se cortó la conexión con el escáner."); setBusy(false); es.close(); };
  }, []);

  useEffect(() => { scan(preset); return () => esRef.current?.close(); }, [scan, preset]);

  const pickPreset = (p: PresetId) => { setPreset(p); window.localStorage.setItem(KEY_PRESET, p); };
  const pickView = (v: "estudiante" | "pro") => { setView(v); window.localStorage.setItem(KEY_VIEW, v); };

  const rows = useMemo(() => {
    if (!candidates) return [];
    return sortByAffordThenScore(candidates, profile.accountSize);
  }, [candidates, profile.accountSize]);

  const operables = rows.filter((r) => !r.blocked && r.afford.affordable).length;

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-title">Wheel <span className="hb-chip">ingreso con puts</span></div>
      </div>

      <div className="ideas-body">
        <WheelPresetCard preset={preset} onChange={pickPreset} />
        <RiskProfileCard profile={profile} onChange={setProfile} />

        <div className="ideas-controls">
          <div className="view-toggle">
            <button className={view === "estudiante" ? "active" : ""} onClick={() => pickView("estudiante")}>👤 Estudiante</button>
            <button className={view === "pro" ? "active" : ""} onClick={() => pickView("pro")}>⚡ Pro</button>
          </div>
          <button className="rescan" onClick={() => scan(preset)} disabled={busy}>↻ Volver a escanear</button>
        </div>

        {busy && (
          <div className="card wheel-empty">
            {steps.length > 0 ? steps[steps.length - 1] : "Escaneando el mercado…"}
          </div>
        )}
        {error && <div className="error">⚠ {error}</div>}

        {candidates && meta && (
          <>
            <div className="wheel-status">
              Escaneadas {meta.scanned} · {operables} alcanzables con tu efectivo · {rows.filter((r) => !r.blocked).length} candidatos
              {meta.degraded && <span className="wheel-tag warn"> datos parciales: falló más de la mitad</span>}
            </div>
            <p className="wheel-disclaimer">
              Las cotizaciones de Massive son <b>retrasadas</b>. Estos son candidatos, no órdenes: confirma el precio en tu bróker antes de vender.
            </p>
            <WheelTable rows={rows} view={view} />
          </>
        )}
      </div>
    </main>
  );
}
