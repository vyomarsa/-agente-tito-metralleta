// ============================================================================
// Texto de las alertas de Telegram. TODO PURO (tests en alertText.test.ts).
//
// Separado del envío a propósito: el formato es lo único que se puede equivocar
// de forma silenciosa —un número mal puesto en el móvil se lee como una posición
// que no es— y así se puede probar sin tocar la red.
//
// Reglas de estilo, pensadas para leerse en la pantalla de un teléfono:
//   · Lo primero es QUÉ pasó, no de qué agente viene.
//   · Los números que importan van en negrita; el resto es contexto.
//   · Nada de jerga que no aporte: el mensaje se lee en 3 segundos o no sirve.
//   · Siempre queda claro que es SIMULACIÓN, para no confundirlo con real.
// ============================================================================

import type { PrimaPosition } from "./primaPaper";
import type { ZeroPaperPosition } from "./zerodtePaper";

/** Escapa lo que HTML de Telegram interpretaría. Los tickers son seguros, pero
 *  los motivos de cierre y las notas vienen de texto libre. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function signedMoney(n: number): string {
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Venta de prima
// ---------------------------------------------------------------------------

/**
 * Aperturas de venta de prima. Va UN mensaje con todas las de la tanda, no uno
 * por posición: el ejecutor abre hasta 5 de golpe y cinco pitidos seguidos se
 * leen como spam, no como información.
 */
export function primaOpenedText(posiciones: PrimaPosition[], equity: number): string {
  if (posiciones.length === 0) return "";
  const cabecera = `✂️ <b>Venta de prima</b> — ${posiciones.length} posición${posiciones.length === 1 ? "" : "es"} abierta${posiciones.length === 1 ? "" : "s"}`;
  const lineas = posiciones.map((p) => {
    const tipo = p.type === "put_credit" ? "PUT" : "CALL";
    const visto = p.seenInPasses != null ? ` · visto ${p.seenInPasses}×` : "";
    const riesgoPct = p.riskPctUsed != null ? ` (${(p.riskPctUsed * 100).toFixed(1)}% del capital)` : "";
    return `• <b>${esc(p.ticker)}</b> ${tipo} ${p.shortStrike}/${p.longStrike} ×${p.contracts}\n` +
      `   crédito <b>${money(p.entryCredit * 100 * p.contracts)}</b> · riesgo ${money((p.width - p.entryCredit) * 100 * p.contracts)}${riesgoPct} · POP ${Math.round(p.popPct)}%${visto}\n` +
      `   vence ${esc(p.expiration)}`;
  });
  return `${cabecera}\n\n${lineas.join("\n\n")}\n\nCapital simulado: <b>${money(equity)}</b>\n<i>Paper — ningún dólar real se mueve.</i>`;
}

/** Cierre de venta de prima. Uno por posición: son eventos sueltos en el tiempo. */
export function primaClosedText(p: PrimaPosition, equity: number): string {
  const pnl = p.realizedPnl ?? 0;
  const icono = pnl > 0 ? "✅" : pnl < 0 ? "🔴" : "⚪";
  const tipo = p.type === "put_credit" ? "PUT" : "CALL";
  return `${icono} <b>Venta de prima</b> — cerrada ${esc(p.ticker)} ${tipo} ${p.shortStrike}/${p.longStrike}\n\n` +
    `Resultado: <b>${signedMoney(pnl)}</b>\n` +
    `Motivo: ${esc(p.closeReason ?? "—")}\n\n` +
    `Capital simulado: <b>${money(equity)}</b>`;
}


/** Lo que hace falta para explicar por qué NO se abrió. */
export interface PrimaNoOpenInfo {
  /** Motivo principal, ya en cristiano. */
  motivo: string;
  /** true si esto exige que alguien haga algo (tarea caída, cookie muerta). */
  accionable?: boolean;
  escaneados?: number;
  candidatos?: number;
  persistentes?: number;
  /** Pasadas de observación exigidas y habidas. */
  requeridas?: number;
  pasadas?: number;
  /** Candidatos que pasaron todo pero no caben en el capital. */
  noCaben?: { ticker: string; riesgo: number; necesita: number }[];
  /** Subyacentes con posición viva (sus candidatos se descartan por eso). */
  yaAbiertas?: string[];
  equity?: number;
}

/**
 * "Hoy NO se abrió nada, y este es el motivo."
 *
 * Existe porque el silencio era ambiguo: la alerta solo salía cuando había
 * posiciones nuevas, así que un lunes sin aperturas se leía igual que un lunes en
 * que la tarea no llegó a correr, la cookie estaba muerta o la ventana de
 * observación de las 10:30 no se ejecutó. Ese modo de fallo mudo ya costó una
 * ventana semanal entera el 2026-08-17.
 *
 * Sale como mucho dos veces por semana (lunes y martes a las 11:45), así que no es
 * ruido: es el otro 50% del resultado de la única decisión semanal del agente.
 */
export function primaNotOpenedText(info: PrimaNoOpenInfo): string {
  const icono = info.accionable ? "⚠️" : "✂️";
  const cabecera = `${icono} <b>Venta de prima</b> — hoy NO se abrió ninguna posición`;

  const partes: string[] = [cabecera, "", esc(info.motivo)];

  // Los números del embudo, solo si el escaneo llegó a correr: con la tarea
  // bloqueada antes de escanear serían ceros que parecen un fallo de criterio.
  if (info.escaneados != null && info.escaneados > 0) {
    const persist =
      info.persistentes != null && info.requeridas != null && info.pasadas != null
        ? ` · persistentes ${info.persistentes} (hacen falta ${info.requeridas} de ${info.pasadas} pasadas)`
        : "";
    partes.push("", `Escaneados ${info.escaneados} · candidatos ${info.candidatos ?? 0}${persist}`);
  }

  if (info.noCaben?.length) {
    const lista = info.noCaben
      .slice(0, 4)
      .map((n) => `${esc(n.ticker)} arriesga ${money(n.riesgo)} (harían falta ~${money(n.necesita)})`)
      .join(" · ");
    const resto = info.noCaben.length > 4 ? ` y ${info.noCaben.length - 4} más` : "";
    partes.push(`No caben en el capital: ${lista}${resto}`);
  }

  if (info.yaAbiertas?.length) {
    partes.push(`Ya con posición abierta: ${info.yaAbiertas.map(esc).join(", ")}`);
  }

  if (info.equity != null) partes.push("", `Capital simulado: <b>${money(info.equity)}</b>`);
  partes.push("<i>Paper — ningún dólar real se mueve.</i>");

  return partes.join("\n");
}

// ---------------------------------------------------------------------------
// 0DTE
// ---------------------------------------------------------------------------

const MODELO: Record<string, string> = {
  magnet: "vuelta al imán (γ+)",
  momentum: "momentum (γ−)",
};

export function zeroOpenedText(p: ZeroPaperPosition, equity: number): string {
  const dir = p.side === "LONG" ? "▲ LONG" : "▼ SHORT";
  return `🎯 <b>0DTE</b> — posición abierta\n\n` +
    `${dir} <b>${esc(p.ticker)} ${p.type === "call" ? "CALL" : "PUT"} ${p.strike}</b> ×${p.contracts}\n` +
    `Prima <b>${money(p.entryPrice * 100 * p.contracts)}</b> (riesgo máximo)\n` +
    `Objetivo ${p.target.toFixed(2)} · stop ${p.stop.toFixed(2)} · spot ${p.entrySpot.toFixed(2)}\n` +
    `Modelo: ${MODELO[p.model] ?? p.model}\n\n` +
    `Capital simulado: <b>${money(equity)}</b>\n<i>Paper — ningún dólar real se mueve.</i>`;
}

export function zeroClosedText(p: ZeroPaperPosition, equity: number): string {
  const pnl = p.realizedPnl ?? 0;
  // "expirada" no dice que el modelo acertara o fallara: dice que se acabó el día.
  const icono = p.status === "expirada" ? "⏳" : pnl > 0 ? "✅" : "🔴";
  const motivo = p.closeReason === "objetivo" ? "llegó al objetivo"
    : p.closeReason === "stop" ? "saltó el stop"
    : "cierre de sesión";
  return `${icono} <b>0DTE</b> — cerrada ${esc(p.ticker)} ${p.type === "call" ? "CALL" : "PUT"} ${p.strike}\n\n` +
    `Resultado: <b>${signedMoney(pnl)}</b> (${money(p.entryPrice * 100 * p.contracts)} → ${money(p.currentPrice * 100 * p.contracts)})\n` +
    `Motivo: ${motivo}\n\n` +
    `Capital simulado: <b>${money(equity)}</b>`;
}

// ---------------------------------------------------------------------------
// Fallos
// ---------------------------------------------------------------------------

/**
 * Aviso de que un agente NO pudo hacer su trabajo.
 *
 * Es la alerta más importante de todas y por eso existe: el dueño montó los
 * simuladores para que corrieran solos, y un agente que falla en silencio es
 * indistinguible de uno que no encontró oportunidades. Ese es exactamente el
 * modo de fallo que ya costó una ventana de apertura semanal.
 */
export function failureText(agente: string, motivo: string): string {
  return `⚠️ <b>${esc(agente)}</b> no pudo operar\n\n${esc(motivo)}`;
}
