# Sub-Agente Escáner de Credit Spreads (5–7 DTE) — Diseño

**Fecha:** 2026-07-26
**Estado:** Plan aprobado, sin implementar.
**Fuente de criterios:** `PROMPT_Agente_Credit_Spreads_5-7DTE_1.md` (prompt de sistema del operador).
**Encaje:** pestaña de estrategia independiente `/spreads`, gemela arquitectónica de `/wheel`. **NO** es uno de los 6 sub-agentes del scorecard direccional.

---

## 1. Objetivo

Screener que responde: *"¿qué credit spread de 5–7 DTE sobre una acción individual cumple TODOS los filtros hoy, y cuál es su verdad estadística?"*. Vende prima con riesgo definido: `Put Credit Spread` (sesgo alcista/neutral) y `Call Credit Spread` (sesgo bajista/neutral). Su función es **filtrar y descartar** — "cero candidatos" es una salida correcta y frecuente. Nunca relaja un parámetro para producir un resultado (misma filosofía que la regla de liquidez de Tito).

---

## 2. Fuentes de datos — decisiones

| Insumo (Sección 2 del prompt) | Fuente en Tito | Nota |
|---|---|---|
| Chain con **delta/IV/OI/bid-ask** por strike | **Schwab** (`fetchOptionChain` → `SchwabContract`) — PRIMARIA | El prompt prohíbe estimar delta/prima sin datos reales (Sección 10.2). Schwab da greeks reales; **Massive NO da delta**. |
| Precio spot | Massive `fetchCompany` (con fix de cierre previo) | |
| Cap de mercado | Massive `fetchCompany.marketCap` | Elegibilidad ≥ $10B |
| **Volumen promedio diario 20d** de la acción | Calcular desde `cachedDailyBars` (media de 20 barras) | **A construir** (`avg20dVolume`), trivial |
| DTE + fecha actual | Cálculo | Ventana 5–7 |
| **Fecha de earnings** | `earningsForTicker` (ESTIMADOR) | Conservador: estimado-dentro → descartar. Ver §7 gap. |
| **Calendario macro FOMC/CPI/PCE/NFP** | ❌ **NO existe** → `data/macro-calendar.json` curado | Ver §7 gap (bloqueante). |
| Sesgo direccional | Selector del usuario + sugerencia auto de `findLevels`/GEX | El prompt exige sesgo explícito; no lo inventamos en silencio. |
| IV / IV Rank | Schwab IV (chain) + `rankWithin` sobre vol realizada | IV Rank sigue siendo proxy hasta acumular historia. |
| Capital de cuenta | `localStorage` (`tito.risk.*`), **solo cliente** | Nunca llega al server (misma regla que Wheel/Ideas). |

**Consecuencia clave:** este screener **depende de Schwab conectado**. Si Schwab no está conectado → estado claro "conecta Schwab en /schwab", NO se cae a estimación silenciosa (lo prohíbe el mandato). Fallback Black-Scholes solo como modo degradado explícitamente etiquetado, si se decide permitirlo.

---

## 3. Prerrequisitos (Fase 0 — cerrar antes del motor)

1. **Calendario macro** vía **FRED API** (Reserva Federal de St. Louis — fuente oficial, gratis, JSON). Endpoint `fred/release/dates?release_id=X&include_release_dates_with_no_data=true` devuelve fechas FUTURAS programadas. Release IDs usables: **CPI=10, Employment Situation/NFP=50, Personal Income & Outlays/PCE=54** (una fecha por mes, limpias). **FOMC=101 NO sirve** (FRED lo etiqueta a diario, sin fechas de reunión futuras) → se cura el calendario oficial de la Fed en `FOMC_STATEMENT_DATES`. `lib/macroCalendar.ts` (I/O de fetch + cache diario en `data/macro-calendar.json`) expone `macroEventsInWindow(from, to)` (PURA sobre los datos cacheados) → lista de eventos en la ventana. Key gratis en `.env.local` como `FRED_API_KEY`. Es el Filtro 4, eliminatorio. Fallback: si FRED falla, usar el último cache marcado `stale`; si no hay cache, devolver `null` → el motor BLOQUEA con aviso (no operar a ciegas).
2. **Volumen 20d** (`avg20dVolume(bars)` en `lib/massive.ts` o util nuevo): media simple de volumen de las últimas 20 barras. Elegibilidad Sección 3.
3. **Decisión earnings:** aceptar el estimador conservador de `earningsForTicker` para el MVP, con etiqueta "estimado — verifícalo" en la ficha. (Opcional futuro: fuente de earnings confirmada.)

---

## 4. Arquitectura de archivos (espeja el Wheel)

```
lib/creditSpread.ts        # PURO: elegibilidad, filtros, selección de patas, crédito, hit-rate, score. Tests.
lib/creditSpread.test.ts   # cobertura de cada filtro y de "cero candidatos"
lib/spreadUniverse.ts      # universo curado SOLO acciones individuales con weeklies (sin ETFs). Tests.
lib/macroCalendar.ts       # Fase 0. Tests.
app/api/spreads/route.ts   # SSE: orquesta I/O (Schwab chain + bars + levels + earnings + macro). Cero criterio.
app/spreads/page.tsx       # UI: selector de sesgo + tabla resumen (9-A) + fichas (9-B)
app/spreads/types.ts       # SseEvent + tipos de UI
app/components/SpreadCard.tsx   # ficha detallada (formato Sección 9-B)
app/components/SpreadsTable.tsx # tabla resumen de descartes (Sección 9-A)
```
Registrar pestaña `{ href: "/spreads", label: "Spreads", icon: "✂️" }` en `NavTabs.tsx`.
Guardar el prompt de sistema en `Sub Agentes/Credit Spreads 5-7 DTE.md` (carpeta ya prevista para sub-agentes).

---

## 5. Motor puro `lib/creditSpread.ts` — responsabilidades

Todo PURO (sin red/disco). API propuesta:

- `type Bias = "alcista" | "bajista" | "neutral"` → put spread (alcista/neutral) vs call spread (bajista/neutral).
- **Elegibilidad (Sección 3):** `eligibility(input)` → `{ ok, fails: string[] }`. Umbrales: cap ≥$10B, vol20d ≥5M, precio ≥$30, weeklies, OI cadena ≥10k, vol opciones día ≥2k, bid-ask ≤$0.05 en Δ 0.10–0.19. Instrumento acción individual (no ETF).
- **Filtros eliminatorios EN ORDEN (Sección 4):** `runFilters` corta en el primero que falla y reporta la causa. Filtro 0 instrumento → 1 elegibilidad → 2 DTE 5–7 → 3 earnings → 4 macro → 5 liquidez de contrato.
- **Selección de patas (Sección 5):**
  - Corta: `0.10 ≤ |Δ| < 0.20` (0.20 EXCLUIDO). Prioriza el **delta más bajo** que aún cumpla el crédito de su banda.
  - Larga: |Δ| 0.02–0.05, mismo vencimiento, más OTM, ancho **$1–$2**.
  - **Validación de distancia (5.5):** strike corto debe quedar **fuera de 1σ** = `spot × iv × √(dte/365)`. Reusa `expectedMove` de `lib/expectedMove.ts`. Delta y 1σ son dos filtros distintos; ambos deben pasar.
- **Crédito (Sección 6) — OJO, sobre el MID (no el bid):** ⚠️ **diferencia crítica con el Wheel**, que usa bid con haircut. Aquí `credit = mid(corta) − mid(larga)`. Bandas: Δ 0.10–0.15 → ≥10–15% del ancho; Δ 0.16–0.19 → **≥20% del ancho**; Δ ≥0.20 → descartado. Si no alcanza el crédito de su banda → descartar (no compensar subiendo delta/ancho).
- **Advertencia matemática (Sección 7) — OBLIGATORIA en cada ficha:** `breakevenHitRate = maxRisk / width`. Contrastar con prob. OTM ≈ `1 − |Δ|`. Etiqueta `⚠ ZONA DE DELTA ELEVADO` si Δ > 0.15.
- **Liquidez de contrato (Filtro 5):** por pata bid-ask ≤$0.05 (pref ≤$0.03), bid>0 en la corta, OI ≥500, vol día >0. Si el bid-ask combinado consume >30% del crédito objetivo → descartar.
- **Gestión (Sección 8):** derivar cerrar en 80–90% del crédito, stop a 1.5–2× crédito o Δ corto >0.30, alerta gamma 0–2 DTE, riesgo por contrato. Dimensionamiento (2–3% capital) **solo en cliente**.
- **Salida:** `SpreadCandidate` con estructura, economía, validación de filtros, realidad estadística y gestión — el molde exacto de la ficha 9-B.

Ordenar: candidatos válidos primero; entre ellos, mayor margen sobre el equilibrio / menor delta. Descartados con su motivo (tabla 9-A).

---

## 6. Ruta SSE `app/api/spreads/route.ts`

Mismo patrón que `wheel/route.ts`: `ReadableStream` + `mapLimit` (concurrencia ~6) sobre `spreadUniverse`. Por ticker:
1. `schwabStatus()` — si no conectado, emitir estado y abortar con mensaje claro.
2. `fetchOptionChain(ticker, {dteMin:5, dteMax:7})` (Schwab) → strikes con delta/IV/OI/bid-ask reales.
3. `fetchCompany` (cap, spot) + `cachedDailyBars` (→ `avg20dVolume`, `findLevels`, IV Rank proxy).
4. `earningsForTicker` (ventana) + `macroEventsInWindow`.
5. `creditSpreadCandidates({...})` (puro) → candidatos/descartes.
6. `send` progreso por ticker; al final `done` con candidatos + meta (escaneados, descartados por causa, degradado).

Cero criterio en la ruta. El saldo NO llega aquí.

---

## 7. Gaps y decisiones abiertas

- **Macro (RESUELTO):** **FRED API** (oficial de la Fed, gratis). Base `https://api.stlouisfed.org/fred/`, key gratis instantánea en https://fredaccount.stlouisfed.org/apikeys (rate ~120 req/min, sobra). Se consultan 4 release IDs (10 CPI, 50 NFP, 54 PCE, 101 FOMC) con `include_release_dates_with_no_data=true` para traer las fechas futuras programadas; se cachea a diario. Se descartó scraping de ForexFactory/Investing (frágil, contra ToS) y las APIs de pago: FRED es la fuente de verdad de estos 4 eventos.
- **Earnings:** estimador conservador con etiqueta. Suficiente para el mandato (estimado-dentro → descartar), imperfecto en fechas movidas.
- **Dependencia de Schwab:** sin conexión, el screener no corre en modo real. Access token ~30 min (auto-refresh), refresh ~7 días.
- **Universo:** partir de `WHEEL_UNIVERSE` **filtrando ETFs** o crear `spreadUniverse` propio de acciones muy líquidas con weeklies. Revisar que ninguno sea fondo.
- **Sesgo direccional:** selector explícito con sugerencia auto desde `findLevels`/GEX; no inventar dirección en silencio.

---

## 8. Plan por fases (checklist)

**Fase 0 — Prerrequisitos** ✅ COMPLETADA (2026-07-26)
- [x] Obtener `FRED_API_KEY` gratis y ponerla en `.env.local` (verificada en vivo)
- [x] `lib/macroCalendar.ts` (fetch FRED **CPI=10/NFP=50/PCE=54** + cache `data/macro-calendar.json`) + `macroEventsInWindow` puro + tests (11 ✓)
  - **Hallazgo:** el release **FOMC=101 de FRED NO sirve** — está etiquetado a DIARIO (count ~3.7k, una fecha por día, y sin fechas futuras de reunión). Se resolvió curando el calendario oficial de la Fed en `FOMC_STATEMENT_DATES` (2026+2027, día del comunicado = último día de la reunión de 2 días). Revisar/extender una vez al año.
- [x] `avg20dVolume` (`lib/volume.ts`, PURO) + test (6 ✓); se añadió `volume?` a `DailyBar` y al mapeo de `fetchDailyBars` (Massive `v`)
- [x] Confirmar shape de `fetchOptionChain` de Schwab: `SchwabContract` da strike/type/expiration/dte/bid/ask/last/volume/openInterest/iv%/delta/gamma/theta/vega, y `fetchOptionChain` acota vencimientos con `fromDate`/`toDate` → ventana 5–7 DTE filtrable. ✔

**Fase 1 — Motor puro** ✅ COMPLETADA (2026-07-26)
- [x] `lib/spreadUniverse.ts` (35 acciones individuales, sin ETFs, cada una con `sector` para la regla de concentración §8) + test (3 ✓, incl. guard anti-ETF)
- [x] `lib/creditSpread.ts`: `mid`, `requiredCreditPct` (bandas 10%/20%), `eligibility` (§3), `buildStructure` (selección de patas + crédito sobre MID + 1σ + liquidez de contrato §5·F5), `creditSpreadCandidates` (filtros 0→1→3→4→estructura en orden, corte en el primero que falla), tipos ricos para la ficha 9-B (economía + realidad estadística + gestión). Umbrales exportados como constantes tuneables.
- [x] `lib/creditSpread.test.ts` (28 ✓): mid, banda de crédito, elegibilidad (cap/vol/precio/bid-ask), camino feliz put + call, Δ≥0.20 excluido, crédito insuficiente vs banda, 1σ dentro→descarta, bid-ask combinado >30%→descarta, bid corto 0, OI<500, sin pata larga en ancho $1–$2, filtros 0/1/3/4, "sin candidatos", respeto del sesgo.
- [x] `npm test` verde: **482 tests** + `tsc --noEmit` exit 0.
- **Nota de diseño (tensión asumida):** ancho $1–$2 (DURO) y delta largo 0.02–0.05 (OBJETIVO) rara vez coexisten en strikes de $1; se resolvió haciendo el ancho restricción dura y el delta largo una preferencia (se elige el largo más cercano a Δ0.035 dentro del ancho válido), con bandera `longDeltaInBand`. El crédito se calcula sobre el MID (no bid con haircut como el Wheel).

**Fase 2 — Ruta + UI** ✅ COMPLETADA (2026-07-26)
- [x] `app/api/spreads/route.ts` (SSE, `mapLimit` concurrencia 4, Schwab-first: `schwabStatus()` antes del bucle → si no conectado, evento `error` con `kind:"schwab"` y aborta; macro `null` → `error` con `kind:"macro"`). SchwabContract→SpreadQuote (IV %÷100, delta con signo). Filtro macro global sobre ventana hoy→hoy+7.
- [x] `app/spreads/{page.tsx,types.ts}` + `SpreadCard.tsx` (ficha 9-B, patas VENDE/COMPRA, economía, realidad estadística §7, gestión §8) + `SpreadsTable.tsx` (resumen 9-A en `<details>`, estado+motivo por ticker)
- [x] Pestaña `{ href: "/spreads", label: "Spreads", icon: "✂️" }` en `NavTabs.tsx`
- [x] Dimensionamiento en cliente (`sizing()` en SpreadCard: techo por `tolerancePct` + referencias 2%/3% del mandato; el saldo nunca sale del navegador)
- [x] Verificado en preview con **Schwab conectado**: escaneó 35 acciones con delta/IV reales. Salida "0 candidatos" correcta (es domingo/mercado cerrado + **FOMC 2026-07-29 dentro de la ventana** bloqueó NVDA/NFLX/NKE por macro; BAC por earnings; el resto por bid-ask típico >$0.05 —spreads anchos con quotes de mercado cerrado— o vol20d <5M / OI cadena <10k). `tsc` limpio, **482 tests** verdes.
- **Observación:** el filtro `MAX_TYPICAL_SPREAD=$0.05` es muy estricto con quotes de mercado cerrado/retrasadas; con mercado abierto y líquido debería dejar pasar a los subyacentes grandes. El filtro macro funciona perfecto: cazó el FOMC de esta semana como corresponde. Revisar cobertura un día de mercado abierto.

**Cierre** ✅ COMPLETADA (2026-07-26)
- [x] Guardar prompt en `Sub Agentes/Credit Spreads 5-7 DTE.md` (carpeta creada)
- [x] Actualizar `CLAUDE.md` (viñeta `/spreads`) y memoria del proyecto

---

## 9. Diferencias críticas vs. Wheel (no copiar a ciegas)

1. **Crédito sobre MID**, no bid con haircut (el Wheel usa `pickPremium` con `HAIRCUT`). Los credit spreads calculan sobre el mid.
2. **Dos patas** que hay que emparejar por ancho $1–$2, no un solo strike.
3. **Delta real de Schwab** obligatorio (el Wheel lo estima con Black-Scholes; aquí el prompt lo prohíbe).
4. **Filtro macro** nuevo (el Wheel no lo tiene).
5. **Banda de delta 0.10–0.19** estricta (el Wheel usa bandas por preset hasta 0.40).
6. **Hit-rate de equilibrio obligatorio** en cada ficha (Sección 7) — no existe en el Wheel.
