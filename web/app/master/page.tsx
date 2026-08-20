"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { px } from "../format";
import type { MasterView, MasterTickerView, CrossCheck, TokenStatus, ParsedSegment } from "./types";

// Sección "Pre-market del Master": ingiere el análisis que el master manda cada mañana
// por WhatsApp (tú lo reenvías a un bot de Telegram) y lo cruza con los indicadores del
// agente (precio · SMA 50 · SMA 200) para cada símbolo de su roster fijo. El texto del
// master se muestra TAL CUAL; el cruce es contexto, no una recomendación de operar.

function ago(ms: number | null): string {
  if (!ms) return "—";
  const mins = Math.round((Date.now() - ms) / 60000);
  return mins < 1 ? "hace un momento" : mins < 60 ? `hace ${mins} min` : `hace ${Math.round(mins / 60)} h`;
}

const biasLabel: Record<string, string> = { alcista: "▲ alcista", bajista: "▼ bajista", lateral: "● lateral" };

export default function MasterPage() {
  const [view, setView] = useState<MasterView | null>(null);
  const [token, setToken] = useState<TokenStatus | null>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadView = useCallback(async () => {
    try {
      const r = await fetch("/api/master", { cache: "no-store" });
      setView(await r.json());
    } catch {
      setErr("No se pudo cargar el análisis del master.");
    }
  }, []);

  const loadToken = useCallback(async () => {
    try {
      const r = await fetch("/api/telegram/token", { cache: "no-store" });
      setToken(await r.json());
    } catch {
      /* no bloqueante */
    }
  }, []);

  useEffect(() => {
    loadView();
    loadToken();
  }, [loadView, loadToken]);

  const saveToken = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/telegram/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: paste }),
      });
      const d = await r.json();
      if (d.ok) { setMsg("✅ Bot conectado."); setPaste(""); setToken(d.status); }
      else setErr(d.error ?? "No se pudo guardar el token.");
    } catch {
      setErr("Error de red al guardar el token.");
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setSyncing(true); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/master/sync", { method: "POST" });
      const d = await r.json();
      if (d.ok) {
        setMsg(d.added > 0 ? `✅ ${d.added} mensaje(s) ingerido(s).` : "Sin mensajes nuevos en Telegram.");
        await loadView();
      } else setErr(d.error ?? "No se pudo sincronizar.");
    } catch {
      setErr("Error de red al sincronizar.");
    } finally {
      setSyncing(false);
    }
  };

  const connected = token?.live && token.source !== "none";

  return (
    <main className="mstr-page">
      <div className="mstr-head">
        <div>
          <h1 className="mstr-title">🧠 Pre-market del Master</h1>
          <p className="mstr-sub">
            {view ? `${view.date}${view.updatedAt ? ` · sincronizado ${ago(view.updatedAt)}` : ""}` : "Cargando…"}
          </p>
        </div>
        <button className="mstr-sync" onClick={sync} disabled={syncing || !connected}>
          {syncing ? "Sincronizando…" : "↻ Sincronizar desde Telegram"}
        </button>
      </div>

      {msg && <div className="mstr-box ok">{msg}</div>}
      {err && <div className="mstr-box bad">{err}</div>}

      {/* Vía principal: pegar el texto del master y subir las gráficas, sin Telegram. */}
      <PasteImport onDone={loadView} />

      {/* Vía alternativa por Telegram (se colapsa siempre; es opcional). */}
      <details className="mstr-conn">
        <summary>
          {connected
            ? `🔗 Alternativa · bot de Telegram conectado como @${token?.botUsername}`
            : "🔌 Alternativa · recibir por un bot de Telegram"}
        </summary>
        <div className="mstr-conn-body">
          <ol className="mstr-steps">
            <li>En Telegram, habla con <code>@BotFather</code> → <code>/newbot</code> y copia el token.</li>
            <li>Pégalo aquí y guárdalo. Luego escríbele algo a tu bot para que pueda verte.</li>
            <li>Cada mañana, reenvía los mensajes del master a ese chat y pulsa <b>Sincronizar</b>.</li>
          </ol>
          <div className="mstr-token-row">
            <input
              type="password"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="123456789:AA…"
              className="mstr-input"
            />
            <button className="mstr-btn" onClick={saveToken} disabled={busy || !paste.trim()}>
              {busy ? "Probando…" : "Guardar"}
            </button>
          </div>
        </div>
      </details>

      {view?.news && (
        <section className="mstr-news">
          <div className="mstr-card-title">📰 Noticias del día</div>
          <p className="mstr-text">{view.news.text}</p>
          {view.news.image && <ChartImg name={view.news.image} />}
        </section>
      )}

      <div className="mstr-grid">
        {view?.tickers.map((t) => <TickerCard key={t.ticker} t={t} />)}
      </div>

      <p className="mstr-disclaimer">
        ⚠ El texto es del master, tal cual lo envió. El cruce (precio · SMA 50 · SMA 200) es contexto del
        agente, <b>no una recomendación</b>. Tú decides y ejecutas.
      </p>
    </main>
  );
}

// Pegar el análisis del master (todas las compañías juntas, como lo copias de WhatsApp) y
// adjuntar la gráfica de cada compañía. Dos pasos: (1) "Analizar" trocea el texto con el
// mismo parser del roster y muestra las secciones detectadas; (2) le sueltas la gráfica a
// cada una y "Guardar" lo ingiere en Tito, idéntico a como se ve la vía de Telegram.
function PasteImport({ onDone }: { onDone: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [segments, setSegments] = useState<ParsedSegment[] | null>(null);
  const [images, setImages] = useState<Record<number, File>>({});
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setText(""); setSegments(null); setImages({}); setNote(null); setError(null);
  };

  const analyze = async () => {
    setParsing(true); setError(null); setNote(null); setSegments(null); setImages({});
    try {
      const r = await fetch("/api/master/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (r.ok) setSegments(d.segments as ParsedSegment[]);
      else setError(d.error ?? "No se pudo analizar el texto.");
    } catch {
      setError("Error de red al analizar el texto.");
    } finally {
      setParsing(false);
    }
  };

  const attach = (index: number, file: File | null) => {
    setImages((prev) => {
      const next = { ...prev };
      if (file) next[index] = file;
      else delete next[index];
      return next;
    });
  };

  const save = async () => {
    setSaving(true); setError(null); setNote(null);
    try {
      const fd = new FormData();
      fd.append("text", text);
      for (const [index, file] of Object.entries(images)) fd.append(`img_${index}`, file);
      const r = await fetch("/api/master/paste", { method: "POST", body: fd });
      const d = await r.json();
      if (d.ok) {
        setNote(`✅ ${d.added} sección(es) guardada(s). Se ven abajo.`);
        await onDone();
        reset();
      } else setError(d.error ?? "No se pudo guardar.");
    } catch {
      setError("Error de red al guardar.");
    } finally {
      setSaving(false);
    }
  };

  const companies = segments?.filter((s) => s.ticker).length ?? 0;

  return (
    <section className="mstr-paste">
      <div className="mstr-card-title">📋 Pegar análisis del master</div>
      <p className="mstr-paste-help">
        Copia TODO el texto del master de WhatsApp (todas las compañías juntas) y pégalo aquí.
        Luego le adjuntas la gráfica a cada compañía. No necesitas Telegram.
      </p>
      <textarea
        className="mstr-paste-area"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Pega aquí el pre-market del master…"
        rows={6}
      />
      <div className="mstr-paste-actions">
        <button className="mstr-btn" onClick={analyze} disabled={parsing || !text.trim()}>
          {parsing ? "Analizando…" : "① Analizar texto"}
        </button>
        {segments && (
          <span className="mstr-paste-count">
            {companies} compañía(s){segments.length > companies ? " + noticias" : ""} detectada(s)
          </span>
        )}
      </div>

      {note && <div className="mstr-box ok">{note}</div>}
      {error && <div className="mstr-box bad">{error}</div>}

      {segments && (
        <>
          <div className="mstr-seglist">
            {segments.map((s) => (
              <SegRow key={s.index} seg={s} file={images[s.index] ?? null} onAttach={attach} />
            ))}
          </div>
          <div className="mstr-paste-actions">
            <button className="mstr-btn" onClick={save} disabled={saving}>
              {saving ? "Guardando…" : "② Guardar en Tito"}
            </button>
            <button className="mstr-btn ghost" onClick={reset} disabled={saving}>
              Limpiar
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function SegRow({
  seg,
  file,
  onAttach,
}: {
  seg: ParsedSegment;
  file: File | null;
  onAttach: (index: number, file: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  return (
    <div className="mstr-seg">
      <div className="mstr-seg-main">
        <div className="mstr-seg-name">
          {seg.ticker ? <b>{seg.label}</b> : <span className="mstr-seg-news">📰 {seg.label}</span>}
        </div>
        <p className="mstr-seg-preview">{seg.preview}</p>
      </div>
      <div className="mstr-seg-file">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="Gráfica adjunta" className="mstr-thumb" />
        ) : (
          <div className="mstr-thumb empty">sin gráfica</div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onAttach(seg.index, e.target.files?.[0] ?? null)}
        />
        <button className="mstr-btn ghost sm" onClick={() => inputRef.current?.click()}>
          {file ? "Cambiar" : "Adjuntar gráfica"}
        </button>
        {file && (
          <button className="mstr-btn ghost sm" onClick={() => onAttach(seg.index, null)}>
            Quitar
          </button>
        )}
      </div>
    </div>
  );
}

function TickerCard({ t }: { t: MasterTickerView }) {
  const e = t.entry;
  return (
    <section className={`mstr-tk ${e ? "" : "empty"}`}>
      <div className="mstr-tk-head">
        <div className="mstr-tk-name">
          <b>{t.ticker}</b> <span className="mstr-tk-label">{t.label}</span>
        </div>
        {e && <span className={`mstr-bias ${e.bias}`}>{biasLabel[e.bias]}</span>}
      </div>

      <Cross cross={t.cross} levels={e?.levels ?? []} />

      {e ? (
        <>
          {e.levels.length > 0 && (
            <div className="mstr-levels">
              {e.levels.map((l) => (
                <span key={l} className="mstr-lvl">{px.format(l)}</span>
              ))}
            </div>
          )}
          <p className="mstr-text">{e.text}</p>
          {e.image && <ChartImg name={e.image} />}
        </>
      ) : (
        <div className="mstr-empty-note">Sin análisis del master hoy.</div>
      )}
    </section>
  );
}

function Cross({ cross, levels }: { cross: CrossCheck; levels: number[] }) {
  const { price, sma50, sma200 } = cross;
  // Veredicto simple de tendencia por posición del precio frente a las medias.
  let trend = "—";
  let cls = "flat";
  if (price != null && sma50 != null && sma200 != null) {
    if (price > sma50 && sma50 > sma200) { trend = "alcista (sobre ambas medias)"; cls = "up"; }
    else if (price < sma50 && sma50 < sma200) { trend = "bajista (bajo ambas medias)"; cls = "down"; }
    else trend = "mixto";
  }
  // Nivel del master más cercano al precio (dónde "vigila" hoy).
  let near: number | null = null;
  if (price != null && levels.length > 0) {
    near = levels.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a));
  }
  const rel = (m: number | null) =>
    price != null && m != null ? (price >= m ? "up" : "down") : "flat";

  return (
    <div className="mstr-cross">
      <div className="mstr-cross-row">
        <div><span>Precio</span><b>{price != null ? `$${px.format(price)}` : "—"}</b></div>
        <div><span>SMA 50</span><b className={rel(sma50)}>{sma50 != null ? px.format(sma50) : "—"}</b></div>
        <div><span>SMA 200</span><b className={rel(sma200)}>{sma200 != null ? px.format(sma200) : "—"}</b></div>
      </div>
      <div className={`mstr-trend ${cls}`}>
        {trend}
        {near != null && <span className="mstr-near"> · master vigila ${px.format(near)}</span>}
      </div>
    </div>
  );
}

function ChartImg({ name }: { name: string }) {
  const src = `/api/master/image?name=${encodeURIComponent(name)}`;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="mstr-img-link">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="Chart del master" className="mstr-img" />
    </a>
  );
}
