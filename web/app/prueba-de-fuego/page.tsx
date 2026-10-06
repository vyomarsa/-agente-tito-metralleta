"use client";

import { useEffect, useState } from "react";
import BrandMark from "@/app/prueba-de-fuego/_components/BrandMark";
import NavTabs from "@/app/prueba-de-fuego/_components/NavTabs";
import TickerLiveTab from "./TickerLiveTab";
import SpxVecinosTab from "./SpxVecinosTab";
import AgenteOdteTab from "./AgenteOdteTab";
import ContratosVecinos2Tab from "./ContratosVecinos2Tab";
import ContratosVecinos3Tab from "./ContratosVecinos3Tab";
import ContractSearchTab from "./ContractSearchTab";
import GrandesEmpresasTab from "./GrandesEmpresasTab";
import GrandesEmpresas2Tab from "./GrandesEmpresas2Tab";
import OdteStandaloneTab from "./OdteStandaloneTab";
import BtcTab from "./BtcTab";
import { migrateLegacyKey } from "@/lib/pdf/legacyStorage";

const KEY_TAB = "visionary.pruebaDeFuego.tab";

type Tab = "TSLA" | "SPX" | "SPX_VECINOS" | "SPX_0DTE" | "VECINOS_2" | "VECINOS_3" | "buscar" | "GRANDES" | "ODTE_STANDALONE" | "GRANDES_2" | "BTC";

// TSLA/SPX/SPX_VECINOS/SPX_0DTE/VECINOS_2/VECINOS_3: pedido explícito (ago 2026) —
// sacadas de la navegación visible, NO borradas. El componente, la ruta y el
// `case` de render siguen intactos más abajo a propósito, por si hace falta
// traerlas de vuelta: para eso alcanza con volver a agregar el `<button>`
// correspondiente al array de abajo.
const VISIBLE_TABS: Tab[] = ["ODTE_STANDALONE", "buscar", "GRANDES", "GRANDES_2", "BTC"];
const DEFAULT_TAB: Tab = "GRANDES";

export default function PruebaDeFuegoPage() {
  const [tab, setTab] = useState<Tab>(DEFAULT_TAB);

  useEffect(() => {
    migrateLegacyKey("tito.pruebaDeFuego.tab", KEY_TAB);
    const saved = window.localStorage.getItem(KEY_TAB);
    if (VISIBLE_TABS.includes(saved as Tab)) {
      setTab(saved as Tab);
    }
  }, []);

  const pickTab = (t: Tab) => {
    setTab(t);
    window.localStorage.setItem(KEY_TAB, t);
  };

  return (
    <main className="ideas-page">
      <div className="hb">
        <BrandMark subtitle="🔥 Prueba de Fuego · day-trading en vivo" />
        <NavTabs />
      </div>

      <div className="ideas-body">
        <div className="view-toggle-row">
          <div className="view-toggle">
            <button className={tab === "ODTE_STANDALONE" ? "active" : ""} onClick={() => pickTab("ODTE_STANDALONE")}>
              0DTE
            </button>
            <button className={tab === "buscar" ? "active" : ""} onClick={() => pickTab("buscar")}>
              Búsqueda de contratos
            </button>
            <button className={tab === "GRANDES" ? "active" : ""} onClick={() => pickTab("GRANDES")}>
              Grandes empresas
            </button>
            <button className={tab === "GRANDES_2" ? "active" : ""} onClick={() => pickTab("GRANDES_2")}>
              Grandes empresas 2.0
            </button>
            <button className={tab === "BTC" ? "active" : ""} onClick={() => pickTab("BTC")}>
              BTC
            </button>
          </div>
        </div>

        {tab === "TSLA" && <SpxVecinosTab ticker="TSLA" />}
        {tab === "SPX" && <TickerLiveTab ticker="SPX" />}
        {tab === "SPX_VECINOS" && <SpxVecinosTab ticker="SPX" />}
        {tab === "SPX_0DTE" && <AgenteOdteTab />}
        {tab === "ODTE_STANDALONE" && <OdteStandaloneTab />}
        {tab === "VECINOS_2" && <ContratosVecinos2Tab />}
        {tab === "VECINOS_3" && <ContratosVecinos3Tab />}
        {tab === "buscar" && <ContractSearchTab />}
        {tab === "GRANDES" && <GrandesEmpresasTab />}
        {tab === "GRANDES_2" && <GrandesEmpresas2Tab />}
        {tab === "BTC" && <BtcTab />}
      </div>
    </main>
  );
}
