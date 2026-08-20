"use client";

import { useCallback, useEffect, useState } from "react";
import { px } from "../format";
import {
  realizedPnl,
  unrealizedPnl,
  securedGain,
  type PaperTrade,
  type PaperSummary,
} from "@/lib/paperTrade";
import type { TradesResponse } from "./types";

// "Mis Trades" — bitácora de paper trades CONDICIONALES (Fase 1, manual). Cada trade es un
// plan con gatillo: no "entra" hasta que el subyacente cruza un nivel. El P&L es hipotético:
// ningún dólar real se mueve. El botón Actualizar re-cotiza los abiertos y avanza estados.

function signed(n: number): string {
  const r = Math.round(n);
  return `${r >= 0 ? "+" : "−"}$${Math.abs(r).toLocaleString("en-US")}`;
}
const STATUS_LABEL: Record<string, string> = {
  pendiente: "PENDIENTE",
  activa: "ACTIVA",
  ganada: "GANADA",
  perdida: "PERDIDA",
  expirada: "EXPIRADA",
};

const EMPTY_FORM = {
  ticker: "",
  optionType: "call",
  strike: "",
  expiration: "",
  direction: "auto",
  trigger: "",
  target: "",
  stop: "",
  contracts: "1",
  probability: "",
  note: "",
  trailing: true,
};

// Pestañas de "Mis Trades". Las tres primeras filtran la bitácora propia de Tito por
// la NOTA del trade (que es lo que escribe el piloto: "Swing" / "Day Trading").
// "Venta Prima" es distinta: no son trades de Tito, sino el libro del bot Python que
// corre aparte — Tito solo lo MUESTRA.
type TabId = "todos" | "swing" | "day" | "cero" | "prima";

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "todos", label: "Todos", hint: "Toda la bitácora de Tito" },
  { id: "swing", label: "Swing", hint: "Setups de varios días" },
  { id: "day", label: "Day", hint: "Intradía" },
  { id: "cero", label: "0DTE", hint: "Contratos que vencen el mismo día" },
  { id: "prima", label: "Venta Prima", hint: "Simulador del bot de credit spreads (proyecto aparte)" },
];

/** Filtra por la nota del trade. "Todos" no filtra. */
function matchesTab(t: PaperTrade, tab: TabId): boolean {
  const nota = (t.note ?? "").toLowerCase();
  if (tab === "swing") return nota.includes("swing");
  if (tab === "day") return nota.includes("day");
  if (tab === "cero") return nota.includes("0dte") || nota.includes("zero");
  return true;
}

interface VpTradeRow {
  id: string; underlying: string; spreadType: string;
  shortStrike: number | null; longStrike: number | null; contracts: number;
  pnl: number; profitPctOfMax: number; outcome: string; closeReason: string; exitDate: string;
}
interface VpResponse {
  ok: boolean; botFound?: boolean; botDir?: string;
  summary?: {
    startEquity: number; realizedPnl: number; equity: number; returnPct: number;
    trades: number; wins: number; losses: number; neutral: number; winRate: number | null;
    equityCurve: number[]; openCount?: number; unrealizedPnl?: number; committed?: number;
  };
  trades?: VpTradeRow[];
  closed?: VpTradeRow[];
  open?: { underlying: string; spreadType: string; shortStrike: number | null; longStrike: number | null; contracts: number; expiration: string }[];
  unrealized?: number;
}

export default function TradesPage() {
  const [data, setData] = useState<TradesResponse | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("todos");
  const [vp, setVp] = useState<VpResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/trades", { cache: "no-store" });
      setData(await r.json());
    } catch {
      setErr("No se pudo cargar la bitácora.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const post = async (body: Record<string, unknown>, url = "/api/trades") => {
    setErr(null);
    setMsg(null);
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await r.json()) as TradesResponse;
    if (!d.ok) {
      setErr(d.error ?? "Error.");
      return null;
    }
    setData(d);
    return d;
  };

  const refresh = async () => {
    setRefreshing(true);
    const d = await post({}, "/api/trades/refresh");
    setRefreshing(false);
    if (d) {
      // Se enumera SOLO lo que ocurrió: una fila de ceros no dice nada y esconde
      // lo que sí pasó. Las caducadas llevan los tickers porque son los que quedan
      // libres para el piloto, que es la razón de ser de la caducidad.
      const t = d.tally;
      const partes: string[] = [];
      if (t) {
        if (t.activadas) partes.push(`${t.activadas} activada(s)`);
        if (t.ganadas) partes.push(`${t.ganadas} ganada(s)`);
        if (t.perdidas) partes.push(`${t.perdidas} perdida(s)`);
        if (t.expiradas) partes.push(`${t.expiradas} expirada(s)`);
        if (t.caducadas) {
          const quienes = d.caducadasTickers?.length ? ` (${d.caducadasTickers.join(", ")})` : "";
          partes.push(`${t.caducadas} caducada(s)${quienes} · ticker libre para el piloto`);
        }
      }
      const detalle = partes.length ? ` · ${partes.join(" · ")}` : " · sin cambios";
      const w = d.warnings?.unquoted?.length ? ` · sin prima: ${d.warnings.unquoted.join(", ")}` : "";
      setMsg(`Actualizado · ${d.revisados ?? d.changed ?? 0} revisado(s)${detalle}${w}`);
    }
  };

  const scan = async () => {
    setScanning(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/autopilot/scan", { method: "POST" });
      const d = await r.json();
      if (!d.ok) {
        setErr(d.error ?? "El piloto falló.");
      } else {
        const w = d.warnings?.length ? ` · ${d.warnings.join(" ")}` : "";
        setMsg(`🤖 Piloto: ${d.opened.length} trade(s) AUTO abierto(s) de ${d.counts.candidates} candidato(s)${w}`);
        await load();
      }
    } catch {
      setErr("Error de red al escanear.");
    } finally {
      setScanning(false);
    }
  };

  // Cuenta de venta de prima: ahora la lleva el propio Tito (`/api/prima-paper`),
  // no el bot Python. Se pide solo al abrir su pestaña, no en cada refresco.
  useEffect(() => {
    if (tab !== "prima" || vp) return;
    void fetch("/api/prima-paper", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: VpResponse) => setVp(d))
      .catch(() => setVp({ ok: false, botFound: false } as VpResponse));
  }, [tab, vp]);

  const create = async () => {
    const d = await post({ action: "create", ...form });
    if (d) {
      setForm({ ...EMPTY_FORM });
      setMsg("✅ Trade añadido a la bitácora.");
    }
  };

  const s = data?.summary;
  const visibles = (data?.trades ?? []).filter((t) => matchesTab(t, tab));

  return (
    <main className="pt-page">
      <div className="pt-head">
        <div>
          <h1 className="pt-title">
            Mis Trades <span className="pt-sim">◍ SIMULACIÓN</span>
          </h1>
          <p className="pt-sub">
            Planes condicionales (contrato + gatillo + objetivo/probabilidad + stop). El P&amp;L es
            hipotético — <b>ningún dólar real se mueve</b>. Mide qué tan certero es.
          </p>
        </div>
        <div className="pt-head-actions">
          <button className="pt-scan" onClick={scan} disabled={scanning} title="Escanea el mercado y abre setups fuertes como paper AUTO">
            {scanning ? "Escaneando…" : "🤖 Escanear (piloto)"}
          </button>
          <button className="pt-refresh" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Actualizando…" : "Actualizar"}
          </button>
        </div>
      </div>

      {msg && <div className="pt-box ok">{msg}</div>}
      {err && <div className="pt-box bad">{err}</div>}

      <div className="pt-tabs" role="tablist" aria-label="Estrategia">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`pt-tab ${tab === t.id ? "on" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Stats de la bitácora de Tito. En la pestaña de Venta Prima se ocultan: esos
          números son de OTRA estrategia y verlos juntos se lee como si fueran la misma
          cuenta (salían "38/22 pendientes" al lado del capital del bot). */}
      {tab !== "prima" && (
      <div className="pt-stats">
        <Stat label="P&L neto · cerrado" value={s ? signed(s.closedPnl) : "—"} tone={s && s.closedPnl >= 0 ? "up" : "down"} />
        <Stat label="Aciertos" value={s ? `${s.wins}W · ${s.losses}L` : "—"} />
        <Stat label="Win rate" value={s?.winRatePct != null ? `${Math.round(s.winRatePct)}%` : "—"} />
        <Stat
          label="Pendientes / Activas"
          value={s ? `${s.pending} / ${s.active}` : "—"}
          hint={s && s.active > 0 ? `(${signed(s.openUnrealized)})` : undefined}
        />
      </div>
      )}

      {/* Alta manual */}
      <details className="pt-new">
        <summary>＋ Nuevo trade (manual)</summary>
        <div className="pt-form">
          <label>Ticker<input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} placeholder="IWM" /></label>
          <label>Tipo
            <select value={form.optionType} onChange={(e) => setForm({ ...form, optionType: e.target.value })}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </label>
          <label>Strike<input value={form.strike} onChange={(e) => setForm({ ...form, strike: e.target.value })} placeholder="295" inputMode="decimal" /></label>
          <label>Vencimiento<input type="date" value={form.expiration} onChange={(e) => setForm({ ...form, expiration: e.target.value })} /></label>
          <label>Dirección
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
              <option value="auto">Auto (call↑ / put↓)</option>
              <option value="up">Sube ↑</option>
              <option value="down">Baja ↓</option>
            </select>
          </label>
          <label>Gatillo<input value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })} placeholder="296" inputMode="decimal" /></label>
          <label>Objetivo<input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="297" inputMode="decimal" /></label>
          <label>Stop<input value={form.stop} onChange={(e) => setForm({ ...form, stop: e.target.value })} placeholder="295" inputMode="decimal" /></label>
          <label>Contratos<input value={form.contracts} onChange={(e) => setForm({ ...form, contracts: e.target.value })} inputMode="numeric" /></label>
          <label>Prob %<input value={form.probability} onChange={(e) => setForm({ ...form, probability: e.target.value })} placeholder="65" inputMode="numeric" /></label>
          <label>Nota<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Day Trading" /></label>
          <label className="pt-check"><input type="checkbox" checked={form.trailing} onChange={(e) => setForm({ ...form, trailing: e.target.checked })} /> Trailing de ganancia</label>
          <button className="pt-add" onClick={create}>Añadir</button>
        </div>
      </details>

      {/* Lista */}
      {tab === "prima" ? (
        <VentaPrimaPanel vp={vp} />
      ) : (
        <div className="pt-list">
          {visibles.length === 0 && (
            <div className="pt-empty">
              {tab === "todos"
                ? "Aún no hay trades. Añade uno arriba."
                : tab === "cero"
                  ? "Sin trades 0DTE todavía. El piloto abre Swing y Day; los 0DTE se etiquetan con la nota \"0DTE\"."
                  : "Sin trades en esta pestaña."}
            </div>
          )}
          {visibles.map((t) => (
            <TradeCard
              key={t.id}
              t={t}
              onContracts={(n) => post({ action: "setContracts", id: t.id, contracts: n })}
              onClose={() => post({ action: "close", id: t.id })}
              onDelete={() => post({ action: "delete", id: t.id })}
            />
          ))}
        </div>
      )}

      <p className="pt-disclaimer">
        ◍ Todo es <b>SIMULACIÓN / paper</b>. "Probabilidad" = fuerza del setup, no una garantía.
        No es consejo de inversión. Tú ejecutas a mano en tu bróker si quieres.
      </p>
    </main>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "up" | "down"; hint?: string }) {
  return (
    <div className="pt-stat">
      <div className="pt-stat-label">{label}</div>
      <div className={`pt-stat-value ${tone ?? ""}`}>
        {value} {hint && <span className="pt-stat-hint">{hint}</span>}
      </div>
    </div>
  );
}

function TradeCard({
  t,
  onContracts,
  onClose,
  onDelete,
}: {
  t: PaperTrade;
  onContracts: (n: number) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const closed = t.status === "ganada" || t.status === "perdida" || t.status === "expirada";
  const pnl = closed ? realizedPnl(t) : unrealizedPnl(t);
  const secured = securedGain(t);
  const arrow = t.direction === "up" ? "↑" : "↓";

  return (
    <section className={`pt-card ${t.status}`}>
      <div className="pt-card-main">
        <div className="pt-card-title">
          <b>{t.ticker} {px.format(t.strike)} {t.optionType === "call" ? "C" : "P"}</b>
          {t.note && <span className="pt-note">{t.note}</span>}
          <span className="pt-dir">{arrow}</span>
          {t.probability != null && <span className="pt-prob">prob {Math.round(t.probability)}%</span>}
          {t.source === "auto" && <span className="pt-tag auto">AUTO</span>}
          <span className={`pt-tag st ${t.status}`}>{STATUS_LABEL[t.status]}</span>
          {!closed && (
            <span className="pt-stepper">
              <button onClick={() => onContracts(Math.max(1, t.contracts - 1))} aria-label="menos">−</button>
              <span>{t.contracts} contrato{t.contracts > 1 ? "s" : ""}</span>
              <button onClick={() => onContracts(t.contracts + 1)} aria-label="más">+</button>
            </span>
          )}
        </div>

        <div className="pt-plan">
          Entra al cruzar <b>{px.format(t.trigger)}</b> · objetivo <b>{px.format(t.target)}</b> · stop{" "}
          <b>{px.format(t.stop)}</b>
          {t.trailing && <span className="pt-trail"> ▲ trailing</span>}
        </div>

        {closed ? (
          <div className="pt-exec">
            {t.entryPrice != null && <>Entró <b>${px.format(t.entryPrice)}</b></>}
            {t.exitPrice != null && <> → salió <b>${px.format(t.exitPrice)}</b></>}
            {t.closeReason && <> · {t.closeReason}</>}
          </div>
        ) : t.status === "activa" ? (
          <div className="pt-exec">
            Entró a <b>${px.format(t.entryPrice ?? 0)}</b>
            {t.currentPrice != null && <> · ahora <b>${px.format(t.currentPrice)}</b></>}
            {t.currentUnderlying != null && <> · precio <b>${px.format(t.currentUnderlying)}</b></>}
            {t.trailing && secured > 0 && <span className="pt-secure"> · 🔒 asegura {signed(secured)}</span>}
          </div>
        ) : (
          <div className="pt-exec muted">
            Esperando que el precio cruce {px.format(t.trigger)}
            {t.currentUnderlying != null && <> · ahora <b>${px.format(t.currentUnderlying)}</b></>}
          </div>
        )}

        {closed && t.verdict && <div className="pt-verdict">🎯 {t.verdict}</div>}
      </div>

      <div className="pt-card-side">
        <div className={`pt-pnl ${pnl >= 0 ? "up" : "down"}`}>{signed(pnl)}</div>
        <div className="pt-pnl-note">{closed ? "realizado" : t.status === "activa" ? "no realizado" : "sin abrir"}</div>
        <div className="pt-actions">
          {!closed && <button className="pt-close" onClick={onClose}>Cerrar</button>}
          <button className="pt-del" onClick={onDelete} aria-label="eliminar">×</button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
//  Pestaña "Venta Prima" — cuenta simulada del bot que corre APARTE
// ---------------------------------------------------------------------------

function VentaPrimaPanel({ vp }: { vp: VpResponse | null }) {
  if (!vp) return <div className="pt-empty">Cargando la cuenta de Venta Prima…</div>;
  if (!vp.ok) {
    return <div className="pt-box bad">No se pudo leer la cuenta de venta de prima.</div>;
  }
  const s = vp.summary;
  if (!s) return <div className="pt-empty">Sin datos de la cuenta.</div>;

  const abiertas = vp.open ?? [];
  const cerradas = vp.closed ?? vp.trades ?? [];
  const tono = s.realizedPnl >= 0 ? "up" : "down";

  return (
    <div className="vp-wrap">
      <div className="pt-stats">
        <Stat
          label="Capital simulado"
          value={`$${s.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          tone={tono}
          hint={`de $${s.startEquity.toLocaleString("en-US")} · ${s.returnPct >= 0 ? "+" : ""}${s.returnPct}%`}
        />
        <Stat label="P&L realizado" value={signed(s.realizedPnl)} tone={tono} hint={`${s.trades} cerrada(s)`} />
        <Stat label="Aciertos" value={`${s.wins}W · ${s.losses}L`} hint={s.neutral ? `${s.neutral} neutra(s)` : undefined} />
        <Stat
          label="Win rate"
          value={s.winRate != null ? `${Math.round(s.winRate)}%` : "—"}
          hint={s.winRate != null ? "sobre las decididas" : "aún sin cierres"}
        />
      </div>

      <div className="vp-note">
        ✂️ Venta de prima en <b>paper</b>, con el mismo motor de <b>Venta Prima</b> (103 símbolos,
        Δ 0.10–0.15, 4–7 DTE). Abre los <b>lunes</b>, revisa la pérdida del <b>30%</b> desde el
        miércoles, y aguanta a vencimiento salvo que el viernes retroceda desde el 50%.
        {abiertas.length > 0 && (
          <> · <b>{abiertas.length}</b> abierta(s){s.unrealizedPnl != null && <> · no realizado <b>{signed(s.unrealizedPnl)}</b></>}</>
        )}
      </div>

      {abiertas.length > 0 && (
        <div className="vp-open">
          {abiertas.map((p, i) => (
            <div key={i} className="vp-openrow">
              <b>{p.underlying}</b> <span className="vp-type">{p.spreadType}</span>
              <span className="vp-strikes">
                {p.shortStrike != null ? `${p.shortStrike}/${p.longStrike}` : "—"}
              </span>
              <span className="vp-mut">×{p.contracts} · vence {p.expiration}</span>
            </div>
          ))}
        </div>
      )}

      {cerradas.length === 0 ? (
        <div className="pt-empty">
          Aún no hay operaciones cerradas. El win rate y la curva aparecen tras el primer cierre.
        </div>
      ) : (
        <div className="vp-table-wrap">
          <table className="vp-table">
            <thead>
              <tr>
                <th>Cierre</th><th>Subyacente</th><th>Tipo</th><th>Strikes</th>
                <th>Ctr</th><th>P&L</th><th>Capturado</th><th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {cerradas.map((t) => (
                <tr key={t.id || `${t.underlying}-${t.exitDate}`}>
                  <td className="vp-mut">{t.exitDate || "—"}</td>
                  <td><b>{t.underlying}</b></td>
                  <td className="vp-mut">{t.spreadType}</td>
                  <td>{t.shortStrike != null ? `${t.shortStrike}/${t.longStrike}` : "—"}</td>
                  <td>×{t.contracts}</td>
                  <td className={t.pnl >= 0 ? "up" : "down"}>{signed(t.pnl)}</td>
                  <td>{Math.round(t.profitPctOfMax * 100)}%</td>
                  <td className="vp-mut vp-why">{t.closeReason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
