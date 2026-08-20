"use client";

import { useEffect, useState } from "react";

// Lee el tema activo de <html data-theme> y se re-suscribe a sus cambios, así
// los componentes que dibujan en canvas/SVG (que no heredan var(--*)) siguen el
// toggle en vivo. El script anti-parpadeo de layout.tsx fija el valor inicial.
export function useTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const read = () =>
      setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return theme;
}
