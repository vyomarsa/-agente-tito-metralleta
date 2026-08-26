# Wheel (cash-secured puts) — RETIRADO de la app (2026-08-24)

Se quitó porque **no encaja con las tres estrategias que el dueño está
desarrollando** (venta de prima con credit spreads, 0DTE y swing).

El motivo concreto es el capital: la Wheel vende puts respaldados con efectivo y
el colateral es `strike × 100` — un put de SPY inmoviliza **~$76.500**. La cuenta
de paper de venta de prima arranca con **$10.000**. Y el perfil de riesgo es
distinto: si te asignan, te quedas con 100 acciones; un credit spread tiene el
riesgo acotado por el ancho.

**No es redundante con `/spreads`, es otro escalón** — el sitio natural al que se
pasa desde credit spreads cuando hay capital. Por eso está archivado y no
borrado.

## Qué hay aquí

| Archivo | Dónde vivía |
|---|---|
| `web/app/wheel/` | página + tipos |
| `web/app/api-wheel/route.ts` | `web/app/api/wheel/route.ts` |
| `web/app/components/Wheel{PresetCard,Table}.tsx` | `web/app/components/` |
| `web/lib/wheel.ts` + `.test.ts` | motor PURO |
| `web/lib/wheelAfford.ts` + `.test.ts` | asequibilidad (cliente) |
| `web/lib/wheelUniverse.ts` + `.test.ts` | universo de 40 símbolos |

Los documentos de diseño **siguen en su sitio** (`web/docs/superpowers/`), no se
tocaron.

## Cómo revivirlo

1. Devolver cada archivo a su ruta original (tabla de arriba).
2. Añadir la entrada al menú en `web/app/components/Sidebar.tsx`:
   ```tsx
   { href: "/wheel", label: "Wheel", icon: "🎡", hint: "Cash-secured puts" },
   ```

## DOS cosas que NO se movieron, y por qué

**1. El CSS `.wheel-*` se queda en `globals.css`.** Pese al nombre, ya no es de la
Wheel: `/spreads` lo usa entero (`.wheel-row`, `.wheel-row-head`, `.wheel-score`,
`.wheel-tag`, `.wheel-grid`, `.wheel-plain`, `.wheel-outcomes`, `.wheel-list`,
`.wheel-empty`, `.wheel-disclaimer`, `.wheel-status`). Borrarlo rompe Venta Prima.
Es el esqueleto de ficha compartido, con un nombre heredado.

**2. `EarningsFlag` se sacó de `lib/wheel.ts` ANTES de archivar.** El tipo lo
definía la Wheel pero lo usaban también `lib/earnings.ts` y `lib/creditSpread.ts`
(venta de prima), así que archivar la Wheel tal cual habría roto el escáner de
spreads. Ahora vive en `lib/earnings.ts`, que es el módulo que de verdad lo
calcula, y `wheel.ts` lo importa de ahí. **Al revivir la Wheel no hay que
deshacer nada**: el import ya apunta al sitio correcto.
