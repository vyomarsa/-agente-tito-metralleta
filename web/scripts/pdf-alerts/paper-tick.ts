// Tick de la cuenta PAPER del Agente Prueba de Fuego (lib/pdf/agentPaper.ts).
// Lo llama run.cmd "spx" cada minuto (la misma tarea de las alertas SPX), así la
// cuenta avanza aunque nadie tenga la página abierta. Fuera de sesión (9:30-16:00
// ET, lunes a viernes) sale sin tocar la red.
//
//   tsx scripts/pdf-alerts/paper-tick.ts           → tick normal
//   tsx scripts/pdf-alerts/paper-tick.ts --forzar  → corre aunque esté fuera de sesión
//                                                   (solo gestiona: planOpen no abre fuera de sesión)

import { readFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";

const WEB_DIR = process.cwd();
for (const rawLine of readFileSync(join(WEB_DIR, ".env.local"), "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx === -1) continue;
  let val = line.slice(idx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  process.env[line.slice(0, idx).trim()] = val;
}

const LOG_DIR = join(WEB_DIR, "data", "pdf", "agente-paper");
const LOG_FILE = join(LOG_DIR, "tick.log");
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

function log(line: string) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(stamped);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, stamped, "utf8");
  } catch {
    // no crítico
  }
}

function etNow(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), weekday: parts.weekday };
}

async function main() {
  const now = new Date();
  const et = etNow(now);
  const sessionOpen = et.weekday !== "Sat" && et.weekday !== "Sun" && et.minutes >= OPEN_MIN && et.minutes < CLOSE_MIN;
  if (!sessionOpen && !process.argv.includes("--forzar")) return; // "no tocaba" no es un fallo: sin log

  const { AGENT_PAPER_TICKER, tickAgentPaper } = await import("../../lib/pdf/agentPaper");
  const { fetchZeroDte } = await import("../../lib/pdf/odteStandalone/zerodte");

  const result = await fetchZeroDte(AGENT_PAPER_TICKER, now);
  const r = await tickAgentPaper({
    result,
    minutesLeft: sessionOpen ? CLOSE_MIN - et.minutes : 0,
    sessionOpen,
    now,
  });
  const s = r.summary;
  log(
    `${AGENT_PAPER_TICKER} spot=${result.spot ?? "-"} ticket=${result.ticket ? `${result.ticket.type}:${result.ticket.strike}` : "null"} ` +
      `abiertas=${r.open.length} cerradas_ahora=${r.justClosed.length} equity=${s.equity.toFixed(2)}` +
      (r.blocked ? ` · no abre: ${r.blocked}` : "") +
      (r.notes.length ? ` · ${r.notes.join(" | ")}` : ""),
  );
}

main().catch((err) => log(`ERROR — ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
