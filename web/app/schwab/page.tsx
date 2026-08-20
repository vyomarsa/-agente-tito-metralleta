"use client";

import { useCallback, useEffect, useState } from "react";

interface Status {
  configured: boolean;
  /** Hay tokens en disco. NO implica que sirvan. */
  hasTokens: boolean;
  /** Comprobado en vivo contra Schwab. */
  connected: boolean;
  needsAuth: boolean;
  error: string | null;
  accessExpiresAt: number | null;
  refreshIssuedAt: number | null;
  refreshDaysLeft: number | null;
}

interface SchwabContract {
  symbol: string;
  contractType: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number;
  openInterest: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

function fmt(n: number | null, d = 2): string {
  return n == null ? "—" : n.toFixed(d);
}

export default function SchwabPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [ticker, setTicker] = useState("AAPL");
  const [rows, setRows] = useState<SchwabContract[] | null>(null);
  const [spot, setSpot] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/schwab/status", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      setErr("No se pudo leer el estado de Schwab.");
    }
  }, []);

  useEffect(() => {
    loadStatus();
    // ?connected=1 o ?error= vienen del callback automático
    const p = new URLSearchParams(window.location.search);
    if (p.get("connected")) setMsg("✅ Schwab conectado.");
    if (p.get("error")) setErr(decodeURIComponent(p.get("error")!));
  }, [loadStatus]);

  const connect = () => {
    window.location.href = "/api/schwab/auth";
  };

  const exchange = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/schwab/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: paste }),
      });
      const d = await r.json();
      if (d.ok) {
        setMsg("✅ Schwab conectado.");
        setPaste("");
        await loadStatus();
      } else {
        setErr(d.error ?? "No se pudo canjear el code.");
      }
    } catch {
      setErr("Error de red al canjear el code.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await fetch("/api/schwab/status", { method: "DELETE" });
      setMsg("Desconectado.");
      await loadStatus();
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setErr(null);
    setRows(null);
    try {
      const r = await fetch(
        `/api/schwab/chain?ticker=${encodeURIComponent(ticker)}&strikes=12`,
        { cache: "no-store" },
      );
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "Error consultando Schwab.");
        return;
      }
      setSpot(d.underlyingPrice ?? null);
      setRows((d.contracts as SchwabContract[]).slice(0, 25));
    } catch {
      setErr("Error de red consultando la cadena.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: "1rem 0 0.25rem" }}>
        🔗 Charles Schwab — tercera fuente de datos
      </h1>
      <p style={{ color: "var(--muted)", margin: "0 0 1.25rem", lineHeight: 1.5 }}>
        Schwab aporta lo que Massive no autoriza en tu plan: <strong>greeks
        (delta/gamma/theta/vega), IV, Open Interest y bid/ask</strong> de cada
        contrato en una sola llamada. Usa OAuth 2.0: apruebas la app una vez y el
        servidor refresca el token solo (~cada 30 min). El refresh dura ~7 días;
        al vencer, vuelve a conectar aquí.
      </p>

      {msg && (
        <div style={box("var(--green-bg)", "var(--green-strong)")}>{msg}</div>
      )}
      {err && (
        <div style={box("var(--red-bg)", "var(--red-strong)")}>{err}</div>
      )}

      {/* Estado */}
      <section style={card}>
        <h2 style={h2}>Estado</h2>
        {!status ? (
          <p>Cargando…</p>
        ) : !status.configured ? (
          <p style={{ color: "var(--red-strong)" }}>
            Faltan credenciales en <code>.env.local</code> (SCHWAB_CLIENT_ID /
            SCHWAB_CLIENT_SECRET / SCHWAB_REDIRECT_URI).
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.7 }}>
            <li>
              Credenciales: <strong>configuradas ✅</strong>
            </li>
            <li>
              Conexión:{" "}
              <strong style={{ color: status.connected ? "var(--green-strong)" : "var(--red-strong)" }}>
                {status.connected
                  ? "conectado ✅"
                  : status.hasTokens
                    ? "caducada — hay que reconectar ⚠"
                    : "sin conectar"}
              </strong>
              {/* Se comprueba EN VIVO. Antes bastaba con que existiera el archivo de
                  tokens, así que decía "conectado ✅" con el refresh ya revocado. */}
            </li>
            {!status.connected && status.error && (
              <li style={{ color: "var(--muted)", fontSize: "0.85em" }}>
                Motivo: {status.error}
              </li>
            )}
            {status.connected && (
              <li>
                Refresh token: le quedan ~<strong>{status.refreshDaysLeft}</strong> días
                <span style={{ color: "var(--muted)" }}> (estimado; Schwab puede revocarlo antes)</span>
                {status.refreshDaysLeft != null && status.refreshDaysLeft < 1 && (
                  <span style={{ color: "var(--red-strong)" }}> — reconecta pronto</span>
                )}
              </li>
            )}
          </ul>
        )}
      </section>

      {/* Conectar */}
      {status?.configured && (
        <section style={card}>
          <h2 style={h2}>1. Autorizar en Schwab</h2>
          <p style={{ color: "var(--muted)", marginTop: 0 }}>
            Abre el login de Schwab, inicia sesión y aprueba. Como tu Callback URL
            es <code>https://127.0.0.1</code>, el navegador terminará en una página
            de error con la URL <code>https://127.0.0.1/?code=…</code> en la barra.
            Copia esa URL completa y pégala abajo.
          </p>
          <button onClick={connect} style={btnPrimary} disabled={busy}>
            Abrir login de Schwab →
          </button>

          <h2 style={{ ...h2, marginTop: "1.5rem" }}>2. Pegar la URL de vuelta</h2>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="https://127.0.0.1/?code=...%40&session=..."
            rows={3}
            style={textarea}
          />
          <button onClick={exchange} style={btnPrimary} disabled={busy || !paste.trim()}>
            {busy ? "Canjeando…" : "Canjear code y conectar"}
          </button>

          {status.connected && (
            <div style={{ marginTop: "1rem" }}>
              <button onClick={disconnect} style={btnGhost} disabled={busy}>
                Desconectar
              </button>
            </div>
          )}
        </section>
      )}

      {/* Prueba de datos */}
      {status?.connected && (
        <section style={card}>
          <h2 style={h2}>Probar datos (cadena con greeks)</h2>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              style={input}
              placeholder="AAPL"
            />
            <button onClick={test} style={btnPrimary} disabled={testing}>
              {testing ? "Consultando…" : "Consultar"}
            </button>
          </div>
          {spot != null && (
            <p style={{ margin: "0 0 0.5rem" }}>
              Precio subyacente: <strong>${spot.toFixed(2)}</strong>
            </p>
          )}
          {rows && rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={table}>
                <thead>
                  <tr>
                    {["Tipo", "Strike", "Vto", "DTE", "Bid", "Ask", "OI", "Vol", "IV%", "Δ", "Γ", "Θ"].map(
                      (h) => (
                        <th key={h} style={th}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c, i) => (
                    <tr key={i} style={{ background: i % 2 ? "var(--row-odd)" : "var(--panel)" }}>
                      <td style={td}>
                        <span style={{ color: c.contractType === "call" ? "var(--green-strong)" : "var(--red-strong)" }}>
                          {c.contractType === "call" ? "CALL" : "PUT"}
                        </span>
                      </td>
                      <td style={td}>{c.strike}</td>
                      <td style={td}>{c.expiration}</td>
                      <td style={td}>{c.dte}</td>
                      <td style={td}>{fmt(c.bid)}</td>
                      <td style={td}>{fmt(c.ask)}</td>
                      <td style={td}>{c.openInterest.toLocaleString()}</td>
                      <td style={td}>{c.volume.toLocaleString()}</td>
                      <td style={td}>{fmt(c.iv, 1)}</td>
                      <td style={td}>{fmt(c.delta, 3)}</td>
                      <td style={td}>{fmt(c.gamma, 4)}</td>
                      <td style={td}>{fmt(c.theta, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows && rows.length === 0 && <p>Sin contratos.</p>}
        </section>
      )}
    </main>
  );
}

// --- estilos inline (la página es utilitaria; no justifica CSS module propio) ---
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
const btnGhost: React.CSSProperties = {
  background: "transparent",
  color: "var(--red-strong)",
  border: "1px solid var(--red-soft)",
  borderRadius: 8,
  padding: "0.45rem 0.9rem",
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
const input: React.CSSProperties = {
  fontSize: "0.95rem",
  padding: "0.5rem 0.7rem",
  background: "var(--panel-2)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  width: 120,
  textTransform: "uppercase",
};
const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.82rem",
};
const th: React.CSSProperties = {
  textAlign: "right",
  padding: "0.4rem 0.5rem",
  borderBottom: "2px solid var(--border)",
  color: "var(--muted)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  textAlign: "right",
  padding: "0.35rem 0.5rem",
  borderBottom: "1px solid var(--border-soft)",
  whiteSpace: "nowrap",
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
