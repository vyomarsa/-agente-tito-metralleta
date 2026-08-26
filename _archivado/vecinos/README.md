# Contratos Vecinos 2.0 — RETIRADO de la app (2026-08-24)

Se quitó de Tito porque **el 0DTE (`/0dte`) quedó más completo** y lo absorbe: el
imán del GEX, el régimen γ+/γ−, la zona de flip y el agresor por strike que aquí
eran el método entero, allí son solo una parte de la vista, y además con cinta en
vivo (CVD, velocidad, bloques), dos modelos de trade con marcador, pinning de
cierre y auto-evaluación.

**No está borrado, está archivado.** Este proyecto no está bajo control de
versiones, así que borrar sería irreversible.

## Qué hay aquí

| Archivo | Dónde vivía |
|---|---|
| `web/app/vecinos/` | `web/app/vecinos/` (página + tipos) |
| `web/app/api-vecinos/route.ts` | `web/app/api/vecinos/route.ts` |
| `web/lib/vecinos.ts` + `.test.ts` | `web/lib/` (motor PURO, 40 tests) |
| `web/vecinos.css` | bloque `.vec-*` al final de `web/app/globals.css` |
| `GUIA-CONTRATOS-VECINOS.md` | raíz del repo |

## Cómo revivirlo

1. Devolver cada archivo a su ruta original (tabla de arriba).
2. Pegar `web/vecinos.css` de vuelta en `web/app/globals.css`.
3. Añadir la entrada al menú en `web/app/components/Sidebar.tsx`:
   ```tsx
   { href: "/vecinos", label: "Vecinos", icon: "🧲", hint: "Contratos Vecinos 2.0 — imán del GEX + flujo real (0DTE)" },
   ```

**Ojo con el CSS al revivirlo:** la página reusaba el esqueleto `z-*` del 0DTE
viejo (`.z-page`, `.z-grid`, `.z-head`, `.z-spotband`…). Ese esqueleto **sigue en
`globals.css`** y no se tocó, pero el 0DTE actual ya no lo usa: se rehízo con sus
propias reglas scopeadas bajo `.z-wrap`. O sea que Vecinos volvería a funcionar
tal cual, y las dos maquetaciones ya no se pisan. Si algún día se limpia ese
esqueleto muerto, esta página se rompe — de ahí este aviso.
