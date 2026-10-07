import PremarketTab from "../prueba-de-fuego/PremarketTab";
import "../prueba-de-fuego/pdf.css";

// Acceso directo desde la barra lateral (pedido del dueño, 2026-10-07) a la
// pestaña "Pre-market" de Prueba de Fuego: el MISMO componente, con su CSS de
// alcance `.pdf-root`. Los movers del S&P 500 en la sesión extendida.
export default function PremarketPage() {
  return (
    <div className="pdf-root">
      <main className="ideas-page">
        <div className="ideas-body">
          <PremarketTab />
        </div>
      </main>
    </div>
  );
}
