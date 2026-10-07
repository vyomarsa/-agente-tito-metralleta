"use client";

import { useCallback, useEffect, useState } from "react";
import type { TickerAnalysis } from "@/lib/pdf/premarketAnalysis";

// Análisis de pre-market de SPY, QQQ, SPX y las 7 magníficas (pedido del dueño,
// 2026-10-07): precio y % de pre-market, rango del pre-market, soportes y
// resistencias, call wall, put wall, imán, net GEX y flip. Datos de
// /api/pdf/premarket-analysis (lib/pdf/premarketAnalysis.ts).

const REFRESH_MS = 5 * 60_000;

const px = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : n.toFixed(2);
const pct = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const gexFmt = (n: number | null) => {
  if (n == null) return "—";
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(0)}M` : a.toFixed(0);
  return `${n < 0 ? "−" : "+"}$${s}`;
};

function Cell({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 14, color }}>{value}</div>
      {hint && <div className="muted" style={{ fontSize: 10 }}>{hint}</div>}
    </div>
  );
}

function TickerCard({ t }: { t: TickerAnalysis }) {
  const g = t.gex;
  const up = (t.changePct ?? 0) >= 0;
  // Si el flip viene de Tastytrade es el del vencimiento MÁS CERCANO (0DTE en
  // SPX/SPY/QQQ), no el agregado de MarketSnack: se dice para no mezclar bases.
  const flipCercano = g.flipSource === "Tastytrade";
  const deQue = flipCercano ? " del vencimiento más cercano" : "";
  const regime =
    t.price != null && g.flip != null
      ? t.price >= g.flip
        ? { txt: `sobre el flip${deQue} · γ+ (el precio tiende a frenarse)`, color: "var(--green)" }
        : { txt: `bajo el flip${deQue} · γ− (el precio tiende a acelerar)`, color: "var(--red)" }
      : null;
  return (
    <div className="card" style={{ gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>{t.ticker}</div>
        <div style={{ textAlign: "right" }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>${px(t.price)}</span>{" "}
          <span style={{ fontWeight: 700, color: up ? "var(--green)" : "var(--red)" }}>{pct(t.changePct)}</span>
          <div className="muted" style={{ fontSize: 10 }}>
            {t.session === "Pre-market" ? "pre-market" : t.session === "After hours" ? "after-hours" : t.ticker === "SPX" ? "índice: sin pre-market, último cierre" : "sin sesión extendida"}
            {" · cierre ant. "}${px(t.prevClose)}
          </div>
        </div>
      </div>

      {t.error && <div className="muted" style={{ fontSize: 12 }}>⚠ {t.error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <Cell label="Net GEX" value={gexFmt(g.netGex)} color={g.netGex != null ? (g.netGex >= 0 ? "var(--green)" : "var(--red)") : undefined} />
        <Cell label="Imán" value={px(g.magnet)} />
        <Cell label="Flip" value={px(g.flip)} hint={flipCercano ? "venc. más cercano (Tasty)" : undefined} />
        <Cell label="Call wall" value={px(g.callWall)} color="var(--green)" />
        <Cell label="Put wall" value={px(g.putWall)} color="var(--red)" />
        <Cell label="Rango PM" value={t.premarketLow != null ? `${px(t.premarketLow)}–${px(t.premarketHigh)}` : "—"} />
      </div>

      {regime && <div style={{ fontSize: 12, color: regime.color }}>● {regime.txt}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
        <div>
          <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>Resistencias</div>
          {t.resistances.length === 0 ? (
            <div className="muted">en máximos · ver call wall</div>
          ) : (
            t.resistances.map((l) => (
              <div key={l.price}>
                <b style={{ color: "var(--red)" }}>{px(l.price)}</b> <span className="muted">+{Math.abs(l.distancePct).toFixed(1)}% · fuerza {l.strength}</span>
              </div>
            ))
          )}
        </div>
        <div>
          <div className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>Soportes</div>
          {t.supports.length === 0 ? (
            <div className="muted">sin soporte cercano · ver put wall</div>
          ) : (
            t.supports.map((l) => (
              <div key={l.price}>
                <b style={{ color: "var(--green)" }}>{px(l.price)}</b> <span className="muted">−{Math.abs(l.distancePct).toFixed(1)}% · fuerza {l.strength}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function PremarketAnalysis() {
  const [tickers, setTickers] = useState<TickerAnalysis[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/pdf/premarket-analysis${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      setTickers(j.tickers);
      setAsOf(j.asOf);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const gexAsOf = tickers?.find((t) => t.gex.asOf)?.gex.asOf;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Análisis pre-market · SPY, QQQ, SPX y 7 magníficas</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              {asOf
                ? <>Actualizado {new Date(asOf).toLocaleTimeString("es-ES", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} ET
                    {gexAsOf ? <> · GEX de MarketSnack al {new Date(gexAsOf).toLocaleString("es-ES", { timeZone: "America/New_York", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} ET</> : null}</>
                : busy ? "Armando el análisis (~20 s)…" : ""}
            </div>
          </div>
          <button className="rescan" onClick={() => void load(true)} disabled={busy} style={{ margin: 0 }}>
            {busy ? "Analizando…" : "Actualizar"}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>
          <b>Call wall</b> = mayor concentración de gamma de calls (techo típico) · <b>put wall</b> = la de puts (piso
          típico) · <b>imán</b> = strike con más gamma, hacia donde tiende a ir el precio · <b>flip</b> = donde la gamma
          neta cambia de signo: por encima el precio se frena (γ+), por debajo acelera (γ−). Net GEX, walls e imán
          son de MarketSnack (todos los vencimientos); cuando MarketSnack no da flip, se calcula con el vencimiento
          más cercano en Tastytrade (en SPX/SPY/QQQ, el 0DTE) y se indica. Soportes y resistencias:
          pivotes de las velas diarias. En pre-market el GEX es la foto del cierre anterior.
        </p>
      </div>

      {error && <div className="card wheel-empty">⚠ {error}</div>}

      {tickers && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
          {tickers.map((t) => <TickerCard key={t.ticker} t={t} />)}
        </div>
      )}
    </div>
  );
}
