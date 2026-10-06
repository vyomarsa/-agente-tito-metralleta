"use client";

// Pestaña del Playbook del Rango — FASE 1 (semanas 1–2).
//
// Lo que esta pantalla NO tiene es tan deliberado como lo que tiene: no hay botón
// de operar, no hay setups y no hay tickets. Las dos primeras semanas del manual
// son de observación, y la pantalla se parece a la fase en la que está para que
// no se pueda usar por delante de lo que ya está medido.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Fase, Luz, Observacion, Resumen } from "@/lib/scalping";
import type { ScalpingSseEvent } from "./types";

interface Payload {
  hoy: string;
  fase: Fase;
  seguidos: string[];
  anotadosHoy: string[];
  bitacora: Observacion[];
  resumen: Resumen;
  preview?: Observacion;
  previewError?: string;
}

const LUZ_ICONO: Record<Luz, string> = { verde: "🟢", ambar: "🟡", rojo: "🔴" };
const LUZ_TEXTO: Record<Luz, string> = {
  verde: "OPERA (en fase 1: observa con atención)",
  ambar: "NO OPERES — zona de transición",
  rojo: "PELIGRO — el rango no aplica hoy",
};

const VEREDICTO_TEXTO = {
  respeto: "Respetó",
  rompio: "Rompió",
  no_llego: "No llegó",
} as const;

const FASE_TEXTO: Record<Fase, string> = {
  temprano: "Antes de las 8:00 ET — todavía no hay cadena de hoy que congelar.",
  anotar: "Ventana de anotación: los niveles se fijan AHORA, antes de las 9:30.",
  sesion: "Sesión en curso. Los niveles de hoy ya no se tocan; toca mirar.",
  calificar: "Mercado cerrado. Es la hora de contestar si el precio los respetó.",
};

const money = (n: number) => {
  const abs = Math.abs(n), s = n < 0 ? "−" : "+";
  if (abs >= 1e9) return `${s}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${s}$${(abs / 1e6).toFixed(0)}M`;
  return `${s}$${Math.round(abs).toLocaleString("en-US")}`;
};
const px = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const pct = (n: number | null | undefined, d = 0) => (n == null ? "—" : `${n.toFixed(d)}%`);

/** Una tarjeta de la rejilla: resuelta (congelada o en vivo), fallida, o en camino. */
interface Ficha {
  obs?: Observacion;
  congelada: boolean;
  error?: string;
}

export default function ScalpingPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nota, setNota] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [fichas, setFichas] = useState<Record<string, Ficha>>({});
  const [vivoBusy, setVivoBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const cargar = useCallback(async (verTicker = "") => {
    setBusy(true); setError(null);
    try {
      const url = verTicker ? `/api/scalping?preview=${encodeURIComponent(verTicker)}` : "/api/scalping";
      const res = await fetch(url, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
      setData(body as Payload);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Abre el flujo de las diez fichas. Va por SSE y no por una petición normal
   * porque las cadenas gordas (SPX, SPY) tardan ~20 s: así la rejilla se llena
   * según van saliendo en vez de quedarse un minuto en blanco.
   */
  const mirarTodos = useCallback(() => {
    esRef.current?.close();
    setVivoBusy(true);
    const es = new EventSource("/api/scalping/vivo");
    esRef.current = es;
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as ScalpingSseEvent;
      if (d.type === "obs") {
        setFichas((f) => ({ ...f, [d.observacion.ticker]: { obs: d.observacion, congelada: d.congelada } }));
      } else if (d.type === "fallo") {
        setFichas((f) => ({ ...f, [d.ticker]: { congelada: false, error: d.message } }));
      } else if (d.type === "done") {
        setVivoBusy(false); es.close();
      } else if (d.type === "error") {
        setError(d.message); setVivoBusy(false); es.close();
      }
    };
    es.onerror = () => { setVivoBusy(false); es.close(); };
  }, []);

  useEffect(() => {
    void cargar();
    mirarTodos();
    return () => esRef.current?.close();
  }, [cargar, mirarTodos]);

  const anotar = async (ticker: string) => {
    setBusy(true); setNota(null);
    try {
      const res = await fetch(`/api/scalping?ticker=${encodeURIComponent(ticker)}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
      setNota(body.guardada ? `${ticker} anotado. Esos niveles ya no se mueven hoy.` : body.nota);
      // La ficha pasa a CONGELADA con lo que devolvió el servidor, no con lo que
      // la tarjeta tenía en pantalla: `anotarSesion` vuelve a pedir los datos y
      // puede haber congelado un precio distinto del que se estaba viendo.
      if (body.observacion) {
        setFichas((f) => ({ ...f, [ticker]: { obs: body.observacion, congelada: true } }));
      }
      await cargar(preview);
    } finally {
      setBusy(false);
    }
  };

  const paso = async () => {
    setBusy(true); setNota(null);
    try {
      const res = await fetch("/api/scalping", { method: "POST" });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
      const partes = [
        body.anotadas?.length ? `anotadas: ${body.anotadas.join(", ")}` : "",
        body.calificadas?.length ? `calificadas: ${body.calificadas.join(", ")}` : "",
        body.yaEstaban?.length ? `ya estaban: ${body.yaEstaban.join(", ")}` : "",
        body.fallos?.length ? `fallos: ${body.fallos.join(" · ")}` : "",
      ].filter(Boolean);
      setNota(partes.length ? partes.join(" · ") : "Nada que hacer ahora mismo.");
      await cargar(preview);
    } finally {
      setBusy(false);
    }
  };

  const r = data?.resumen;
  const SEGUIDOS_N = data?.seguidos.length ?? 0;
  const pendientesDeVista = SEGUIDOS_N - (data?.seguidos ?? []).filter((t) => fichas[t]).length;

  return (
    <main className="sc-page">
      <div className="hb">
        <div className="hb-title">
          Playbook del Rango <span className="hb-chip">fase 1 · solo observar</span>
        </div>
        <div className="hb-right">
          <button className="sc-btn" onClick={() => void paso()} disabled={busy}>
            {busy ? "…" : "Dar un paso de bitácora"}
          </button>
        </div>
      </div>

      <div className="sc-aviso">
        <strong>Esta pestaña no opera y no va a decirte que operes.</strong> Las semanas 1–2 del manual son
        de observación: cada mañana se congelan tres niveles y el semáforo de gamma, y al cierre se contesta
        una sola pregunta — ¿el precio los respetó? El documento de origen es una <em>hipótesis reconstruida</em> a
        partir de la gráfica de un compañero, sobre una sesión de MSFT que salió 4 de 4. Estas dos semanas
        existen para saber si esa premisa aguanta en tus tickers antes de escribir una línea de ejecución.
      </div>

      {error && <div className="error-box">{error}</div>}
      {nota && <div className="sc-nota">{nota}</div>}

      {/* ── El progreso de la fase ── */}
      {r && (
        <section className="card sc-progreso">
          <div className="sc-progreso-head">
            <div>
              <div className="card-title">Progreso de la fase</div>
              <div className="card-sub">{data && FASE_TEXTO[data.fase]}</div>
            </div>
            <div className="sc-progreso-num">
              {r.sesionesDistintas}<span>/10 sesiones</span>
            </div>
          </div>
          <div className="sc-barra">
            <div className="sc-barra-fill" style={{ width: `${Math.min(100, (r.sesionesDistintas / 10) * 100)}%` }} />
          </div>
          <p className="sc-lectura">{r.lectura}</p>
          {r.fueraDeVentanaCount > 0 && (
            <p className="sc-lectura muted">
              {r.fueraDeVentanaCount} {r.fueraDeVentanaCount === 1 ? "anotación quedó" : "anotaciones quedaron"} fuera del recuento
              por haberse hecho fuera de la ventana de 8:00–9:35 ET. Se quedan en la bitácora: antes de las 8:00
              el único precio disponible es el cierre de ayer, y después de las 9:35 los niveles ya se eligen
              viendo la sesión. Ninguna de las dos mide lo mismo.
            </p>
          )}
        </section>
      )}

      {/* ── Hoy ── */}
      <section className="card">
        <div className="card-title">
          Hoy — {data?.hoy ?? "…"}
          {vivoBusy && <span className="sc-cargando">mirando {pendientesDeVista} de {SEGUIDOS_N}…</span>}
        </div>
        <div className="card-sub">
          Las diez fichas se ven en vivo. <strong>Congelada</strong> es la del día, la que cuenta; el resto es
          cómo se vería ahora mismo y cambia con el precio hasta que se anote.
        </div>
        <div className="sc-hoy">
          {(data?.seguidos ?? []).map((t) => {
            const ficha = fichas[t];
            const o = ficha?.obs;
            return (
              <div key={t} className={`sc-card sc-${o?.luz ?? "sin"}`}>
                <div className="sc-card-head">
                  <span className="sc-tk">{t}</span>
                  {o ? (
                    <span className="sc-luz">
                      {LUZ_ICONO[o.luz]} {o.luz.toUpperCase()}
                      <em className={ficha.congelada ? "sc-cong" : "sc-vivo"}>
                        {ficha.congelada ? "congelada" : "en vivo"}
                      </em>
                    </span>
                  ) : (
                    <span className="sc-luz sc-pend">{ficha?.error ? "sin datos" : "mirando…"}</span>
                  )}
                </div>

                {o && <Niveles o={o} />}
                {ficha?.error && <p className="sc-motivos sc-err">{ficha.error}</p>}
                {!o && !ficha?.error && <div className="sc-esqueleto" aria-label="cargando" />}

                {/* El botón aparece cuando la ficha aún NO es la del día, y también
                    sobre una congelada fuera de ventana, que sí puede sustituirse por
                    la de la apertura. Una congelada en ventana no lo ofrece: los
                    niveles del día se fijan una vez. */}
                {o && (!ficha.congelada || (o.fueraVentana && data?.fase === "anotar")) && (
                  <button className="sc-btn sc-btn-full" onClick={() => void anotar(t)} disabled={busy}>
                    {ficha.congelada ? "Rehacer con los niveles de la apertura" : "Congelar los niveles de hoy"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="sc-preview">
          <input
            className="sc-input"
            placeholder="Mirar otro ticker sin anotarlo (ej. TSLA)"
            value={preview}
            onChange={(e) => setPreview(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") void cargar(preview); }}
          />
          <button className="sc-btn" onClick={() => void cargar(preview)} disabled={busy || !preview}>
            Ver semáforo
          </button>
        </div>
        {data?.previewError && <div className="sc-nota">{data.previewError}</div>}
        {data?.preview && (
          <div className={`sc-card sc-${data.preview.luz} sc-card-wide`}>
            <div className="sc-card-head">
              <span className="sc-tk">{data.preview.ticker} <em>(vista, no anotado)</em></span>
              <span className="sc-luz">{LUZ_ICONO[data.preview.luz]} {data.preview.luz.toUpperCase()}</span>
            </div>
            <Niveles o={data.preview} />
            <button className="sc-btn sc-btn-full" onClick={() => void anotar(data.preview!.ticker)} disabled={busy}>
              Anotar {data.preview.ticker} en la bitácora
            </button>
          </div>
        )}
      </section>

      {/* ── El corte que decide ── */}
      {r && r.total.calificadas > 0 && (
        <section className="card">
          <div className="card-title">¿Aguantan los niveles?</div>
          <div className="card-sub">
            Los días en que el precio nunca llegó a una pared no cuentan en la tasa: no son un acierto del
            nivel, son un día sin información sobre él.
          </div>
          {/* Sin envoltorio esta tabla se desbordaba de la pantalla en el móvil:
              son 8 columnas y no caben en 375px. */}
          <div className="sc-scroll sc-scroll-corto">
          <table className="sc-tabla">
            <thead>
              <tr>
                <th>Semáforo</th><th>Sesiones</th><th>Respetó</th><th>Rompió</th>
                <th>No llegó</th><th>Tasa</th><th>Contención</th><th>Imán</th>
              </tr>
            </thead>
            <tbody>
              {(["verde", "ambar", "rojo"] as Luz[]).map((luz) => {
                const s = r.porLuz[luz];
                return (
                  <tr key={luz}>
                    <td>{LUZ_ICONO[luz]} {luz}</td>
                    <td>{s.calificadas}</td>
                    <td className="sc-ok">{s.respeto}</td>
                    <td className="sc-bad">{s.rompio}</td>
                    <td className="muted">{s.noLlego}</td>
                    <td><strong>{pct(s.tasaRespeto)}</strong></td>
                    <td>{pct(s.contenidoMedio)}</td>
                    <td>{pct(s.imanMedio)}</td>
                  </tr>
                );
              })}
              <tr className="sc-total">
                <td>Total</td>
                <td>{r.total.calificadas}</td>
                <td className="sc-ok">{r.total.respeto}</td>
                <td className="sc-bad">{r.total.rompio}</td>
                <td className="muted">{r.total.noLlego}</td>
                <td><strong>{pct(r.total.tasaRespeto)}</strong></td>
                <td>{pct(r.total.contenidoMedio)}</td>
                <td>{pct(r.total.imanMedio)}</td>
              </tr>
            </tbody>
          </table>
          </div>
          {r.porTicker.length > 1 && (
            <div className="sc-tickers">
              {r.porTicker.map(({ ticker, stats }) => (
                <span key={ticker} className="chip">
                  {ticker}: {pct(stats.tasaRespeto)} ({stats.respeto}/{stats.respeto + stats.rompio})
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── La bitácora ── */}
      <section className="card">
        <div className="card-title">Bitácora</div>
        <div className="card-sub">Una línea por sesión y ticker. Sin esto, dos semanas no enseñan nada.</div>
        {data && data.bitacora.length === 0 ? (
          <p className="empty-note">Todavía no hay ninguna sesión anotada.</p>
        ) : (
          <div className="sc-scroll">
            <table className="sc-tabla">
              <thead>
                <tr>
                  <th>Fecha</th><th>Ticker</th><th></th><th>Net GEX</th><th>Gamma frente</th>
                  <th>Piso</th><th>Centro</th><th>Techo</th><th>Apertura</th>
                  <th>Rango real</th><th>Veredicto</th>
                </tr>
              </thead>
              <tbody>
                {(data?.bitacora ?? []).map((o) => (
                  <tr key={`${o.ticker}|${o.fecha}`}>
                    <td className="muted">
                      {o.fecha}
                      {o.fueraVentana && <span className="sc-fuera" title="Anotada fuera de la ventana de 8:00–9:35 ET: no cuenta">fuera</span>}
                    </td>
                    <td><strong>{o.ticker}</strong></td>
                    <td title={o.motivos.join(" · ")}>{LUZ_ICONO[o.luz]}</td>
                    <td>{money(o.netGex)}</td>
                    <td>{pct(o.gammaFrentePct)}{o.frenteDte != null && <span className="muted"> ({o.frenteDte}d)</span>}</td>
                    <td>{px(o.niveles.piso)}</td>
                    <td>{px(o.niveles.centro)}</td>
                    <td>{px(o.niveles.techo)}</td>
                    <td>{px(o.spotApertura)}</td>
                    <td>{o.cierre ? `${px(o.cierre.bajo)} – ${px(o.cierre.alto)}` : "—"}</td>
                    <td>
                      {o.cierre ? (
                        <span className={`sc-vd sc-vd-${o.cierre.veredicto}`}>
                          {VEREDICTO_TEXTO[o.cierre.veredicto]}
                        </span>
                      ) : (
                        <span className="muted">pendiente</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── La rutina, para tenerla al lado ── */}
      <section className="card sc-rutina">
        <div className="card-title">Rutina de la fase 1</div>
        <div className="sc-rutina-cols">
          <div>
            <h4>Antes de las 9:30 — el 80% del trabajo</h4>
            <ul>
              <li>Anotar Net GEX y Gamma Flip</li>
              <li>Mirar el semáforo de régimen</li>
              <li>Comprobar las 3 preguntas del ticker (GEX grande · paredes cerca · gamma concentrada en el frente)</li>
              <li>Confirmar que no hay earnings esta semana</li>
              <li>Anotar Put Wall (piso), Call Wall (techo) y el imán (centro)</li>
              <li>Marcar máximos y mínimos de ayer</li>
            </ul>
          </div>
          <div>
            <h4>Durante la sesión</h4>
            <ul>
              <li><strong>Cero trades.</strong> Esta fase es solo mirar.</li>
              <li>Fijarse en si el precio frena en los niveles o los atraviesa</li>
              <li>Fijarse en si una vela CIERRA del lado equivocado o solo lo toca con la mecha</li>
            </ul>
            <h4>Al cierre</h4>
            <ul>
              <li>¿El precio respetó los tres niveles, sí o no?</li>
              <li>Eso es lo único que se está aprendiendo estas dos semanas</li>
            </ul>
          </div>
        </div>
        <p className="disclaimer">
          Material educativo, no consejo de inversión. La estrategia es scalping sobre la acción, no venta de
          primas: el manual avisa de que ejecutarla con opciones cortas hace que el diferencial se coma tramos
          enteros.
        </p>
      </section>
    </main>
  );
}

function Niveles({ o }: { o: Observacion }) {
  return (
    <>
      <div className="sc-niveles">
        <div className="sc-nivel sc-techo">
          <span>TECHO</span><strong>{px(o.niveles.techo)}</strong><em>Call Wall</em>
        </div>
        <div className="sc-nivel sc-centro">
          <span>CENTRO</span><strong>{px(o.niveles.centro)}</strong><em>el imán</em>
        </div>
        <div className="sc-nivel sc-piso">
          <span>PISO</span><strong>{px(o.niveles.piso)}</strong><em>Put Wall</em>
        </div>
      </div>
      <div className="sc-datos">
        <span>Apertura <strong>{px(o.spotApertura)}</strong></span>
        <span>Net GEX <strong>{money(o.netGex)}</strong></span>
        <span>Flip <strong>{px(o.flipStrike)}</strong> ({pct(o.flipDistPct, 2)})</span>
        <span>Gamma del frente <strong>{pct(o.gammaFrentePct)}</strong>{o.frenteDte != null && <em> (vence en {o.frenteDte}d)</em>}</span>
        {o.ayer && <span>Ayer <strong>{px(o.ayer.bajo)} – {px(o.ayer.alto)}</strong></span>}
      </div>
      <div className="sc-veredicto-luz">{LUZ_TEXTO[o.luz]}</div>
      <ul className="sc-motivos">
        {o.motivos.map((m, i) => <li key={i}>{m}</li>)}
      </ul>
    </>
  );
}
