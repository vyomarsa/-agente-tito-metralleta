import { LocaleProvider } from "@/lib/pdf/i18n";
import "./pdf.css";

// Prueba de Fuego (Visionary Trades) integrada como sección de Tito. Su CSS
// viene con alcance `.pdf-root` (ver pdf.css) para no pisar los estilos de Tito,
// y su código/APIs/datos viven aparte: lib/pdf, /api/pdf, data/pdf.
export default function PruebaDeFuegoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="pdf-root">
      <LocaleProvider>{children}</LocaleProvider>
    </div>
  );
}
