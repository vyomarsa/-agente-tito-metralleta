import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";
import Sidebar from "./components/Sidebar";
import TickerTape from "./components/TickerTape";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "VYO, MT. — AI Options Agent",
  description: "AI Options Agent — scorecard, flujo y predicción.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Anti-parpadeo: fija data-theme en <html> ANTES de pintar, leyendo la
  // preferencia guardada (o la del sistema). Si esto corriera en React, la
  // primera pintada saldría en claro y saltaría a oscuro — un flash feo.
  const themeInit = `(function(){try{var t=localStorage.getItem('tito.theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();`;

  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={spaceGrotesk.className}>
        {/* La cinta va FUERA del shell: cruza el ancho completo por encima de la
            barra lateral, como el panel de una bolsa. */}
        <TickerTape />
        <div className="app-shell">
          <Sidebar />
          <div className="app-main">{children}</div>
        </div>
      </body>
    </html>
  );
}
