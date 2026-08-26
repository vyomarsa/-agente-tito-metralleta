"use client";

import { useCallback, useEffect, useState } from "react";
import { px } from "../format";
import {
  realizedPnl,
  unrealizedPnl,
  securedGain,
  PENDING_MAX_DAYS,
  type PaperTrade,
  type PaperSummary,
} from "@/lib/paperTrade";
import {
  MAX_LOSS_PCT,
  PROFIT_FLOOR_PCT,
  dteOn,
  lossPct,
  managePosition,
  maxRiskOf,
  pnlOf,
  profitPct,
  type PrimaPosition,
  type PrimaSpreadType,
  type PrimaSummary,
} from "@/lib/primaPaper";
import {
  maxRiskOf as zeroRiskOf,
  pnlOf as zeroPnlOf,
  returnPct as zeroReturnOf,
  type ZeroPaperPosition,
  type ZeroPaperSummary,
} from "@/lib/zerodtePaper";
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

// Pestañas de "Mis Trades". Las dos primeras filtran la bitácora propia de Tito por
// la NOTA del trade (que es lo que escribe el piloto: "Swing").
//
// La pestaña "Day" se retiró el 2026-08-24 porque no hay agente de day trading todavía:
// filtraba por la nota "Day Trading", que ya nadie escribe, y salía siempre vacía. Los
// trades intradía que existan siguen en "Todos". Cómo devolverla: `_archivado/pestana-day`.
//
// "0DTE" y "Venta Prima" son distintas: no son trades del piloto, sino las cuentas
// simuladas de esos dos agentes, cada una con su capital — Tito solo las MUESTRA.
type TabId = "todos" | "swing" | "cero" | "prima";

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "todos", label: "Todos", hint: "Toda la bitácora de Tito" },
  { id: "swing", label: "Swing", hint: "Setups de varios días" },
  { id: "cero", label: "0DTE", hint: "Simulador del agente 0DTE (cuenta propia)" },
  { id: "prima", label: "Venta Prima", hint: "Simulador del bot de credit spreads (proyecto aparte)" },
];

/** Filtra por la nota del trade. "Todos" no filtra; 0DTE y Venta Prima tienen
 *  cuenta propia y no pasan por aquí. */
function matchesTab(t: PaperTrade, tab: TabId): boolean {
  const nota = (t.note ?? "").toLowerCase();
  if (tab === "swing") return nota.includes("swing");
  return true;
}

/**
 * Lo que devuelve `/api/0dte-paper`: posiciones tal cual las guarda el motor.
 * Se reusa el tipo de `lib/zerodtePaper` en vez de redeclararlo — un shape copiado
 * es un shape que puede quedarse atrás sin que nadie se entere (le pasó al panel
 * de venta de prima, que enseñaba celdas vacías por leer campos que ya no existían).
 */
interface ZpResponse {
  error?: string;
  summary?: ZeroPaperSummary;
  open?: ZeroPaperPosition[];
  closed?: ZeroPaperPosition[];
}

interface VpResponse {
  ok: boolean;
  summary?: PrimaSummary;
  open?: PrimaPosition[];
  closed?: PrimaPosition[];
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
  const [zp, setZp] = useState<ZpResponse | null>(null);

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

  // Cuenta de paper del 0DTE. Solo lectura: quien abre y cierra es /api/0dte
  // mientras la página del agente está abierta y el mercado en sesión.
  useEffect(() => {
    if (tab !== "cero" || zp) return;
    void fetch("/api/0dte-paper", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: ZpResponse) => setZp(d))
      .catch(() => setZp({ error: "sin conexión" }));
  }, [tab, zp]);

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
      {tab !== "prima" && tab !== "cero" && (
      <div className="pt-stats">
        {/* El P&L solo suma los cierres CON los dos precios. Los que se cerraron sin
            prima de salida cuentan para el acierto pero no para el dinero, y eso se
            dice aquí: dar el P&L a secas escondía que faltaban operaciones. */}
        <Stat
          label="P&L neto · cerrado"
          value={s ? signed(s.closedPnl) : "—"}
          tone={s && s.closedPnl >= 0 ? "up" : "down"}
          hint={s ? (s.priced > 0 ? `${s.priced} con precio` : "ninguna con precio") : undefined}
        />
        <Stat
          label="Aciertos"
          value={s ? `${s.wins}W · ${s.losses}L` : "—"}
          hint={s && s.unpriced > 0 ? `${s.unpriced} sin precio de salida` : undefined}
        />
        <Stat label="Win rate" value={s?.winRatePct != null ? `${Math.round(s.winRatePct)}%` : "—"} hint={s?.winRatePct != null ? "por objetivo/stop" : undefined} />
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
          <label>Nota<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Swing" /></label>
          <label className="pt-check"><input type="checkbox" checked={form.trailing} onChange={(e) => setForm({ ...form, trailing: e.target.checked })} /> Trailing de ganancia</label>
          <button className="pt-add" onClick={create}>Añadir</button>
        </div>
      </details>

      {/* Lista */}
      {tab === "prima" ? (
        <VentaPrimaPanel vp={vp} />
      ) : tab === "cero" ? (
        <ZeroDtePanel zp={zp} />
      ) : (
        <div className="pt-list">
          {visibles.length === 0 && (
            <div className="pt-empty">
              {tab === "todos"
                ? "Aún no hay trades. Añade uno arriba."
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

/**
 * Ficha COMPLETA de un trade de la bitácora (Swing / Todos).
 *
 * Hermana de `PrimaPositionCard` y `ZeroPositionCard`: las tres pestañas miden
 * agentes distintos, pero si se leyeran distinto sería imposible compararlos de un
 * vistazo. Aquí se COMPRA una opción suelta, así que —igual que en el 0DTE— el
 * riesgo máximo es la prima pagada y no hay colateral.
 *
 * Los dos planos van separados a propósito: el plan (gatillo, objetivo, stop) es del
 * SUBYACENTE, y la prima es del CONTRATO. Mezclarlos es el error clásico, y la vieja
 * ficha los daba en la misma frase corrida.
 */
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
  const sube = t.direction === "up";
  const letra = t.optionType === "call" ? "C" : "P";
  const dte = dteOn(t.expiration, new Date());

  const spot = t.currentUnderlying;
  const prima = t.entryPrice != null ? t.entryPrice * 100 * t.contracts : null;
  const valorAhora = t.currentPrice != null ? t.currentPrice * 100 * t.contracts : null;
  const salida = t.exitPrice != null ? t.exitPrice * 100 * t.contracts : null;
  const referencia = closed ? t.exitPrice : t.currentPrice;
  const rend =
    t.entryPrice != null && t.entryPrice > 0 && referencia != null
      ? (referencia - t.entryPrice) / t.entryPrice
      : null;

  // Riesgo/recompensa del PLAN, medido sobre el subyacente: lo que hay del gatillo
  // al objetivo contra lo que hay del gatillo al stop. Es lo que decide si el trade
  // merece la pena antes de mirar la prima.
  const recorrido = Math.abs(t.target - t.trigger);
  const riesgo = Math.abs(t.trigger - t.stop);
  const rr = riesgo > 0 ? recorrido / riesgo : null;

  const dist = (v: number) => (spot && spot > 0 ? ((v - spot) / spot) * 100 : null);
  const distTxt = (v: number) => {
    const d = dist(v);
    return d == null ? "—" : `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}% desde el precio`;
  };

  // La barra recorre el rango del plan (stop ↔ objetivo) con el gatillo y el precio
  // actual marcados. Es donde se decide todo, así que va en su propia barra.
  const lo = Math.min(t.stop, t.target);
  const hi = Math.max(t.stop, t.target);
  const posOf = (v: number) => `${Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))) * 100}%`;
  const diasEsperando = Math.floor((Date.now() - Date.parse(t.createdAt)) / 86_400_000);
  const caducaEn = PENDING_MAX_DAYS - diasEsperando;

  return (
    <section className={`pt-card ${t.status}`}>
      <div className="pt-card-main">
        <div className="pt-card-title">
          <b>{t.ticker} {px.format(t.strike)} {letra}</b>
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

        <div className="vpp-grid pt-grid">
          <span>Vencimiento <b>{t.expiration}</b>
            <small>{dte >= 0 ? `${dte}d` : "ya vencido"} · {t.ticker} {px.format(t.strike)}{letra}</small></span>

          <span>Precio ahora <b>{spot != null ? `$${px.format(spot)}` : "—"}</b>
            <small>{spot != null ? "último visto del subyacente" : "sin cotización todavía"}</small></span>

          {prima != null ? (
            <span>Prima pagada <b>{m0(prima)}</b>
              <small>{m2(t.entryPrice ?? 0)}/acción · es tu pérdida máxima</small></span>
          ) : (
            <span>Prima pagada <b>sin abrir</b>
              <small>se compra al cruzar el gatillo</small></span>
          )}

          {closed ? (
            <span>Salió a <b>{salida != null ? m0(salida) : "sin precio"}</b>
              <small>{t.exitPrice != null ? `${m2(t.exitPrice)}/acción` : "no hubo cotización al cerrar · el P&L no se conoce"}</small></span>
          ) : t.entryPrice == null ? (
            <span>Costaría hoy <b>{valorAhora != null ? m0(valorAhora) : "—"}</b>
              <small>{t.currentPrice != null ? `${m2(t.currentPrice)}/acción · si entrara ahora` : "aún sin prima"}</small></span>
          ) : (
            <span>Vale ahora <b>{valorAhora != null ? m0(valorAhora) : "—"}</b>
              <small>{t.currentPrice != null ? `${m2(t.currentPrice)}/acción` : "aún sin prima"}</small></span>
          )}

          <span>Rendimiento <b>{rend != null ? `${rend >= 0 ? "+" : "−"}${Math.abs(Math.round(rend * 100))}%` : "—"}</b>
            <small>{rend != null ? "sobre la prima pagada" : closed ? "sin precio de salida" : "aún sin prima"}</small></span>

          <span>Gatillo <b>${px.format(t.trigger)}</b>
            <small>{t.status === "pendiente" ? distTxt(t.trigger) : "ya cruzado"}</small></span>

          <span>Objetivo <b>${px.format(t.target)}</b>
            <small>{distTxt(t.target)}</small></span>

          <span>Stop <b>${px.format(t.stop)}</b>
            <small>{distTxt(t.stop)}</small></span>

          <span>Riesgo/recompensa <b>{rr != null ? `1 : ${rr.toFixed(1)}` : "—"}</b>
            <small>del plan · {px.format(riesgo)} de riesgo por {px.format(recorrido)} de recorrido</small></span>

          {t.trailing ? (
            <span>Trailing <b>{secured > 0 ? signed(secured) : "sin avance"}</b>
              <small>
                {t.peakPrice != null ? `pico ${m2(t.peakPrice)}/acción · ` : ""}
                asegura la mitad de lo ganado
              </small></span>
          ) : (
            <span>Trailing <b>no</b>
              <small>sale por objetivo o por stop, sin asegurar avance</small></span>
          )}

          {t.status === "pendiente" ? (
            <span>Caduca <b>en {Math.max(0, caducaEn)} día(s)</b>
              <small>lleva {diasEsperando} esperando · a los {PENDING_MAX_DAYS} el ticker se libera</small></span>
          ) : (
            <span>{closed ? "Cerrada" : "Abierta"} <b>{(closed ? t.exitAt : t.entryAt)?.slice(0, 10) ?? "—"}</b>
              <small>{t.contracts} contrato{t.contracts > 1 ? "s" : ""} · creada {t.createdAt.slice(0, 10)}</small></span>
          )}
        </div>

        <div className="vpp-bar" title="Rango del plan sobre el SUBYACENTE: del stop al objetivo, con el gatillo y el precio actual marcados.">
          <div className={`vpp-track rango ${sube ? "long" : "short"}`}>
            <span className="vpp-mark trigger" style={{ left: posOf(t.trigger) }} />
            {spot != null && <span className="vpp-mark spot" style={{ left: posOf(spot) }} />}
          </div>
          <div className="vpp-scale">
            <span>{sube ? `stop ${px.format(t.stop)}` : `objetivo ${px.format(t.target)}`}</span>
            <span>gatillo {px.format(t.trigger)}{spot != null && <> · ahora {px.format(spot)}</>}</span>
            <span>{sube ? `objetivo ${px.format(t.target)}` : `stop ${px.format(t.stop)}`}</span>
          </div>
        </div>

        {closed ? (
          <div className="vpp-rule">
            🔒 Cerrada{t.closeReason ? ` por ${t.closeReason}` : ""}
            {t.entryPrice != null && t.exitPrice != null ? (
              <> · entró a <b>{m2(t.entryPrice)}</b> y salió a <b>{m2(t.exitPrice)}</b>.</>
            ) : t.entryPrice != null ? (
              <>
                {" "}· entró a <b>{m2(t.entryPrice)}</b>, pero al cerrar no había cotización del
                contrato: el desenlace lo decidió el subyacente y <b>el P&amp;L no se conoce</b>.
              </>
            ) : (
              <> · nunca llegó a entrar, así que no hay P&amp;L.</>
            )}
          </div>
        ) : t.status === "activa" ? (
          <div className="vpp-rule">
            🟢 Cierra sola al tocar <b>{px.format(t.target)}</b> (objetivo) o <b>{px.format(t.stop)}</b> (stop)
            {t.trailing && secured > 0 && <> · el trailing ya asegura <b>{signed(secured)}</b></>}.
            {" "}<span className="vp-mut">Se revisa con el botón Actualizar; esta ficha usa el último precio guardado.</span>
          </div>
        ) : (
          <div className="vpp-rule">
            🕒 No ha entrado: espera a que {t.ticker} cruce <b>{px.format(t.trigger)}</b>
            {spot != null && <> (ahora {px.format(spot)}, {distTxt(t.trigger)})</>}. Hasta entonces no hay
            prima pagada ni P&amp;L, y el ticker queda reservado.
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
//  Pestaña "Venta Prima" — cuenta simulada que lleva el propio Tito
// ---------------------------------------------------------------------------

const VP_TIPO: Record<PrimaSpreadType, string> = {
  put_credit: "Put credit spread",
  call_credit: "Call credit spread",
};

const m0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const m2 = (n: number) => `$${n.toFixed(2)}`;
const p0 = (n: number) => `${Math.round(n * 100)}%`;

function VentaPrimaPanel({ vp }: { vp: VpResponse | null }) {
  if (!vp) return <div className="pt-empty">Cargando la cuenta de Venta Prima…</div>;
  if (!vp.ok) {
    return <div className="pt-box bad">No se pudo leer la cuenta de venta de prima.</div>;
  }
  const s = vp.summary;
  if (!s) return <div className="pt-empty">Sin datos de la cuenta.</div>;

  const abiertas = vp.open ?? [];
  const cerradas = vp.closed ?? [];
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
          <>
            {" "}· <b>{abiertas.length}</b> abierta(s) · no realizado <b>{signed(s.unrealizedPnl)}</b>
            {" "}· colateral comprometido <b>{m0(s.committed)}</b>
            {s.equity > 0 && <> ({Math.round((s.committed / s.equity) * 100)}% del capital)</>}
          </>
        )}
      </div>

      {abiertas.length > 0 && (
        <div className="vpp-list">
          {abiertas.map((p) => <PrimaPositionCard key={p.id} p={p} />)}
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
                <th>Ctr</th><th>Crédito</th><th>Colateral</th><th>P&L</th><th>Capturado</th><th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {cerradas.map((t) => (
                <tr key={t.id}>
                  <td className="vp-mut">{t.closedAt ? t.closedAt.slice(0, 10) : "—"}</td>
                  <td><b>{t.ticker}</b></td>
                  <td className="vp-mut">{VP_TIPO[t.type] ?? t.type}</td>
                  <td>{t.shortStrike}/{t.longStrike}</td>
                  <td>×{t.contracts}</td>
                  <td>{m0(t.entryCredit * 100 * t.contracts)}</td>
                  <td>{m0(maxRiskOf(t) * t.contracts)}</td>
                  <td className={(t.realizedPnl ?? 0) >= 0 ? "up" : "down"}>{signed(t.realizedPnl ?? 0)}</td>
                  <td>{p0(profitPct(t))}</td>
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

/**
 * Ficha COMPLETA de una posición abierta de venta de prima.
 *
 * Enseña lo mismo que la ficha de /spreads antes de abrir (crédito, colateral,
 * breakeven, POP, delta) más lo que solo existe una vez abierta: lo que cuesta
 * cerrarla hoy, cuánto del crédito llevas capturado y qué regla la está vigilando.
 *
 * Todo se DERIVA con las funciones del motor (`lib/primaPaper`), las mismas que usa
 * el ejecutor que abre y cierra. Si la ficha calculara por su cuenta, podría enseñar
 * un P&L distinto del que decide los cierres, y sería imposible saber cuál manda.
 */
function PrimaPositionCard({ p }: { p: PrimaPosition }) {
  const ahora = new Date();
  const dte = dteOn(p.expiration, ahora);
  const esPut = p.type === "put_credit";
  const letra = esPut ? "P" : "C";

  const capturado = profitPct(p);              // fracción del crédito ya ganada
  const perdida = lossPct(p);
  const pnl = pnlOf(p);
  const creditoTotal = p.entryCredit * 100 * p.contracts;
  const riesgoContrato = maxRiskOf(p);
  const colateral = riesgoContrato * p.contracts;
  const cerrarHoy = p.currentValue * 100 * p.contracts;
  const breakeven = esPut ? p.shortStrike - p.entryCredit : p.shortStrike + p.entryCredit;
  /** Coste de cerrar al que salta la válvula de pérdida del 30% del crédito. */
  const valorValvula = p.entryCredit * (1 + MAX_LOSS_PCT);
  const decision = managePosition(p, ahora);

  // La barra abarca de −30% (válvula de pérdida) a +100% (expira sin valor), que es
  // el recorrido real de la posición: enseñar solo 0–100% escondería el lado que
  // puede cerrarla.
  const pos = (frac: number) =>
    `${Math.max(0, Math.min(1, (frac + MAX_LOSS_PCT) / (1 + MAX_LOSS_PCT))) * 100}%`;
  const desde = capturado >= 0 ? pos(0) : pos(capturado);
  const hasta = capturado >= 0 ? pos(capturado) : pos(0);

  return (
    <section className="vpp-card">
      <header className="vpp-head">
        <b className="vpp-ticker">{p.ticker}</b>
        <span className="vpp-kind">{VP_TIPO[p.type]}</span>
        <span className="vpp-strikes">{p.shortStrike}/{p.longStrike}</span>
        <span className="vp-mut">×{p.contracts} · vence {p.expiration} · {dte}d</span>
        {p.expert && (
          <span className="vpp-tag" title="Abierta en modo experto: los filtros de contexto (macro, tendencia, nivel guardián, 1σ) iban relajados. La banda de DTE, el delta corto y la liquidez sí se exigieron igual.">
            experto
          </span>
        )}
        {p.seenInPasses ? (
          <span className="vpp-tag" title="En cuántas pasadas de observación (10:30-11:30 ET) apareció este mismo spread antes de abrirlo.">
            visto {p.seenInPasses}×
          </span>
        ) : null}
        <span className={`vpp-pnl ${pnl >= 0 ? "up" : "down"}`}>
          {signed(pnl)} <small>no realizado</small>
        </span>
      </header>

      <div className="vpp-legs">
        <span className="vpp-leg sell">VENDE <b>{p.shortStrike}{letra}</b> · Δ {p.shortDelta.toFixed(2)}</span>
        <span className="vpp-leg buy">COMPRA <b>{p.longStrike}{letra}</b></span>
        <span className="vp-mut">ancho {m2(p.width)}</span>
        <span className="vp-mut">{p.sector}</span>
      </div>

      <div className="vpp-grid">
        <span>Crédito cobrado <b>{m0(creditoTotal)}</b>
          <small>{m2(p.entryCredit)}/acción · es tu ganancia máxima</small></span>
        <span>Colateral <b>{m0(colateral)}</b>
          <small>{m0(riesgoContrato)}/contrato · es tu pérdida máxima</small></span>
        <span>Cerrarla hoy cuesta <b>{m0(cerrarHoy)}</b>
          <small>{m2(p.currentValue)}/acción</small></span>
        <span>Capturado <b>{p0(capturado)}</b>
          <small>del crédito · pico {p0(p.peakProfitPct)}</small></span>
        <span>Breakeven <b>{m2(breakeven)}</b>
          <small>ganas mientras {p.ticker} cierre {esPut ? "por encima" : "por debajo"}</small></span>
        <span>Probabilidad (POP) <b>{Math.round(p.popPct)}%</b>
          <small>al abrir · Δ corto ahora {p.shortDelta.toFixed(2)}</small></span>
        <span>Pérdida actual <b>{p0(perdida)}</b>
          <small>válvula al {p0(MAX_LOSS_PCT)}: cerrar costaría {m2(valorValvula)}</small></span>
        <span>Abierta <b>{p.openedAt.slice(0, 10)}</b>
          <small>quedan {dte} día(s) naturales al vencimiento</small></span>
      </div>

      <div
        className="vpp-bar"
        title={`Va de la válvula de pérdida (−${p0(MAX_LOSS_PCT)} del crédito) al 100% (el spread expira sin valor).`}
      >
        <div className="vpp-track">
          <div
            className={`vpp-fill ${capturado >= 0 ? "up" : "down"}`}
            style={{ left: desde, right: `calc(100% - ${hasta})` }}
          />
          <span className="vpp-mark zero" style={{ left: pos(0) }} />
          <span className="vpp-mark floor" style={{ left: pos(PROFIT_FLOOR_PCT) }} />
        </div>
        <div className="vpp-scale">
          <span>−{p0(MAX_LOSS_PCT)} · cierra</span>
          <span>entrada</span>
          <span>{p0(PROFIT_FLOOR_PCT)} · suelo del viernes</span>
          <span>100%</span>
        </div>
      </div>

      <div className={`vpp-rule ${decision.action}`}>
        {decision.action === "cerrar" ? "🔴" : decision.action === "avisar" ? "⚠️" : "🟢"}{" "}
        {decision.reason}{" "}
        <span className="vp-mut">
          Lo decide la tarea programada; esta ficha lo calcula con el último precio guardado.
        </span>
      </div>
    </section>
  );
}

const MODEL_LABEL: Record<string, string> = {
  magnet: "vuelta al imán (γ+)",
  momentum: "momentum (γ−)",
};

/** El motivo de cierre se guarda como clave; en pantalla va en cristiano. */
const ZP_REASON: Record<string, string> = {
  objetivo: "🎯 el subyacente alcanzó el objetivo",
  stop: "🛑 el subyacente alcanzó el stop",
  cierre_de_sesion: "🔔 liquidada al cierre de sesión",
};

const ZP_ESTADO: Record<string, string> = {
  abierta: "ABIERTA",
  ganada: "GANADA",
  perdida: "PERDIDA",
  expirada: "EXPIRADA",
};

const hhmm = (iso: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso.slice(11, 16);
  }
};

/**
 * Cuenta simulada del agente 0DTE. Gemela de `VentaPrimaPanel` a propósito: las
 * dos pestañas miden agentes distintos, pero si se leyeran distinto sería
 * imposible compararlos de un vistazo, que es justo para lo que existen.
 *
 * Es SOLO LECTURA. Quien abre y cierra es el tick de `/api/0dte-paper`, cada
 * minuto de sesión, con o sin la página delante.
 */
function ZeroDtePanel({ zp }: { zp: ZpResponse | null }) {
  if (!zp) return <div className="pt-empty">Cargando la cuenta del 0DTE…</div>;
  if (zp.error || !zp.summary) {
    return <div className="pt-box bad">No se pudo leer la cuenta de paper del 0DTE.</div>;
  }
  const s = zp.summary;
  const abiertas = zp.open ?? [];
  const cerradas = zp.closed ?? [];
  const tono = s.realizedPnl >= 0 ? "up" : "down";
  const retorno = s.startEquity > 0 ? ((s.equity - s.startEquity) / s.startEquity) * 100 : 0;
  const enRiesgo = abiertas.reduce((t, p) => t + zeroRiskOf(p), 0);

  return (
    <div className="vp-wrap">
      <div className="pt-stats">
        <Stat
          label="Capital simulado"
          value={`$${s.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          tone={tono}
          hint={`de $${s.startEquity.toLocaleString("en-US")} · ${retorno >= 0 ? "+" : ""}${retorno.toFixed(2)}%`}
        />
        <Stat label="P&L realizado" value={signed(s.realizedPnl)} tone={tono} hint={`${s.closedCount} cerrada(s)`} />
        <Stat
          label="Aciertos"
          value={`${s.wins}W · ${s.losses}L`}
          hint={s.expired ? `${s.expired} expirada(s)` : undefined}
        />
        <Stat
          label="Win rate"
          value={s.winRate != null ? `${s.winRate}%` : "—"}
          hint={s.winRate != null ? "sobre las decididas" : "aún sin cierres"}
        />
      </div>

      <div className="vp-note">
        🎯 <b>0DTE en paper.</b> Compra el contrato del <b>GEX Ticket</b> al mid cuando el agente
        tiene señal viva, arriesgando el 2% del capital. Cierra al objetivo o al stop del
        subyacente, y liquida lo que quede vivo al cierre de sesión. El tick corre cada minuto
        de sesión (9:30-16:00 ET) <b>aunque no haya nadie mirando</b>.
        {abiertas.length > 0 && (
          <>
            {" "}· <b>{abiertas.length}</b> abierta(s) · no realizado <b>{signed(s.openPnl)}</b>
            {" "}· en riesgo <b>{m0(enRiesgo)}</b> (la prima pagada, ni un dólar más)
          </>
        )}
      </div>

      {/* Qué modelo aporta: es la pregunta que motivó el simulador. */}
      {s.closedCount > 0 && (
        <div className="vp-open">
          {s.byModel.map((m) => (
            <div key={m.model} className="vp-openrow">
              <b>{MODEL_LABEL[m.model] ?? m.model}</b>
              <span className="vp-mut">{m.closed} cerrada(s) · {m.wins}W</span>
              <span className="vp-strikes">{m.winRate != null ? `${m.winRate}%` : "—"}</span>
              <span className={m.pnl >= 0 ? "up" : "down"}>{signed(m.pnl)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Por VERSIÓN de la geometría. Solo se enseña si hay más de una: mientras
          todas las cerradas sean del mismo modelo, este desglose no dice nada.
          Con dos, es lo único que responde si el arreglo del cono sirvió. */}
      {s.byVersion.length > 1 && (
        <div className="vp-open">
          {s.byVersion.map((v) => (
            <div key={v.version} className="vp-openrow">
              <b>{v.version === 1 ? "v1 · cono con IV de cadena" : `v${v.version} · cono con vol realizada`}</b>
              <span className="vp-mut">{v.closed} cerrada(s) · {v.wins}W</span>
              <span className="vp-strikes">{v.winRate != null ? `${v.winRate}%` : "—"}</span>
              <span className={v.pnl >= 0 ? "up" : "down"}>{signed(v.pnl)}</span>
            </div>
          ))}
        </div>
      )}

      {abiertas.length > 0 && (
        <div className="vpp-list">
          {abiertas.map((p) => <ZeroPositionCard key={p.id} p={p} />)}
        </div>
      )}

      {cerradas.length === 0 ? (
        <div className="pt-empty">
          Aún no hay operaciones cerradas. La cuenta empieza a moverse en la próxima sesión.
        </div>
      ) : (
        <div className="vp-table-wrap">
          <table className="vp-table">
            <thead>
              <tr>
                <th>Cierre</th><th>Ticker</th><th>Contrato</th><th>Modelo</th><th>Ctr</th>
                <th>Prima pagada</th><th>Entrada→Salida</th><th>Pico</th><th>Rend.</th>
                <th>Subyacente · obj / stop</th><th>P&L</th><th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {cerradas.map((p) => {
                const rend = zeroReturnOf(p);
                return (
                  <tr key={p.id}>
                    <td className="vp-mut">{hhmm(p.closedAt)}</td>
                    <td><b>{p.ticker}</b></td>
                    <td>{p.type === "call" ? "CALL" : "PUT"} {p.strike}</td>
                    <td className="vp-mut">
                      {MODEL_LABEL[p.model] ?? p.model} <small>· {p.side}</small>
                    </td>
                    <td>×{p.contracts}</td>
                    <td>{m0(zeroRiskOf(p))} <small className="vp-mut">{m2(p.entryPrice)}</small></td>
                    <td>{m2(p.entryPrice)} → {m2(p.currentPrice)}</td>
                    <td className="vp-mut">{m2(p.peakPrice)}</td>
                    <td className={rend >= 0 ? "up" : "down"}>{rend >= 0 ? "+" : "−"}{Math.abs(Math.round(rend * 100))}%</td>
                    <td className="vp-mut">
                      {p.entrySpot.toFixed(2)} · {p.target.toFixed(2)} / {p.stop.toFixed(2)}
                    </td>
                    <td className={(p.realizedPnl ?? 0) >= 0 ? "up" : "down"}>{signed(p.realizedPnl ?? 0)}</td>
                    <td className="vp-mut vp-why">{ZP_REASON[p.closeReason ?? ""] ?? p.closeReason ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Ficha COMPLETA de una posición abierta del 0DTE. Gemela de `PrimaPositionCard`,
 * pero la mecánica es la contraria y eso cambia lo que hay que enseñar:
 *
 *   · Aquí se COMPRA, así que el riesgo máximo es la prima pagada — no hay colateral.
 *   · Las reglas se deciden sobre el SUBYACENTE (objetivo/stop del modelo) mientras
 *     que el P&L se calcula sobre el CONTRATO. Van en bloques separados a propósito:
 *     mezclar los dos planos es el error clásico del 0DTE.
 *   · Todo vence hoy: lo que siga vivo a las 16:00 ET se liquida.
 *
 * Se deriva todo con las funciones de `lib/zerodtePaper`, las mismas que usa el tick
 * que abre y cierra, para que la ficha no pueda enseñar un P&L distinto del que manda.
 */
function ZeroPositionCard({ p }: { p: ZeroPaperPosition }) {
  const pnl = zeroPnlOf(p);
  const rend = zeroReturnOf(p);
  const prima = zeroRiskOf(p);                      // prima pagada = riesgo máximo
  const ahora = p.currentPrice * 100 * p.contracts;
  const pico = p.peakPrice * 100 * p.contracts;
  const esCall = p.type === "call";
  const largo = p.side === "LONG";

  // Recorrido del subyacente entre el stop y el objetivo, con la entrada marcada.
  // Es donde se DECIDE la posición, así que va en su propia barra.
  const lo = Math.min(p.stop, p.target);
  const hi = Math.max(p.stop, p.target);
  const spotPos = (v: number) => `${Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))) * 100}%`;

  return (
    <section className="vpp-card">
      <header className="vpp-head">
        <b className="vpp-ticker">{p.ticker}</b>
        <span className="vpp-kind">{esCall ? "Call comprada" : "Put comprada"}</span>
        <span className="vpp-strikes">{p.strike}{esCall ? "C" : "P"}</span>
        <span className="vp-mut">×{p.contracts} · vence {p.expiration} · 0DTE</span>
        <span className="vpp-tag" title="Modelo del agente que generó la idea.">
          {MODEL_LABEL[p.model] ?? p.model}
        </span>
        <span className="vpp-tag" title={largo ? "La idea es que el subyacente SUBE." : "La idea es que el subyacente BAJA."}>
          {largo ? "↑ LONG" : "↓ SHORT"}
        </span>
        <span className={`vpp-pnl ${pnl >= 0 ? "up" : "down"}`}>
          {signed(pnl)} <small>no realizado</small>
        </span>
      </header>

      <div className="vpp-legs">
        <span className="vpp-leg buy">COMPRA <b>{p.strike}{esCall ? "C" : "P"}</b> · {m2(p.entryPrice)}</span>
        <span className="vp-mut">{p.optionSymbol}</span>
        <span className="vp-mut">abierta {hhmm(p.openedAt)}</span>
      </div>

      <div className="vpp-grid">
        <span>Prima pagada <b>{m0(prima)}</b>
          <small>{m2(p.entryPrice)}/acción · es tu pérdida máxima</small></span>
        <span>Vale ahora <b>{m0(ahora)}</b>
          <small>{m2(p.currentPrice)}/acción</small></span>
        <span>Rendimiento <b>{rend >= 0 ? "+" : "−"}{Math.abs(Math.round(rend * 100))}%</b>
          <small>sobre la prima pagada</small></span>
        <span>Pico <b>{m0(pico)}</b>
          <small>{m2(p.peakPrice)}/acción · lo mejor que llegó a valer</small></span>
        <span>Entrada (subyacente) <b>{p.entrySpot.toFixed(2)}</b>
          <small>el precio al que el modelo dio la señal</small></span>
        <span>Objetivo <b>{p.target.toFixed(2)}</b>
          <small>{Math.abs(((p.target - p.entrySpot) / p.entrySpot) * 100).toFixed(2)}% desde la entrada · cierra ahí</small></span>
        <span>Stop <b>{p.stop.toFixed(2)}</b>
          <small>{Math.abs(((p.stop - p.entrySpot) / p.entrySpot) * 100).toFixed(2)}% desde la entrada · cierra ahí</small></span>
        <span>Estado <b>{ZP_ESTADO[p.status] ?? p.status}</b>
          <small>{p.contracts} contrato{p.contracts > 1 ? "s" : ""} · {MODEL_LABEL[p.model] ?? p.model}</small></span>
      </div>

      <div className="vpp-bar" title="Recorrido del SUBYACENTE entre el stop y el objetivo. La posición se decide aquí, no en la prima.">
        <div className={`vpp-track rango ${largo ? "long" : "short"}`}>
          <span className="vpp-mark spot" style={{ left: spotPos(p.entrySpot) }} />
        </div>
        <div className="vpp-scale">
          <span>{largo ? `stop ${p.stop.toFixed(2)}` : `objetivo ${p.target.toFixed(2)}`}</span>
          <span>entrada {p.entrySpot.toFixed(2)}</span>
          <span>{largo ? `objetivo ${p.target.toFixed(2)}` : `stop ${p.stop.toFixed(2)}`}</span>
        </div>
      </div>

      <div className="vpp-rule">
        🟢 Se cierra sola cuando {p.ticker} toque <b>{p.target.toFixed(2)}</b> (objetivo) o{" "}
        <b>{p.stop.toFixed(2)}</b> (stop); si llega a los dos entre dos consultas manda el objetivo.
        Lo que siga vivo a las <b>16:00 ET</b> se liquida al último mid — es 0DTE, no hay mañana.{" "}
        <span className="vp-mut">Lo decide el tick de cada minuto; esta ficha lo muestra con el último precio guardado.</span>
      </div>
    </section>
  );
}
