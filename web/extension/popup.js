// Popup de la extensión: lee la cookie de MarketSnack que el NAVEGADOR ya tiene
// descifrada (chrome.cookies API — funciona con App-Bound Encryption, porque corre
// dentro del navegador) y la POSTea al endpoint de la Fase 1, que la valida contra
// MarketSnack y la guarda. Un clic, sin DevTools, sin descifrar nada a mano.

const AGENT_URL = "http://localhost:3000/api/marketsnack/cookie";
const SESSION_KEY = "_market_snack_session";

const statusEl = document.getElementById("status");
const goBtn = document.getElementById("go");

function setStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color || "#444";
}

async function run() {
  goBtn.disabled = true;
  try {
    setStatus("Leyendo la cookie del navegador…", "#666");

    let cookies;
    try {
      // Devuelve cookies de marketsnack.com y sus subdominios (app., .marketsnack.com).
      cookies = await chrome.cookies.getAll({ domain: "marketsnack.com" });
    } catch (e) {
      setStatus("No pude leer las cookies del navegador: " + e.message, "#dc2626");
      return;
    }

    if (!cookies || cookies.length === 0) {
      setStatus(
        "No hay cookies de marketsnack.com en este navegador. Inicia sesión en app.marketsnack.com y vuelve a intentar.",
        "#dc2626",
      );
      return;
    }

    // Si un mismo nombre aparece para varios hosts, prioriza el de app.marketsnack.com.
    const byName = new Map();
    for (const c of cookies) {
      const isApp = (c.domain || "").includes("app.marketsnack.com");
      if (!byName.has(c.name) || isApp) byName.set(c.name, c.value);
    }

    if (!byName.has(SESSION_KEY)) {
      setStatus(
        "Encontré cookies de marketsnack pero no " +
          SESSION_KEY +
          ". ¿Seguro que iniciaste sesión?",
        "#dc2626",
      );
      return;
    }

    const header = [...byName.entries()].map(([n, v]) => `${n}=${v}`).join("; ");

    setStatus("Enviando al agente y validando contra MarketSnack…", "#666");

    let res, data;
    try {
      res = await fetch(AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: header }),
      });
      data = await res.json();
    } catch {
      setStatus(
        "No pude contactar a Tito en localhost:3000. ¿Está corriendo el agente? Ábrelo con “Iniciar Tito” y reintenta.",
        "#dc2626",
      );
      return;
    }

    if (data && data.ok) {
      setStatus(
        "✅ Cookie válida, enviada y guardada. Ya está activa en Tito — sin reiniciar.",
        "#16a34a",
      );
    } else {
      setStatus("❌ " + ((data && data.error) || "El agente rechazó la cookie."), "#dc2626");
    }
  } finally {
    goBtn.disabled = false;
  }
}

goBtn.addEventListener("click", run);
