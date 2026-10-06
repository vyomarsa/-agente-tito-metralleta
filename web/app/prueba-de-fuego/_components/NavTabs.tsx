"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/pdf/i18n";

// Navegación entre las vistas del agente. Vive en la barra superior de cada
// página para que moverse entre ellas sea un clic, no un enlace perdido.
const TABS = [
  { href: "/prueba-de-fuego", key: "nav.pruebaDeFuego", icon: "🔥" },
  { href: "/ajustes", key: "nav.ajustes", icon: "⚙️" },
];

export default function NavTabs({ standalone = false }: { standalone?: boolean }) {
  const pathname = usePathname();
  const { t } = useLocale();
  const scrollRef = useRef<HTMLElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el || standalone) return;
    el.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [updateScrollState, standalone]);

  return (
    <div className="nav-tabs-wrap">
      <nav
        ref={scrollRef}
        className={`nav-tabs ${standalone ? "standalone" : ""}`}
        aria-label={t("nav.sections")}
      >
        {TABS.map((tab) => {
          const on = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`nav-tab ${on ? "on" : ""}`}
              aria-current={on ? "page" : undefined}
            >
              <span className="nav-tab-icon" aria-hidden="true">{tab.icon}</span>
              {t(tab.key)}
            </Link>
          );
        })}
      </nav>
      {!standalone && canScrollRight && (
        <button
          type="button"
          className="nav-tabs-more"
          aria-label={t("nav.moreTabs")}
          onClick={() => scrollRef.current?.scrollBy({ left: 160, behavior: "smooth" })}
        >
          ›
        </button>
      )}
    </div>
  );
}
