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
    if (d.blocked) {
      return {
        exit: 0,
        line: `SKIP    open bloqueado: ${d.blocked} (escaneados ${escaneados}, candidatos ${d.candidates ?? 0})`,
      };
    }
    const detalle = abiertas.length
      ? abiertas.map((o) => `${o.ticker} ${o.type} ${o.short}/${o.long} ×${o.contracts} $${o.credit}`).join(" · ")
      : "ninguna";
    const cola = fallos.length ? ` · fallos: ${fallos.length}` : "";
    return {
      exit: 0,
      line: `OK      open — escaneados ${escaneados}, candidatos ${d.candidates ?? 0}, abiertas ${abiertas.length}: ${detalle}${cola}`,
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
  if (mode !== "open" && mode !== "manage") {
    log(`ERROR   modo inválido "${process.argv[2] ?? ""}" — usa 'open' o 'manage'`);
    console.error("Uso: node scripts/prima-run.mjs open|manage");
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
