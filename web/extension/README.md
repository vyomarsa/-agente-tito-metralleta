# Tito — Extensión "Traer cookie de MarketSnack"

Extrae la cookie de sesión de MarketSnack **con un clic**, sin DevTools, y se la envía
al agente Tito (`localhost:3000`), que la valida y la guarda. Reemplaza al método de
descifrar la base de cookies del navegador, que **no funciona** cuando el navegador usa
**App-Bound Encryption** (el caso de Chrome/Brave/Edge actuales). Esta extensión sí
funciona porque le pide la cookie ya descifrada al propio navegador (API `chrome.cookies`).

## Instalar (una sola vez)

Funciona igual en **Chrome, Brave y Edge** (todos Chromium):

1. Abre la página de extensiones:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
2. Activa **"Modo de desarrollador"** (arriba a la derecha en Chrome/Brave; abajo a la
   izquierda en Edge).
3. Clic en **"Cargar descomprimida"** (Load unpacked) y elige esta carpeta:
   `…\agente-tito-metralleta\web\extension`
4. Aparecerá el icono de la extensión en la barra. (Opcional: fíjalo con el pin.)

## Usar (cada vez que caduque la cookie)

1. Asegúrate de tener **sesión iniciada en `app.marketsnack.com`** en ese navegador.
2. Asegúrate de que **Tito está corriendo** (doble clic en `Iniciar Tito`).
3. Clic en el icono de la extensión → botón **"Traer cookie y enviar a Tito"**.
4. Debe decir *"✅ Cookie válida, enviada y guardada"*. Listo — ya está activa en Tito
   sin reiniciar, igual que si la hubieras pegado en `/ajustes`.

## Si falla

- **"No hay cookies de marketsnack.com"** → no hay sesión en ese navegador; inicia sesión.
- **"No pude contactar a Tito en localhost:3000"** → el agente no está corriendo; ábrelo.
- **"El agente rechazó la cookie"** → la sesión del navegador también caducó; vuelve a
  iniciar sesión en MarketSnack y reintenta.

Nada sale de tu equipo: la cookie va solo de tu navegador a tu propio Tito en localhost.
