"use client";

import { useCallback, useEffect, useState } from "react";

interface TtStatus {
  configured: boolean;
  env: "sandbox" | "production";
  connected: boolean;
  accessExpiresAt: number | null;
}

interface Metric {
  symbol: string;
  ivRank: number | null;
  ivPercentile: number | null;
  ivIndex: number | null;
  liquidityRating: number | null;
  beta: number | null;
  earningsDate: string | null;
}

interface GreekRow {
  key: string;
  gamma: number;
  iv: number;
  delta?: number;
  bid?: number;
  ask?: number;
  openInterest?: number;
}

function fmt(n: number | null | undefined, d = 2): string {
  return n == null ? "—" : n.toFixed(d);
}

export default function TastytradePage() {
  const [status, setStatus] = useState<TtStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<Metric[] | null>(null);
  const [testingM, setTestingM] = useState(false);

  const [ticker, setTicker] = useState("AAPL");
  const [greeks, setGreeks] = useState<{ count: number; rows: GreekRow[] } | null>(null);
  const [testingG, setTestingG] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/tastytrade/status", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      setErr("No se pudo leer el estado de Tastytrade.");
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const testMetrics = async () => {
    setTestingM(true);
    setErr(null);
    setMetrics(null);
    try {
      const r = await fetch("/api/tastytrade/metrics?symbols=SPY,AAPL,NVDA,MSFT", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "Error consultando las métricas de Tastytrade.");
        return;
      }
      setMetrics(d.metrics ?? []);
    } catch {
      setErr("Error de red consultando las métricas.");
    } finally {
      setTestingM(false);
    }
  };

  const testGreeks = async () => {
    setTestingG(true);
    setErr(null);
    setGreeks(null);
    try {
      const r = await fetch(`/api/tastytrade/greeks?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.connected) {
        setErr(d.message ?? "Tastytrade no devolvió greeks (¿streamer o credenciales?).");
        return;
      }
      const entries = Object.entries(d.greeks ?? {}) as [string, Omit<GreekRow, "key">][];
      // Muestra los primeros 20 contratos con bid/ask (los útiles).
      const rows = entries
        .map(([key, v]) => ({ key, ...v }))
        .filter((r) => r.bid != null || r.ask != null)
        .slice(0, 20);
      setGreeks({ count: d.count ?? entries.length, rows });
    } catch {
      setErr("Error de red consultando la cadena.");
    } finally {
      setTestingG(false);
    }
  };

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: "1rem 0 0.25rem" }}>
        📡 Tastytrade — fuente principal de datos
      </h1>
      <p style={{ color: "var(--muted)", margin: "0 0 1.25rem", lineHeight: 1.5 }}>
        Tastytrade es hoy la <strong>fuente principal</strong> del agente: <strong>IV Rank
        e IV percentile reales</strong>, <strong>greeks (delta/gamma/IV/OI/bid-ask) por el
        streamer DXLink</strong>, y la <strong>cadena</strong> de Spreads, Wheel y Venta
        Prima. Usa OAuth2 &quot;personal grant&quot;: las credenciales viven en{" "}
        <code>.env.local</code> y el servidor cambia el refresh token por un access token
        de 15 min solo. MarketSnack, Massive y Schwab quedan de respaldo por prioridad.
      </p>

      {err && <div style={box("var(--red-bg)", "var(--red-strong)")}>{err}</div>}

      {/* Estado */}
      <section style={card}>
        <h2 style={h2}>Estado</h2>
        {!status ? (
          <p>Cargando…</p>
        ) : !status.configured ? (
          <>
            <p style={{ color: "var(--red-strong)", marginTop: 0 }}>
              Faltan credenciales en <code>.env.local</code>.
            </p>
            <ol style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.7, color: "var(--muted)" }}>
              <li>
                En el portal de Tastytrade (producción): <strong>OAuth Applications → tu app →
                Create Grant</strong> (scope <code>read</code>) para obtener un{" "}
                <strong>refresh token</strong> de por vida.
              </li>
              <li>
                Pon en <code>.env.local</code>: <code>TASTYTRADE_CLIENT_SECRET</code>,{" "}
                <code>TASTYTRADE_REFRESH_TOKEN</code> y <code>TASTYTRADE_ENV=production</code>.
              </li>
              <li>Reinicia el servidor y recarga esta página.</li>
            </ol>
          </>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.7 }}>
            <li>
              Credenciales: <strong>configuradas ✅</strong>
            </li>
            <li>
              Entorno:{" "}
              <strong style={{ color: status.env === "production" ? "var(--green-strong)" : "var(--amber-text, var(--amber))" }}>
                {status.env === "production" ? "producción ✅" : "sandbox ⚠ (sin datos de mercado reales)"}
              </strong>
            </li>
            <li>
              Access token:{" "}
              <strong style={{ color: status.connected ? "var(--green-strong)" : "var(--muted)" }}>
                {status.connected ? "vigente ✅" : "se pedirá en la próxima llamada"}
              </strong>
              {status.connected && status.accessExpiresAt != null && (
                <span style={{ color: "var(--muted)" }}>
                  {" "}(caduca {new Date(status.accessExpiresAt).toLocaleTimeString("es")})
                </span>
              )}
            </li>
          </ul>
        )}
      </section>

      {/* Prueba 1: IV Rank / métricas */}
      {status?.configured && (
        <section style={card}>
          <h2 style={h2}>Probar IV Rank y métricas</h2>
          <p style={{ color: "var(--muted)", marginTop: 0 }}>
            Consulta el endpoint <code>/market-metrics</code> para unos ETFs/acciones.
          </p>
          <button onClick={testMetrics} style={btnPrimary} disabled={testingM}>
            {testingM ? "Consultando…" : "Consultar SPY · AAPL · NVDA · MSFT"}
          </button>
          {metrics && metrics.length > 0 && (
            <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
              <table style={table}>
                <thead>
                  <tr>
                    {["Símbolo", "IV Rank", "IV %ile", "IV Index", "Liquidez", "Beta", "Earnings"].map((h) => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m, i) => (
                    <tr key={m.symbol} style={{ background: i % 2 ? "var(--row-odd)" : "var(--panel)" }}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 700 }}>{m.symbol}</td>
                      <td style={{ ...td, color: "var(--green-strong)", fontWeight: 700 }}>{fmt(m.ivRank, 1)}</td>
                      <td style={td}>{fmt(m.ivPercentile, 1)}</td>
                      <td style={td}>{fmt(m.ivIndex, 1)}</td>
                      <td style={td}>{fmt(m.liquidityRating, 0)}</td>
                      <td style={td}>{fmt(m.beta, 2)}</td>
                      <td style={td}>{m.earningsDate ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {metrics && metrics.length === 0 && (
            <p style={{ color: "var(--muted)" }}>Sin métricas (¿sandbox? producción sí las da).</p>
          )}
        </section>
      )}

      {/* Prueba 2: cadena / greeks por el streamer */}
      {status?.configured && (
        <section style={card}>
          <h2 style={h2}>Probar cadena y greeks (streamer DXLink)</h2>
          <p style={{ color: "var(--muted)", marginTop: 0 }}>
            Abre el streamer, suscribe la cadena y trae delta/gamma/IV/OI/bid-ask reales.
            Tarda ~3s.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              style={input}
              placeholder="AAPL"
            />
            <button onClick={testGreeks} style={btnPrimary} disabled={testingG}>
              {testingG ? "Consultando…" : "Consultar cadena"}
            </button>
          </div>
          {greeks && (
            <>
              <p style={{ margin: "0 0 0.5rem" }}>
                <strong>{greeks.count}</strong> contratos con greeks reales.
              </p>
              {greeks.rows.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={table}>
                    <thead>
                      <tr>
                        {["Contrato", "Bid", "Ask", "Δ", "Γ", "IV%", "OI"].map((h) => (
                          <th key={h} style={th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {greeks.rows.map((r, i) => {
                        const [strike, exp, type] = r.key.split("|");
                        return (
                          <tr key={r.key} style={{ background: i % 2 ? "var(--row-odd)" : "var(--panel)" }}>
                            <td style={{ ...td, textAlign: "left" }}>
                              <span style={{ color: type === "call" ? "var(--green-strong)" : "var(--red-strong)" }}>
                                {type === "call" ? "C" : "P"}
                              </span>{" "}
                              {strike} · {exp}
                            </td>
                            <td style={td}>{fmt(r.bid)}</td>
                            <td style={td}>{fmt(r.ask)}</td>
                            <td style={td}>{fmt(r.delta, 3)}</td>
                            <td style={td}>{fmt(r.gamma, 4)}</td>
                            <td style={td}>{fmt(r.iv != null ? r.iv * 100 : null, 1)}</td>
                            <td style={td}>{r.openInterest?.toLocaleString() ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}

// --- estilos inline (página utilitaria, igual que /schwab) ---
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
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" };
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
  return { background: bg, color, padding: "0.7rem 1rem", borderRadius: 8, marginBottom: "1rem", fontSize: "0.92rem" };
}
