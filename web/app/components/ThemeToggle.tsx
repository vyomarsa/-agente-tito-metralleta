"use client";

import { useEffect, useState } from "react";

// Toggle claro/oscuro. El tema real lo fija el script anti-parpadeo de
// layout.tsx en <html data-theme>; aquí solo lo leemos al montar y lo
// alternamos, persistiendo la elección en localStorage ('tito.theme').
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    try {
      localStorage.setItem("tito.theme", next ? "dark" : "light");
    } catch {
      /* localStorage bloqueado: el tema sigue aplicado en esta sesión */
    }
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      title={dark ? "Modo claro" : "Modo oscuro"}
    >
      {dark ? "☀️" : "🌙"}
    </button>
  );
}
