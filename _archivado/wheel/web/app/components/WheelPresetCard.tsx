"use client";

import { WHEEL_PRESETS, type PresetId } from "@/lib/wheel";

const ORDER: PresetId[] = ["conservador", "balanceado", "agresivo"];

export default function WheelPresetCard({
  preset,
  onChange,
}: {
  preset: PresetId;
  onChange: (p: PresetId) => void;
}) {
  const active = WHEEL_PRESETS[preset];
  return (
    <div className="card wheel-preset">
      <div className="wheel-preset-head">
        <h2>Cómo quieres vender puts</h2>
        <p>Elige un perfil. No hay que tocar números — cada uno ya trae su delta y su plazo.</p>
      </div>
      <div className="wheel-preset-tabs">
        {ORDER.map((id) => {
          const p = WHEEL_PRESETS[id];
          return (
            <button
              key={id}
              className={`wheel-preset-tab ${preset === id ? "on" : ""}`}
              onClick={() => onChange(id)}
              type="button"
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <p className="wheel-preset-explain">{active.explain}</p>
      <div className="wheel-preset-facts">
        <span>Delta objetivo <b>{active.deltaMin.toFixed(2)}–{active.deltaMax.toFixed(2)}</b></span>
        <span>Vencimiento <b>{active.dteMin}–{active.dteMax} días</b></span>
        <span>Cierra al <b>{active.takeProfitPct}%</b> de la prima</span>
        <span>Rola a los <b>{active.rollDte} días</b></span>
      </div>
    </div>
  );
}
