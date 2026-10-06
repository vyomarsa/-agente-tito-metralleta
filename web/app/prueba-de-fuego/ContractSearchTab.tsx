"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildLike, mergeLikes, upsertLike, type LikedContract } from "@/lib/pdf/contractSearchLikes";
import { loadLikes, saveLikes } from "@/lib/pdf/contractSearchLikesLocal";
import {
  buildEntry,
  pruneExpired,
  remove,
  togglePinned,
  upsert,
  type ContractSearchFavoriteEntry,
} from "@/lib/pdf/contractSearchFavorites";
import {
  clearEntries, hasResetV2, loadEntries, markResetV2, saveEntries,
} from "@/lib/pdf/contractSearchFavoritesLocal";
import { marketDateStr } from "@/lib/pdf/occ";
import type { ContractSearchSseEvent } from "./types";

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export default function ContractSearchTab() {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<ContractSearchFavoriteEntry[]>([]);
  const [likes, setLikes] = useState<LikedContract[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const likesRef = useRef<LikedContract[]>([]);
  const favRef = useRef<ContractSearchFavoriteEntry[]>([]);
  // Símbolos que el usuario sacó en ESTA sesión — evita que un escaneo ya en
  // vuelo los vuelva a agregar justo después de un "No me gusta" (mismo
  // patrón que app/unusual-swing/page.tsx).
  const dismissedRef = useRef<Set<string>>(new Set());

  const applyFavorites = useCallback((next: ContractSearchFavoriteEntry[]) => {
    favRef.current = next;
    setFavorites(next);
    saveEntries(next);
  }, []);

  // Copia en el servidor, best-effort: es lo que le permite al agente (el único
  // con la conexión MCP a Robinhood — el token vive en Claude, no en este
  // servidor) leer qué contratos hay que agregar a tu watchlist de opciones.
  const applyLikes = useCallback((next: LikedContract[]) => {
    likesRef.current = next;
    setLikes(next);
    saveLikes(next);
    fetch("/api/pdf/contract-search/likes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: next }),
    })
      .then((res) => (res.ok ? res.json() : null))
      // El servidor devuelve la lista ya fusionada con lo que hayan agregado
      // otros navegadores (celular, otra pestaña) — sin esto, este navegador
      // nunca se entera de esos "me gusta".
      .then((body: { entries?: LikedContract[] } | null) => {
        if (!body?.entries) return;
        likesRef.current = body.entries;
        setLikes(body.entries);
        saveLikes(body.entries);
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    applyLikes(loadLikes());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El agente sincroniza por MCP fuera de este proceso y marca syncedAt en la
  // copia del servidor; otro navegador (celular) puede además agregar "me
  // gusta" propios. Sin este poll, este navegador nunca se enteraría de
  // ninguna de las dos cosas.
  useEffect(() => {
    const id = setInterval(() => {
      fetch("/api/pdf/contract-search/likes")
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { entries?: LikedContract[] } | null) => {
          if (!body?.entries) return;
          const merged = mergeLikes(likesRef.current, body.entries);
          if (JSON.stringify(merged) !== JSON.stringify(likesRef.current)) {
            likesRef.current = merged;
            setLikes(merged);
            saveLikes(merged);
          }
        })
        .catch(() => null);
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const like = useCallback(
    (f: ContractSearchFavoriteEntry) => {
      const entry = buildLike(f, new Date());
      if (!entry) return;
      applyLikes(upsertLike(likesRef.current, entry));
    },
    [applyLikes],
  );

  const pin = useCallback(
    (symbol: string) => {
      applyFavorites(togglePinned(favRef.current, symbol));
    },
    [applyFavorites],
  );

  const dislike = useCallback(
    (symbol: string) => {
      dismissedRef.current.add(symbol);
      applyFavorites(remove(favRef.current, symbol));
    },
    [applyFavorites],
  );

  const scan = useCallback(() => {
    esRef.current?.close();
    setBusy(true);
    setError(null);
    setSteps([]);

    const es = new EventSource("/api/pdf/contract-search");
    esRef.current = es;
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as ContractSearchSseEvent;
      if (d.type === "step") {
        setSteps((s) => [...s.slice(-6), d.label]);
      } else if (d.type === "done") {
        const now = new Date();
        let next = favRef.current;
        for (const c of d.favorites) {
          if (dismissedRef.current.has(c.symbol)) continue;
          const entry = buildEntry(c, now);
          if (entry) next = upsert(next, entry);
        }
        applyFavorites(next);
        setBusy(false);
        es.close();
      } else if (d.type === "error") {
        setError(d.message);
        setBusy(false);
        es.close();
      }
    };
    es.onerror = () => {
      setError("Se cortó la conexión con el escáner.");
      setBusy(false);
      es.close();
    };
  }, [applyFavorites]);

  // Al montar: si es la primera carga con el criterio nuevo (ago 2026 — S&P
  // 500, single leg + acumulación en OI, 2 targets, catalizador de noticias),
  // se limpian los favoritos de la versión vieja (día-trading, un solo
  // target, gex/neighbor reference) UNA sola vez — ya no calzan con la forma
  // de dato nueva. Después, los favoritos guardados aparecen de inmediato
  // (sin esperar el escaneo), y luego se dispara el escaneo para sumar lo
  // nuevo de hoy. Purga cualquier contrato YA VENCIDO (el usuario, 2026-07-30:
  // "me estás dando expirados") — la "foto" de un favorito nunca se pisa
  // sola, así que sin esta purga se quedaban visibles para siempre. Los 📌
  // Mantenidos no se purgan por vencimiento, a propósito (`pruneExpired`).
  useEffect(() => {
    if (!hasResetV2()) {
      clearEntries();
      markResetV2();
    }
    const today = marketDateStr(new Date());
    const cleaned = pruneExpired(loadEntries(), today);
    applyFavorites(cleaned);
    scan();
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Búsqueda de contratos</div>
        <p className="wheel-disclaimer" style={{ fontSize: 13, lineHeight: 1.6 }}>
          Escanea las empresas del S&amp;P 500 buscando los 10 mejores contratos de acumulación
          institucional real: una sola pata (nunca multileg), volumen del día que ya superó el
          Open Interest existente (dinero nuevo repitiéndose, no rotación), comprado
          agresivamente al ask, vencimiento entre 10 y 40 días, y premium mayor a $1,000,000. Cada
          uno trae DOS targets reales (no el strike) desde el movimiento esperado por IV/DTE del
          propio trade — Target 1 con más de 50% de convicción, Target 2 más lejos y más
          ambicioso. Cuando hay noticias recientes de la empresa, se marca si confirman o
          contradicen la apuesta. La ganancia proyectada usa el delta del trade como aproximación
          lineal, no un cálculo completo. Los que encuentra se guardan solos, con la foto del
          momento — esa foto NUNCA se pisa.{" "}
          <b>👍 Agregar a Robinhood</b> lo suma a tu watchlist de opciones real; <b>📌 Mantener</b>{" "}
          lo blinda de una futura limpieza automática; <b>👎 No me gusta</b> lo saca. Quedan
          guardados en este navegador aunque recargues la página.
        </p>
      </div>

      <button className="rescan" onClick={scan} disabled={busy}>
        {busy ? "Escaneando…" : "↻ Volver a escanear"}
      </button>

      {busy && (
        <div className="card wheel-empty">
          {steps.length > 0 ? steps[steps.length - 1] : "Escaneando el mercado…"}
        </div>
      )}
      {error && <div className="error">⚠ {error}</div>}

      {favorites.length === 0 && !busy && (
        <div className="card wheel-empty">Sin contratos agresivos detectados en este escaneo.</div>
      )}

      {favorites.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {favorites.map((f) => {
            const liked = likes.find((l) => l.symbol === f.symbol);
            return (
              <div key={f.symbol} className="card" style={{ gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>
                    {f.ticker}{f.companyName ? ` · ${f.companyName}` : ""} — {f.type === "call" ? "call" : "put"} ${f.strike}{" "}
                    ({f.expiration}{f.dte != null ? `, ${f.dte}d` : ""})
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button
                      className="rescan"
                      style={{ margin: 0 }}
                      disabled={!!liked}
                      onClick={() => like(f)}
                    >
                      {liked?.syncedAt ? "✅ En tu Robinhood" : liked ? "⏳ Agregando…" : "👍 Agregar a Robinhood"}
                    </button>
                    <button className="rescan" onClick={() => pin(f.symbol)} style={{ margin: 0 }}>
                      {f.pinned ? "📌 Manteniendo" : "📌 Mantener"}
                    </button>
                    <button className="rescan" onClick={() => dislike(f.symbol)} style={{ margin: 0 }}>
                      👎 No me gusta
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "var(--muted)" }}>
                  Precio del subyacente: ${f.assetPrice.toFixed(2)} · Premium: {money(f.premium)} · Tamaño: {f.size}
                  {" · "}Volumen: {f.volume.toLocaleString("en-US")} · OI: {f.openInterest.toLocaleString("en-US")}
                </div>

                <div className="struct-sub">Target 1 — convicción ≥50%</div>
                <div className="stats">
                  <div className="stat">
                    <div className="stat-label">Target</div>
                    <div className="stat-value">{f.target1 != null ? `$${f.target1.toFixed(2)}` : "—"}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Convicción</div>
                    <div className="stat-value">{f.convictionPct1 != null ? `${f.convictionPct1.toFixed(0)}%` : "—"}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Cambio al target</div>
                    <div className="stat-value" style={{ color: (f.changePctToTarget1 ?? 0) >= 0 ? "#12b76a" : "#f04438" }}>
                      {f.changePctToTarget1 != null ? pct(f.changePctToTarget1) : "—"}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Ganancia estimada (1 contrato)</div>
                    <div className="stat-value">{f.estUsdGain1 != null ? money(f.estUsdGain1) : "—"}</div>
                  </div>
                </div>

                <div className="struct-sub" style={{ marginTop: 8 }}>Target 2 — movimiento esperado completo</div>
                <div className="stats">
                  <div className="stat">
                    <div className="stat-label">Target</div>
                    <div className="stat-value">{f.target2 != null ? `$${f.target2.toFixed(2)}` : "—"}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Convicción</div>
                    <div className="stat-value">{f.convictionPct2 != null ? `${f.convictionPct2.toFixed(0)}%` : "—"}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Cambio al target</div>
                    <div className="stat-value" style={{ color: (f.changePctToTarget2 ?? 0) >= 0 ? "#12b76a" : "#f04438" }}>
                      {f.changePctToTarget2 != null ? pct(f.changePctToTarget2) : "—"}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Ganancia estimada (1 contrato)</div>
                    <div className="stat-value">{f.estUsdGain2 != null ? money(f.estUsdGain2) : "—"}</div>
                  </div>
                </div>

                {f.newsFlag && f.newsFlag.kind !== "none" && (
                  <div className={`news-flag ${f.newsFlag.kind}`}>
                    <div className="news-flag-title">
                      {f.newsFlag.kind === "conflict" ? "⚠ " : "✓ "}{f.newsFlag.title}
                    </div>
                    <div className="news-flag-detail">{f.newsFlag.detail}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="disclaimer">
        Dinero 100% simulado. Proyección aproximada (delta lineal), no es consejo financiero.
      </div>
    </div>
  );
}
