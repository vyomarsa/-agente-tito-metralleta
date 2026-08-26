# Pestaña "Day" de Mis Trades — RETIRADA de la app (2026-08-24)

Se quitó del menú de `/trades` porque **no hay agente de day trading todavía**.

La pestaña no tenía motor propio: filtraba la bitácora del piloto por la NOTA del
trade (`nota.includes("day")`), y esa nota la escribe quien crea el trade. El
piloto automático solo escribe `"Swing"`, así que la pestaña salía **siempre
vacía** — una puerta a una habitación que aún no existe.

**No se pierde nada.** Los trades intradía que se creen a mano con la nota
"Day Trading" siguen apareciendo en **Todos**; lo único que desaparece es el
filtro. Y como la nota es texto libre, el día que haya agente de day trading el
filtro vuelve a funcionar tal cual, sin migrar datos.

## Qué había, exactamente

Tres piezas en `web/app/trades/page.tsx`, todas de una línea:

**1. El tipo de pestaña**

```tsx
type TabId = "todos" | "swing" | "day" | "cero" | "prima";
```

**2. La entrada del menú**, entre "Swing" y "0DTE":

```tsx
{ id: "day", label: "Day", hint: "Intradía" },
```

**3. La rama del filtro** en `matchesTab`, después de la de swing:

```tsx
if (tab === "day") return nota.includes("day");
```

Además, el campo "Nota" del alta manual tenía `placeholder="Day Trading"`; ahora
pone `"Swing"`, que es lo que de verdad se usa.

## Cómo revivirla

Devolver las tres líneas a su sitio. No hay API, ni CSS, ni datos que tocar: la
ficha de cada trade (`TradeCard`) es la misma para todas las pestañas de la
bitácora.

Si para entonces existe un agente de day trading con **cuenta propia** (como
0DTE y Venta Prima), lo suyo NO es revivir esto: sería una pestaña como las de
esos dos —con su capital, su win rate y su libro— y no un filtro por nota.
