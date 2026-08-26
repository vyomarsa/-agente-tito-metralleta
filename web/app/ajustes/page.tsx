"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface CookieStatus {
  source: "file" | "env" | "none";
  updatedAt: number | null;
  fingerprint: string | null;
  live: boolean;
  liveStatus: number | null;
}

interface AlertStatus {
  configured: boolean;
  chatId: string | null;
  alertsOn: boolean;
}

interface KeepAliveStatus {
  everRan: boolean;
  lastRunAt: number | null;
  lastOutcome: string | null;
  lines: string[];
}

function ago(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const mins = Math.round((Date.now() - ms) / 60000);
  const rel =
    mins < 1 ? "hace un momento" : mins < 60 ? `hace ${mins} min` : `hace ${Math.round(mins / 60)} h`;
  return `${d.toLocaleString()} (${rel})`;
}

export default function AjustesPage() {
  const [status, setStatus] = useState<CookieStatus | null>(null);
  const [keepAlive, setKeepAlive] = useState<KeepAliveStatus | null>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/marketsnack/cookie", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      setErr("No se pudo leer el estado de la cookie.");
    }
  }, []);

  const loadKeepAlive = useCallback(async () => {
    try {
      const r = await fetch("/api/marketsnack/keepalive", { cache: "no-store" });
      setKeepAlive(await r.json());
    } catch {
      /* no bloqueante */
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadKeepAlive();
  }, [loadStatus, loadKeepAlive]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/marketsnack/cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: paste }),
      });
      const d = await r.json();
      if (d.ok) {
        setMsg("✅ Cookie válida y guardada. Ya está activa — sin reiniciar.");
        setPaste("");
        if (d.saved) setStatus(d.saved);
        else await loadStatus();
      } else {
        setErr(d.error ?? "No se pudo guardar la cookie.");
      }
    } catch {
      setErr("Error de red al guardar la cookie.");
    } finally {
      setBusy(false);
    }
  };

  const live = status?.live;
  const sourceLabel =
    status?.source === "file"
      ? "archivo (renovable en caliente)"
      : status?.source === "env"
        ? ".env.local (respaldo)"
        : "ninguna";

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: "1rem 0 0.25rem" }}>
        ⚙️ Ajustes — Cookie de MarketSnack
      </h1>
      <p style={{ color: "var(--muted)", margin: "0 0 1.25rem", lineHeight: 1.5 }}>
        La sesión de MarketSnack caduca cada 1–2 días. Cuando el flujo deje de cargar,
        copia aquí tu cookie nueva y pégala: se <strong>prueba antes de guardar</strong> y,
        si sirve, queda activa <strong>sin reiniciar el servidor</strong>. Si no sirve, se
        rechaza y <strong>no</strong> se borra la que ya funcionaba.
      </p>

      {msg && <div style={box("var(--green-bg)", "var(--green-strong)")}>{msg}</div>}
      {err && <div style={box("var(--red-bg)", "var(--red-strong)")}>{err}</div>}

      {/* Estado */}
      <section style={card}>
        <h2 style={h2}>Estado</h2>
        {!status ? (
          <p>Cargando…</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.8 }}>
            <li>
              Estado:{" "}
              <strong style={{ color: live ? "var(--green-strong)" : "var(--red-strong)" }}>
                {status.source === "none"
                  ? "sin cookie"
                  : live
                    ? "funciona ✅"
                    : `expirada / rechazada ❌${status.liveStatus ? ` (HTTP ${status.liveStatus})` : ""}`}
              </strong>
            </li>
            <li>
              Origen: <strong>{sourceLabel}</strong>
            </li>
            {status.source === "file" && (
              <li>
                Actualizada: <strong>{ago(status.updatedAt)}</strong>
              </li>
            )}
            {status.fingerprint && (
              <li>
                Huella: <code>{status.fingerprint}</code>
              </li>
            )}
          </ul>
        )}
      </section>

      {/* Pegar nueva */}
      <section style={card}>
        <h2 style={h2}>Pegar cookie nueva</h2>
        <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
          En <code>app.marketsnack.com</code> abre DevTools → Network → cualquier
          petición a <code>/api/…</code> → copia el header <code>Cookie</code> completo
          (debe contener <code>_market_snack_session</code>) y pégalo aquí. Da igual si
          traes el prefijo <code>Cookie:</code> o comillas: se limpian solos.
        </p>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="_market_snack_session=…; otras=…"
          rows={5}
          style={textarea}
        />
        <button onClick={save} style={btnPrimary} disabled={busy || !paste.trim()}>
          {busy ? "Probando y guardando…" : "Probar y guardar"}
        </button>
        <p style={{ color: "var(--muted)", marginTop: "0.9rem", fontSize: "0.85rem", lineHeight: 1.5 }}>
          💡 ¿Cansado de copiar a mano? Carga una vez la extensión de{" "}
          <code>web/extension</code> (ver su <code>README</code>) y trae la cookie con{" "}
          <strong>un clic</strong> desde el navegador — funciona aunque el navegador use
          App-Bound Encryption.
        </p>
      </section>

      {/* Keep-alive (Fase 2) */}
      <section style={card}>
        <h2 style={h2}>Mantener viva la sesión (keep-alive)</h2>
        <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
          MarketSnack rota la cookie en cada petición. Una tarea programada de Windows
          hace un ping cada ~15 min y <strong>guarda la cookie rotada</strong>, imitando
          lo que hace el navegador para que la sesión no muera por inactividad. Instálala
          con doble clic en <code>Instalar KeepAlive MarketSnack.cmd</code> (carpeta{" "}
          <code>web/</code>).
        </p>
        {!keepAlive?.everRan ? (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Aún no ha corrido (o no está instalada la tarea).
          </p>
        ) : (
          <>
            <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.1rem", lineHeight: 1.7 }}>
              <li>
                Última ejecución: <strong>{ago(keepAlive.lastRunAt)}</strong>
              </li>
              <li>
                Último resultado:{" "}
                <strong
                  style={{
                    color:
                      keepAlive.lastOutcome === "OK"
                        ? "var(--green-strong)"
                        : keepAlive.lastOutcome === "EXPIRED" || keepAlive.lastOutcome === "ERROR"
                          ? "var(--red-strong)"
                          : "var(--muted)",
                  }}
                >
                  {keepAlive.lastOutcome ?? "—"}
                </strong>
              </li>
            </ul>
            <details>
              <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: "0.85rem" }}>
                Ver bitácora reciente
              </summary>
              <pre
                style={{
                  marginTop: "0.5rem",
                  padding: "0.6rem",
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: "0.72rem",
                  lineHeight: 1.5,
                  overflowX: "auto",
                  whiteSpace: "pre",
                }}
              >
                {keepAlive.lines.join("\n")}
              </pre>
            </details>
          </>
        )}
      </section>

      {/* Alertas de Telegram — avisos de lo que abren y cierran los agentes */}
      <AlertsSection />

      {/* Master — guardado aquí, fuera de la navegación diaria */}
      <section style={card}>
        <h2 style={h2}>🧠 Master (pre-market)</h2>
        <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
          El pre-market del master ya no vive en la barra lateral para no estorbar el día
          a día. La página sigue intacta: entra aquí por la mañana para pegar/subir las
          gráficas y salir.
        </p>
        <Link href="/master" style={{ ...btnPrimary, display: "inline-block", textDecoration: "none" }}>
          Abrir Master →
        </Link>
      </section>
    </main>
  );
}

// --- estilos inline (utilitario; mismo lenguaje visual que /schwab) ---
const card: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "1.25rem",
  marginBottom: "1rem",
};
const h2: React.CSSProperties = { fontSize: "1.05rem", margin: "0 0 0.5rem" };
const btnPrimary: React.CSSProperties = {
  background: "var(--invert-bg)",
  color: "var(--invert-text)",
  border: "none",
  borderRadius: 8,
  padding: "0.55rem 1rem",
  fontSize: "0.95rem",
  cursor: "pointer",
};
/** Botón secundario: mismo tamaño que el primario pero sin peso visual. */
const btn: React.CSSProperties = {
  background: "var(--panel-2)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0.55rem 1rem",
  fontSize: "0.95rem",
  cursor: "pointer",
};
const textarea: React.CSSProperties = {
  width: "100%",
  fontFamily: "monospace",
  fontSize: "0.85rem",
  padding: "0.6rem",
  background: "var(--panel-2)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  margin: "0 0 0.75rem",
  boxSizing: "border-box",
};
function box(bg: string, color: string): React.CSSProperties {
  return {
    background: bg,
    color,
    padding: "0.7rem 1rem",
    borderRadius: 8,
    marginBottom: "1rem",
    fontSize: "0.92rem",
  };
}

/**
 * Vincular Telegram para recibir avisos de los agentes.
 *
 * El flujo es en dos pasos y no en uno a propósito: Telegram no deja que un bot
 * escriba a alguien que no le ha hablado antes, así que primero hay que enviarle
 * un mensaje y luego buscar el chat. Explicarlo así evita el "¿por qué no llega
 * nada?" de un botón único que falla en silencio.
 */
function AlertsSection() {
  const [st, setSt] = useState<AlertStatus | null>(null);
  const [chats, setChats] = useState<{ chatId: string; name: string }[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void fetch("/api/telegram/alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then(setSt)
      .catch(() => setSt(null));
  }, []);
  useEffect(load, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/telegram/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (body.action === "discover") {
        setChats(d.chats ?? []);
        if (d.note) setMsg(d.note);
      } else if (body.action === "link") {
        setMsg(d.delivered ? "Vinculado. Te mandé un mensaje de confirmación." : `Vinculado, pero el envío falló: ${d.reason}`);
        load();
      } else if (body.action === "test") {
        setMsg(d.ok ? "Mensaje de prueba enviado." : `No se pudo enviar: ${d.reason}`);
      } else if (body.action === "unlink") {
        setMsg("Alertas desconectadas.");
        setChats(null);
        load();
      }
    } catch {
      setMsg("No se pudo hablar con el servidor.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={card}>
      <h2 style={h2}>📲 Alertas por Telegram</h2>
      <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.9rem", lineHeight: 1.5 }}>
        Avisos cuando los agentes <b>abren o cierran</b> posiciones en los simuladores de
        venta de prima y 0DTE. Todo es paper: ningún dólar real se mueve.
      </p>

      {!st ? (
        <p style={{ color: "var(--muted)" }}>Cargando…</p>
      ) : !st.configured ? (
        <p style={{ color: "var(--amber-text)" }}>
          Falta el token del bot. Ponlo arriba, en la sección de Telegram.
        </p>
      ) : st.alertsOn ? (
        <>
          <p style={{ fontSize: "0.95rem" }}>
            ✅ Conectadas al chat <code>{st.chatId}</code>.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={btnPrimary} disabled={busy} onClick={() => post({ action: "test" })}>
              Enviar prueba
            </button>
            <button style={btn} disabled={busy} onClick={() => post({ action: "unlink" })}>
              Desconectar
            </button>
          </div>
        </>
      ) : (
        <>
          <ol style={{ fontSize: "0.9rem", lineHeight: 1.6, paddingLeft: "1.2rem", color: "var(--text-2)" }}>
            {/* Enlace directo en vez de pedir que lo busquen: buscar por @usuario
                en Telegram falla a menudo (el bot no sale si nunca hablaste con
                él), y t.me abre la conversación siempre. */}
            <li>
              Abre este chat y escríbele cualquier cosa (un &quot;hola&quot; basta):{" "}
              <a
                href="https://t.me/vyo_master_premarket_bot"
                target="_blank"
                rel="noreferrer"
                style={{ fontWeight: 700, color: "var(--accent)" }}
              >
                t.me/vyo_master_premarket_bot
              </a>
              {" "}— es tu bot <b>Master Premarket</b>. Telegram no deja que un bot escriba primero.
            </li>
            <li>Vuelve aquí y pulsa <b>Buscar mi chat</b>.</li>
          </ol>
          <button style={btnPrimary} disabled={busy} onClick={() => post({ action: "discover" })}>
            {busy ? "Buscando…" : "Buscar mi chat"}
          </button>
          {chats && chats.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {chats.map((c) => (
                <button key={c.chatId} style={btn} disabled={busy}
                  onClick={() => post({ action: "link", chatId: c.chatId })}>
                  Enviar alertas a {c.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {msg && <p style={{ marginTop: 12, fontSize: "0.9rem", color: "var(--text-2)" }}>{msg}</p>}
    </section>
  );
}
