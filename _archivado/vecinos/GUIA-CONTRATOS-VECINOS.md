# Guía — Contratos Vecinos 2.0 (`/vecinos`)

Cómo leer la pantalla y qué hacer con lo que dice. Acompaña a la app (`web/`) y es
hermana de [GUIA-ESTUDIANTES.md](GUIA-ESTUDIANTES.md).

El método lo aportó un compañero del grupo de trading. La implementación técnica
—filtros, constantes, decisiones de diseño— está en [CLAUDE.md](CLAUDE.md); esto es
la guía de lectura.

> ⚠ **No es consejo financiero.** Los datos de la cadena y del flujo pueden venir
> retrasados. El 0DTE es de altísimo riesgo: esto es contexto, no una recomendación
> de operar. El agente calcula y muestra; tú decides y ejecutas.

---

## 1. Qué pregunta responde

Una sola: **¿hacia dónde tira el precio hoy, y hay dinero real empujando en esa
dirección?**

Son dos cosas separadas a propósito, y ese es el corazón del método:

- **La dirección la pone el imán del GEX.** Es estructura: dónde está concentrada la
  gamma de los dealers, o sea hacia dónde gravita el precio por cómo están
  posicionados. El dinero no vota aquí.
- **El dinero real solo confirma o no.** Si nadie está pagando el ASK en esa
  dirección, la estructura dice una cosa y la caja registradora no la acompaña.

Cuando las dos coinciden, hay señal. Cuando no, el método lo dice en vez de
inventarse una.

---

## 2. Arroz y habichuela

Imagínate que el piso está **inclinado** hacia un lado. La bola quiere rodar para
allá sola. Eso es el **imán**.

Ahora, que el piso esté inclinado no quiere decir que la bola se vaya a mover. Falta
que **alguien la empuje**. Eso es el **dinero real**: gente pagando de verdad, hoy,
en esos strikes.

La pantalla mira las dos cosas por separado y da una de tres respuestas:

| Veredicto | Traducción |
|---|---|
| **ENTRAR** | El piso está inclinado *y* hay gente empujando. Las dos cosas cuadran. |
| **ESPERAR BREAKOUT** | El piso está inclinado pero **nadie está empujando**. Todavía no. Que el precio rompa primero y lo demuestre. |
| **LATERAL** | El piso está plano. No hay pa' dónde. Quieto. |

**ESPERAR BREAKOUT es la que más dinero ahorra.** Es exactamente el momento en que la
estructura te tienta y el flujo no la respalda.

---

## 3. Los porcentajes (aquí está la trampa)

El % **no** es probabilidad de ganar. Es: *qué tan fácil el precio toca ese strike
antes de que cierre el mercado*.

Y el truco es que **mientras más cerca el strike, más alto el número**.

Ejemplo real del SPX (cierre del 2026-08-14, spot 7781.52, imán en 7850):

| | Strike | % | Qué significa de verdad |
|---|---|---|---|
| Confirmado | 7785 | **95%** | pegado al precio → casi seguro que lo toca |
| Confirmado | 7790 | 72% | |
| Confirmado | 7800 | 58% | |
| 🧲 Imán | 7850 | **9%** | lejos → llegar hoy es un estirón |

Dos lecturas que hay que separar:

- **Un 95% no es una señal fuerte, es un strike cercano.**
- **Un imán al 9% no significa que la tesis sea mala**, significa "ahí es donde tira,
  pero hoy no da tiempo".

**La fuerza de la señal no está en el número: está en cuántos strikes confirmaron y
con qué etiqueta.**

Lo mismo aplica al revés en las rupturas. Si una ruptura marca 43% porque está a 11
puntos, lo que importa de esa fila no es el 43% — es **que ahí hay compra agresiva de
puts**.

---

## 4. Las etiquetas de cada objetivo

| Etiqueta | Qué hay detrás | Peso |
|---|---|---|
| **DINERO REAL** | Alguien ejecutó al ASK/BID en ese strike hoy | La confirmación buena |
| **POSICIÓN** | Sin flujo; se leyó por posicionamiento (OI × gamma). Hay posiciones abiertas a favor, pero **nadie empuja ahora** | Más débil — la app lo avisa |
| **SIN FLUJO** | El imán cayó fuera del vecindario (a más de 10 strikes). No hay nada que leer ahí | Solo estructura lejana |

---

## 5. Lo más importante de la pantalla

**"Objetivos de ruptura".** Eso es **dónde tú estás equivocado**.

Si el precio llega ahí, se acabó el cuento: el imán no sirvió y no hay por qué
seguir. **Míralo antes de mirar hacia dónde puede subir.** Uno se emociona con el
premio y se le olvida la salida.

---

## 6. Orden de lectura recomendado

1. **Veredicto** — si dice ESPERAR o LATERAL, ya terminaste.
2. **Confirmaciones** — cuántas y de qué tipo. Una sola etiquetada POSICIÓN no es lo
   mismo que tres con DINERO REAL.
3. **Régimen** — γ+ significa que el dealer estabiliza y el imán ancla de verdad;
   γ− significa que amplifica y el anclaje es menos fiable (el motor ya descuenta un
   25% en ese caso).
4. **La ruptura más cercana** — antes del objetivo, mira dónde se rompe la tesis.
5. **El vecindario** — ¿el flujo está concentrado en un strike o repartido en varios?
   Repartido y escalonado pesa más.

### Dos ejemplos reales (cierre del 2026-08-14)

**IWM: ESPERAR BREAKOUT.** Imán en 306, precio en 305.09, objetivo etiquetado
**POSICIÓN** al 90%. Traducido: hay un muro de open interest en 306 que atrae, está a
un dólar, es casi seguro que lo toca… **y ni un dólar de dinero real empuja hacia
allí**. Eso es un imán vacío. Bonito y hueco.

**SPX: ENTRAR.** Tres strikes seguidos (7785, 7790, 7800) con compra agresiva de
calls y venta de puts, escalonados camino al imán. Eso no es un ticket suelto: es
alguien armando posición escalón por escalón. Y la invalidación está clara y cerca:
7770.

---

## 7. Lo que esta pantalla NO te da

No dice **cuántos contratos**, ni **a qué precio entrar**, ni **dónde poner el
stop**. No calcula tamaño y no conoce tu cuenta.

Da contexto direccional y niveles de invalidación. La ejecución y el riesgo siguen
siendo tuyos.

---

## 8. Los 6 pasos del método (referencia)

1. **Dirección = imán del GEX.** GEX neto por strike (gamma REAL de la cadena ×
   Open Interest, +call/−put); el de mayor concentración es el imán. Se compara con
   el spot usando la **grilla real de strikes**, no un % fijo: mismo strike →
   lateral; arriba → CALL; abajo → PUT.
2. **Vecindario.** 10 strikes por lado. Con el net premium real de hoy: compra de
   calls = alcista, compra de puts = bajista, venta de calls = resistencia, venta de
   puts = soporte. Se fusionan en un sesgo neto por strike.
3. **Respaldo sin flujo (2b).** Donde el dinero real dio cero, se clasifica por
   posicionamiento según **qué lado domina dentro del propio strike**: predominan
   calls → resistencia, predominan puts → soporte. Solo cuenta el **top 30%** del
   posicionamiento neto del vecindario. El flujo real siempre manda si existe.
4. **Objetivos hacia el imán.** Hasta 3 strikes del camino que confirmen la
   dirección, más el imán como cuarto y último.
5. **Objetivos de ruptura.** Hasta 4 del lado contrario que confirmen la dirección
   opuesta.
6. **Probabilidad y decisión.** Probabilidad estadística de toque (distancia + IV +
   horas al cierre) ajustada por la agresividad del flujo en ese strike; ruptura
   ×0.65; hacia el imán en γ− ×0.75; nunca 0% ni 100% (banda 3%–95%).

---

## 9. Limitaciones honestas

- **Se lee con el mercado abierto y venciendo hoy.** Fuera de sesión la app coge el
  vencimiento más cercano, y con más días por delante las probabilidades se ensanchan
  y significan otra cosa.
- **Piso de $25.000 por operación** en el flujo. Los tickets pequeños no cuentan —que
  es lo que se quiere—, pero en un símbolo poco líquido verás muchos strikes vacíos.
- **Instrumentos soportados:** SPY, QQQ, IWM, SPX, NDX.
- **La confirmación cruzada con el índice hermano está inactiva.** El método la
  reserva para futuros (SPX para ES, NDX para NQ) y el proveedor de datos no sirve
  futuros. Los cinco instrumentos de la vista tienen flujo real propio.
- **Los porcentajes son de toque, no de acierto.** No son un backtest: nadie ha
  medido todavía cuántas veces esta señal funcionó. Para eso está el archivo
  histórico en `Desktop/VyoBot/flatfiles`.
