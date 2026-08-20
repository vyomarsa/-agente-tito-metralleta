"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { px } from "../format";
import type { Quote } from "@/lib/massive";

// Cinta de cotizaciones en movimiento (estilo panel de bolsa), fija arriba del todo.
// Sustituye al panel de watchlist que vivía en la barra lateral: MISMA lista
// (localStorage `tito.stockwatch`), MISMA llamada única a /api/quotes cada 20 s y
// mismo clic para analizar el símbolo. Lo que cambia es la presentación.
//
// El desplazamiento es CSS puro (una animación sobre la pista), no un timer de JS:
// así no repinta React 60 veces por segundo ni consume batería en el móvil.
const LS_KEY = "tito.stockwatch";
const DEFAULT: string[] = [
  "SPY", "QQQ", "NVDA", "MSFT", "AAPL", "GOOGL", "AMZN", "META",
  "TSLA", "NFLX", "AMD", "MU", "LLY", "JPM", "XOM", "WMT",
];
const REFRESH_MS = 20_000;
/** Segundos que tarda en cruzar CADA símbolo. Así la velocidad no depende del nº. */
const SECONDS_PER_ITEM = 4;

function loadList(): string[] {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
  } catch {
    /* usa el default */
  }
  return DEFAULT;
}

export default function TickerTape() {
  const router = useRouter();
  const pathname = usePathname();
  const [list, setList] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState("");
  const listRef = useRef<string[]>([]);

  // Hidrata desde localStorage tras montar (evita desajuste SSR/cliente).
  useEffect(() => {
    const l = loadList();
    setList(l);
    listRef.current = l;
  }, []);

  const persist = useCallback((next: string[]) => {
    setList(next);
    listRef.current = next;
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* noop */ }
  }, []);

  // Cotiza la lista completa en una llamada; repite cada REFRESH_MS.
  useEffect(() => {
    if (list.length === 0) return;
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch(`/api/quotes?tickers=${encodeURIComponent(list.join(","))}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { quotes?: Quote[] };
        if (!alive || !d.quotes) return;
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of d.quotes!) next[q.ticker] = q;
          return next;
        });
      } catch { /* reintenta en el siguiente tick */ }
    };
    void pull();
    const id = setInterval(pull, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [list]);

  const open = (sym: string) => {
    try { window.sessionStorage.setItem("tito.search", sym); } catch { /* noop */ }
    if (pathname === "/") window.dispatchEvent(new CustomEvent("tito:search"));
    else router.push("/");
  };

  const add = () => {
    const t = draft.trim().toUpperCase();
    setDraft("");
    if (!t || listRef.current.includes(t)) return;
    persist([t, ...listRef.current]);
  };

  const remove = (sym: string) => persist(listRef.current.filter((s) => s !== sym));

  // La pista lleva la lista DUPLICADA: la animación la desplaza hasta −50% y al
  // reiniciarse la segunda copia está exactamente donde estaba la primera, así que
  // el bucle no tiene costura. La copia es decorativa → aria-hidden.
  const duration = Math.max(list.length * SECONDS_PER_ITEM, 20);
  const items = useMemo(
    () => list.map((sym) => ({ sym, q: quotes[sym] })),
    [list, quotes],
  );

  return (
    <div className="tape" role="region" aria-label="Cotizaciones del watchlist">
      <button
        type="button"
        className={`tape-manage ${managing ? "on" : ""}`}
        onClick={() => setManaging((v) => !v)}
        title={managing ? "Cerrar" : "Editar watchlist"}
        aria-expanded={managing}
      >
        {managing ? "×" : "+"}
      </button>

      <div className="tape-viewport">
        {items.length > 0 && (
          <div className="tape-track" style={{ animationDuration: `${duration}s` }}>
            <TapeRun items={items} onOpen={open} />
            <TapeRun items={items} onOpen={open} ariaHidden />
          </div>
        )}
      </div>

      {managing && (
        <div className="tape-panel">
          <div className="tape-panel-add">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
                if (e.key === "Escape") { setManaging(false); setDraft(""); }
              }}
              placeholder="Añadir símbolo…"
              spellCheck={false}
            />
            <button type="button" onClick={add}>Añadir</button>
          </div>
          <div className="tape-panel-chips">
            {list.map((sym) => (
              <span key={sym} className="tape-chip">
                {sym}
                <button type="button" onClick={() => remove(sym)} title={`Quitar ${sym}`}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TapeRun({
  items, onOpen, ariaHidden,
}: {
  items: { sym: string; q: Quote | undefined }[];
  onOpen: (sym: string) => void;
  ariaHidden?: boolean;
}) {
  return (
    <div className="tape-run" aria-hidden={ariaHidden || undefined}>
      {items.map(({ sym, q }) => {
        const chg = q?.changePercent ?? null;
        const dir = chg == null ? "flat" : chg > 0 ? "up" : chg < 0 ? "down" : "flat";
        return (
          <button
            key={sym}
            type="button"
            className="tape-item"
            onClick={() => onOpen(sym)}
            tabIndex={ariaHidden ? -1 : 0}
            title={`Analizar ${sym}`}
          >
            <span className="tape-sym">{sym}</span>
            <span className="tape-price">{q?.price != null ? px.format(q.price) : "—"}</span>
            <span className={`tape-chg ${dir}`}>
              {chg != null ? `${chg > 0 ? "▲" : chg < 0 ? "▼" : ""} ${chg > 0 ? "+" : ""}${chg.toFixed(2)}%` : "—"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
