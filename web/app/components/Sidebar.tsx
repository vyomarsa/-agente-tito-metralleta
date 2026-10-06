"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";
import MarketPulse from "./MarketPulse";

// Barra lateral izquierda persistente (estilo "dashboard"): la marca arriba, la
// navegación entre las vistas del agente en vertical, y el toggle de tema al pie.
// Vive en el layout raíz, así que acompaña a TODAS las páginas sin repetir markup.
const NAV: { href: string; label: string; icon: string; hint: string }[] = [
  { href: "/", label: "Ticker", icon: "📈", hint: "Análisis de un símbolo" },
  { href: "/tarjeta", label: "Tarjeta", icon: "🃏", hint: "Decisión go/no-go por ticker" },
  { href: "/ideas", label: "Ideas", icon: "💡", hint: "Screener del mercado" },
  { href: "/trades", label: "Mis Trades", icon: "📓", hint: "Paper trading (simulación)" },
  { href: "/spreads", label: "Venta Prima", icon: "✂️", hint: "Credit spreads 4–7 DTE (venta de prima)" },
  { href: "/0dte", label: "0DTE", icon: "🎯", hint: "Cadena del día (cero DTE)" },
  { href: "/prueba-de-fuego", label: "Prueba de Fuego", icon: "🔥", hint: "Visionary Trades — 0DTE, contratos, grandes empresas, BTC" },
  { href: "/scalping", label: "Scalping", icon: "📐", hint: "Playbook del Rango — fase 1: observar los niveles" },
  { href: "/flow", label: "Time & Sales", icon: "⚡", hint: "Agresividad en vivo" },
  { href: "/tastytrade", label: "Tastytrade", icon: "📡", hint: "Fuente principal — IV Rank, greeks, cadena" },
  { href: "/schwab", label: "Schwab", icon: "🔗", hint: "Conexión del bróker" },
  { href: "/ajustes", label: "Ajustes", icon: "⚙️", hint: "Fuentes, alertas y cookie de respaldo" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="app-sidebar" aria-label="Navegación principal">
      <div className="side-brand">
        <div className="side-logo">🔬</div>
        <div className="side-brand-text">
          <div className="side-name">VYO, MT.</div>
          <div className="side-tag">AI Options Agent</div>
        </div>
      </div>

      <nav className="side-nav" aria-label="Secciones">
        {NAV.map((t) => {
          const on = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`side-link ${on ? "on" : ""}`}
              aria-current={on ? "page" : undefined}
              title={t.hint}
            >
              <span className="side-icon" aria-hidden="true">{t.icon}</span>
              <span className="side-label">{t.label}</span>
            </Link>
          );
        })}
      </nav>

      <MarketPulse />

      <div className="side-foot">
        <ThemeToggle />
      </div>
    </aside>
  );
}
