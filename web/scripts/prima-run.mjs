// Disparador del paper trading de VENTA DE PRIMA dentro de Tito.
//
//   node scripts/prima-run.mjs open     → escanea el universo y abre (solo lunes)
//   node scripts/prima-run.mjs manage   → re-cotiza las abiertas y aplica las salidas
//
// Cierra el ÚLTIMO pendiente del traslado desde el bot Python: la estrategia y la
// ejecución ya vivían en Tito (`lib/primaPaper.ts` + `app/api/prima-paper`), pero
// nada las disparaba. Lo dispara una tarea programada de Windows, igual que el
// keep-alive de MarketSnack.
//
// DIFERENCIA IMPORTANTE con el keep-alive: aquel corre solo, éste NECESITA el
// servidor de Next levantado (la lógica vive en una ruta de la app). De eso se
// encarga el wrapper `prima-run.cmd`, que arranca Tito si no responde. Aquí, si
// aun así no contesta, se registra ERROR y se sale con código != 0 para que la
// tarea programada lo marque como fallo — el modo de fallo que hay que evitar es
// justo el silencioso: el 2026-08-17 la ventana semanal de apertura se perdió
// entera sin que nadie se enterara hasta la noche.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, ".."); // scripts/ → web/
const DATA = path.join(WEB, "data");
const LOG_FILE = path.join(DATA, "prima-run.log");
const LOG_MAX_LINES = 500;

const API = "http://127.0.0.1:3000/api/prima-paper";
/** El escaneo de apertura recorre 103 símbolos × cadena: puede tardar minutos. */
const TIMEOUT_MS = 10 * 60 * 1000;

function stamp() {
  return new Date().toISOString();
}

/** Bitácora corta con rotación, misma convención que `data/keepalive.log`. */
function log(line) {
  mkdirSync(DATA, { recursive: true });
  let lines = [];
  try {
    lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
  } catch {
    /* primera vez */
  }
  lines.push(`${stamp()}  ${line}`);
  if (lines.length > LOG_MAX_LINES) lines = lines.slice(lines.length - LOG_MAX_LINES);
  writeFileSync(LOG_FILE, lines.join("\n") + "\n", "utf8");
}

/**
 * Resume la respuesta en UNA línea legible y decide si fue un fallo.
 *
 * OJO — la ruta devuelve `ok:true` aunque NINGÚN símbolo se haya podido escanear
 * (p. ej. cookie de MarketSnack caducada: los 103 fallan uno a uno y el resultado
 * queda en "0 candidatos"). Eso se lee IGUAL que un lunes sin oportunidades, que
 * es la confusión que costó la ventana del 2026-08-17. Así que aquí se separan
 * los dos casos y el de datos sale con código != 0 para que la tarea lo marque
 * como fallo en vez de quedar en verde.
 */
function describe(mode, d) {
  // Pasada de observación: su trabajo es AVISAR PRONTO. Un escaneo que no llega a
  // ningún símbolo con la ventana abierta es el fallo que hay que cazar aquí,
  // porque a las 11:45 ya no daría tiempo a renovar la cookie.
  if (mode === "scan") {
    const escaneados = d.scanned ?? 0;
    if (escaneados === 0) {
      return {
        exit: 1,
        line: `FAIL    scan — 0 símbolos escaneados de ${(d.failed ?? 0) + escaneados}: revisa la cookie de MarketSnack / Tastytrade`,
      };
    }
    const top = (d.top ?? []).slice(0, 3).map((t) => `${t.key}×${t.seen}`).join(", ");
    return {
      exit: 0,
      line: `OK      scan pasada ${d.pass} — escaneados ${escaneados}, ${d.candidates ?? 0} candidatos` +
        (top ? ` · más persistentes: ${top}` : ""),
    };
  }
  if (mode === "open") {
    const abiertas = d.opened ?? [];
    const fallos = d.failures ?? [];
    const escaneados = d.scanned ?? 0;

    if (escaneados === 0 && fallos.length > 0) {
      return {
        exit: 1,
        line: `FAIL    open — 0 símbolos escaneados: TODOS fallaron. Motivo: ${fallos[0]}`,
      };
    }
    // La compuerta de persistencia (≥3 pasadas) va en el resumen SIEMPRE que
    // actuó: sin esto, "22 candidatos y 0 abiertas" se leería como un fallo del
    // criterio, cuando en realidad puede ser que ninguno aguantara la ventana.
    const persist = d.requiredSeen > 0
      ? ` · persistencia ≥${d.requiredSeen}/${d.watchPasses}: ${d.persistent} pasan, ${d.droppedByPersistence} fuera`
      : "";

    // Sin ventana de observación NO se abre (decisión del dueño). Se saca como
    // línea propia y no como un SKIP más: la causa no es el mercado, es que la
    // tarea de las 10:30 no corrió, y eso hay que arreglarlo antes del martes.
    if (d.watchPasses === 0 && d.blocked && d.blocked.includes("ventana de observación")) {
      return {
        exit: 1,
        line: "FAIL    open — SIN VENTANA DE OBSERVACIÓN: la tarea Prima-Scan (10:30-11:30) no corrió, así que no se abre nada. Revisa esa tarea.",
      };
    }
    const sinVentana = "";

    if (d.blocked) {
      return {
        exit: 0,
        line: `SKIP    open bloqueado: ${d.blocked} (escaneados ${escaneados}, candidatos ${d.candidates ?? 0})${persist}${sinVentana}`,
      };
    }
    const detalle = abiertas.length
      ? abiertas
          .map((o) => {
            const riesgo = o.riskPct != null ? ` @${(o.riskPct * 100).toFixed(1)}%` : "";
            return `${o.ticker} ${o.type} ${o.short}/${o.long} ×${o.contracts}${riesgo} $${o.credit} (visto ${o.seenInPasses ?? 0}×)`;
          })
          .join(" · ")
      : "ninguna";
    // Lo que pasó todos los filtros y aun así no cabe en el capital. Va al log
    // SIEMPRE: un candidato descartado por tamaño y en silencio se lee como si el
    // motor hubiera preferido otro, y así la cuenta parecía elegir solo índices.
    const apretados = d.noCaben ?? [];
    const noCaben = apretados.length
      ? ` · no caben (${apretados.length}): ` +
        apretados.map((n) => `${n.ticker} arriesga $${n.riesgo}, harían falta ~$${n.necesita}`).join(", ")
      : "";
    const cola = fallos.length ? ` · fallos: ${fallos.length}` : "";
    return {
      exit: 0,
      line: `OK      open — escaneados ${escaneados}, candidatos ${d.candidates ?? 0}${persist}, abiertas ${abiertas.length}: ${detalle}${noCaben}${cola}${sinVentana}`,
    };
  }

  const cerradas = d.closed ?? [];
  const revisadas = d.managed ?? 0;
  const notas = d.notes ?? [];
  // Misma trampa del lado de la gestión: si NINGUNA abierta se pudo re-cotizar,
  // las reglas de salida no se aplicaron a nada. Silencio = posiciones a la deriva.
  const sinCotizar = notas.filter(
    (n) => n.includes("no se pudo re-cotizar") || n.includes("fallo al pedir la cadena"),
  ).length;
  if (revisadas > 0 && sinCotizar >= revisadas) {
    return {
      exit: 1,
      line: `FAIL    manage — ninguna de las ${revisadas} abiertas se pudo re-cotizar: ${notas[0]}`,
    };
  }

  const detalle = cerradas.length
    ? cerradas.map((c) => `${c.ticker} $${c.pnl} (${c.reason})`).join(" · ")
    : "ninguna";
  const avisos = notas.length ? ` · notas: ${notas.join(" | ")}` : "";
  return {
    exit: 0,
    line: `OK      manage — revisadas ${revisadas}, cerradas ${cerradas.length}: ${detalle}${avisos}`,
  };
}

async function main() {
  const mode = (process.argv[2] || "").trim().toLowerCase();
  if (mode !== "open" && mode !== "manage" && mode !== "scan") {
    log(`ERROR   modo inválido "${process.argv[2] ?? ""}" — usa 'scan', 'open' o 'manage'`);
    console.error("Uso: node scripts/prima-run.mjs scan|open|manage");
    process.exit(2);
  }

  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: mode }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Sin servidor no hay estrategia que valga: se grita, no se calla.
    log(`ERROR   ${mode} — no se pudo hablar con Tito en ${API} (${e?.message ?? "fetch falló"}). ¿Está el servidor levantado?`);
    console.error("prima-run: Tito no responde");
    process.exit(1);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    log(`ERROR   ${mode} — respuesta no-JSON (HTTP ${res.status})`);
    process.exit(1);
  }

  if (!res.ok || data?.ok === false) {
    // Caso típico: cookie de MarketSnack caducada, o sin calendario macro.
    log(`FAIL    ${mode} — HTTP ${res.status}: ${data?.error ?? "sin detalle"}`);
    console.error(`prima-run: ${data?.error ?? res.status}`);
    process.exit(1);
  }

  const { line, exit } = describe(mode, data);
  log(line);
  if (exit === 0) console.log(line);
  else console.error(line);
  process.exit(exit);
}

main().catch((e) => {
  try {
    log(`ERROR   excepción no controlada: ${e?.message ?? e}`);
  } catch {}
  console.error(e);
  process.exit(1);
});
