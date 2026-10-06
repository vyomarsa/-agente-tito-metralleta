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

import { marketDateStr, parseOcc } from "./occ";
import { feesOf as primaFeesOf, type PrimaPosition } from "./primaPaper";
import type { ZeroDteTicket } from "./zerodteSignals";
import { TRAIL_DEVOLUCION_PCT, feesOf as zeroFeesOf, type ZeroPaperPosition } from "./zerodtePaper";

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
/**
 * Punto muerto del spread. Se DERIVA en vez de guardarse: en un credit spread es
 * el strike corto desplazado por el crédito, y calcularlo aquí evita que el
 * número del móvil y el de la ficha puedan divergir. PURA.
 */
export function breakevenOf(p: Pick<PrimaPosition, "type" | "shortStrike" | "entryCredit">): number {
  return p.type === "put_credit"
    ? p.shortStrike - p.entryCredit
    : p.shortStrike + p.entryCredit;
}

/**
 * Aperturas de venta de prima, como ÓRDENES listas para teclear en thinkorswim.
 *
 * Va UN solo mensaje con toda la tanda, igual que antes: el ejecutor abre hasta 5
 * de golpe y cinco pitidos seguidos se leen como spam. Lo que cambia es que cada
 * bloque es ahora una orden completa (las dos patas con su símbolo, el crédito
 * neto al que poner el límite, el riesgo y el punto muerto) en vez de un resumen.
 * El troceo de `splitForTelegram` cubre el caso de que cinco órdenes se pasen del
 * tope de Telegram.
 *
 * Todo sale de la propia posición: en un spread el crédito neto ES el límite y el
 * punto muerto se deriva, así que no hace falta arrastrar el candidato hasta aquí
 * — al contrario que en el 0DTE, donde delta y horquilla solo viven en el ticket.
 */
export function primaOpenedText(posiciones: PrimaPosition[], equity: number): string {
  if (posiciones.length === 0) return "";

  const cabecera =
    // "órdenes" lleva tilde: el plural de "orden" desplaza el acento, así que no
    // se puede componer pegando "es" al singular.
    `🚨 <b>COPIAR EN TOS</b> — Venta de prima · ${posiciones.length} ${posiciones.length === 1 ? "orden" : "órdenes"}`;

  const bloques = posiciones.map((p, i) => {
    const esPut = p.type === "put_credit";
    const cp = esPut ? "put" : "call";
    const corto = tosSymbolFrom(p.ticker, p.expiration, cp, p.shortStrike);
    const largo = tosSymbolFrom(p.ticker, p.expiration, cp, p.longStrike);
    const riesgoPct = p.riskPctUsed != null ? ` (${(p.riskPctUsed * 100).toFixed(1)}% del capital)` : "";
    const visto = p.seenInPasses != null ? ` · visto ${p.seenInPasses}×` : "";

    const lineas = [
      `<b>${i + 1}) ${esc(p.ticker)}</b> <code>${esc(p.id)}</code>`,
      `VENDER PARA ABRIR · VERTICAL ${esPut ? "PUT" : "CALL"} · <b>${p.contracts}</b> contrato${p.contracts === 1 ? "" : "s"}`,
    ];
    // Las dos patas con su símbolo: en TOS la vertical se manda como UNA orden,
    // pero hay que reconocer cuál se vende y cuál se compra antes de enviarla.
    if (corto && largo) {
      lineas.push(`   VENDE  <code>${esc(corto)}</code>`);
      lineas.push(`   COMPRA <code>${esc(largo)}</code>`);
    } else {
      lineas.push(`   VENDE ${p.shortStrike} / COMPRA ${p.longStrike} · vence ${esc(p.expiration)}`);
    }
    lineas.push(
      `LÍMITE crédito NETO <b>${p.entryCredit.toFixed(2)}</b> · ancho ${p.width.toFixed(2)}`,
      `Cobras ≈ <b>${money(p.entryCredit * 100 * p.contracts)}</b> · riesgo máx ${money((p.width - p.entryCredit) * 100 * p.contracts)}${riesgoPct}`,
      `Punto muerto ${breakevenOf(p).toFixed(2)} · Δ corto ${p.shortDelta.toFixed(2)} · POP ${Math.round(p.popPct)}%${visto}`,
      `Vence ${esc(p.expiration)}`,
    );
    return lineas.join("\n");
  });

  // Las reglas del SIMULADOR, no las del documento de estrategia: el dueño está
  // replicando esta cuenta, y si gestionara al 50% mientras el simulador aguanta
  // a vencimiento, la comparación mediría dos estrategias distintas.
  const gestion = [
    "<b>GESTIÓN — igual que el simulador</b>",
    "• Se aguanta a VENCIMIENTO. NO se cierra al 50%.",
    "• Válvula: cerrar si la pérdida llega al 30% del crédito, de miércoles en adelante.",
    "• El día del vencimiento: recoger si tocó el 50% y retrocede ≥5 puntos.",
    "• Aviso de gamma (NO cierra): DTE ≤ 2 y Δ corto ≥ 0.40.",
  ].join("\n");

  return [
    cabecera,
    "",
    bloques.join("\n\n"),
    "",
    gestion,
    "",
    "⚠️ El límite es el MID. En TOS el precio «natural» sale peor: trabaja el crédito, no lo mandes al mercado.",
    `Capital simulado <b>${money(equity)}</b>`,
    "<i>Paper — ningún dólar real se mueve.</i>",
  ].join("\n");
}

/**
 * ¿Se cerró porque VENCIÓ? PURA.
 *
 * Se decide por CALENDARIO, no leyendo el motivo: `closeReason` es texto libre y
 * atar el comportamiento a que empiece por "Venció" es exactamente el tipo de
 * acoplamiento que se rompe la primera vez que alguien reescribe una frase. El
 * suelo de ganancia también dispara el día del vencimiento (`dte <= 0`), así que
 * lo que distingue el vencimiento de verdad es que el cierre cae DESPUÉS del día
 * de vencimiento, en la fecha de mercado de Nueva York.
 */
export function primaExpirada(p: Pick<PrimaPosition, "expiration" | "closedAt">): boolean {
  if (!p.closedAt) return false;
  const cerrado = new Date(p.closedAt);
  if (Number.isNaN(cerrado.getTime())) return false;
  return marketDateStr(cerrado) > p.expiration;
}

/**
 * Cierre de venta de prima. Uno por posición: son eventos sueltos en el tiempo.
 *
 * Dos formas, por el mismo motivo que en el 0DTE:
 *  · La válvula del 30% y el suelo del viernes cierran con el mercado ABIERTO, así
 *    que hay orden que teclear — y en un credit spread cerrar es **comprar la
 *    vertical de vuelta** con un límite de DÉBITO neto. Cada pata va rotulada con
 *    lo que se hace ahora y lo que se hizo al abrir: confundirlas manda la orden
 *    del revés y duplica la posición en vez de cerrarla.
 *  · Si VENCIÓ no hay nada que teclear, y fingir una orden mandaría al dueño a un
 *    mercado que ya liquidó el contrato.
 */
export function primaClosedText(p: PrimaPosition, equity: number): string {
  // El resultado que se publica es el NETO: es el que queda en una cuenta real.
  const bruto = p.realizedPnl ?? 0;
  const fees = primaFeesOf(p);
  const pnl = bruto - fees;
  const icono = pnl > 0 ? "✅" : pnl < 0 ? "🔴" : "⚪";
  const esPut = p.type === "put_credit";
  const tipo = esPut ? "PUT" : "CALL";
  const contrato = `${esc(p.ticker)} ${tipo} ${p.shortStrike}/${p.longStrike}`;
  const cobrado = p.entryCredit * 100 * p.contracts;

  // El % es del CRÉDITO, no del riesgo: es la unidad en la que están escritas las
  // reglas de gestión (válvula al 30%, suelo al 50%), así que el cierre se lee
  // contra la misma vara con la que se decidió.
  const pct =
    p.entryCredit > 0
      ? ` (${pnl >= 0 ? "capturado" : "perdido"} ${Math.abs(Math.round(((p.entryCredit - p.currentValue) / p.entryCredit) * 100))}% del crédito)`
      : "";
  const balance =
    `Cobraste ${money(cobrado)} al abrir · resultado neto <b>${signedMoney(pnl)}</b>${pct}` +
    `\n<i>bruto ${signedMoney(bruto)} − ${money(fees)} de comisiones</i>`;

  if (primaExpirada(p)) {
    return [
      `${icono} <b>Venta de prima</b> — cerrada ${contrato} <code>${esc(p.id)}</code>`,
      "",
      `Venció el ${esc(p.expiration)}: el simulador liquidó al valor final ${p.currentValue.toFixed(2)}.`,
      balance,
      "",
      `⚠️ En TOS no hay nada que teclear: el spread ya venció. Si el subyacente cerró fuera del strike corto (${p.shortStrike}) expira sin valor y te quedas el crédito; si cerró dentro, tu bróker liquida o asigna.`,
      `Capital simulado <b>${money(equity)}</b>`,
    ].join("\n");
  }

  const cp = esPut ? "put" : "call";
  const corto = tosSymbolFrom(p.ticker, p.expiration, cp, p.shortStrike);
  const largo = tosSymbolFrom(p.ticker, p.expiration, cp, p.longStrike);
  const partes = [
    `🚨 <b>CERRAR EN TOS</b> — Venta de prima ${icono} <code>${esc(p.id)}</code>`,
    "",
    "<b>ORDEN</b>",
    `COMPRAR PARA CERRAR · VERTICAL ${tipo} · <b>${p.contracts}</b> contrato${p.contracts === 1 ? "" : "s"}`,
  ];
  if (corto && largo) {
    partes.push(`   COMPRA <code>${esc(corto)}</code>  (la que vendiste)`);
    partes.push(`   VENDE  <code>${esc(largo)}</code>  (la que compraste)`);
  } else {
    partes.push(`   COMPRA ${p.shortStrike} / VENDE ${p.longStrike} · vence ${esc(p.expiration)}`);
  }
  partes.push(
    `LÍMITE débito NETO <b>${p.currentValue.toFixed(2)}</b> · pagas ≈ <b>${money(p.currentValue * 100 * p.contracts)}</b>`,
    "",
    balance,
    `Motivo: ${esc(p.closeReason ?? "—")}`,
    "",
    "⚠️ El límite es el MID. En TOS el precio «natural» sale peor: trabaja el débito, no lo mandes al mercado.",
    `Capital simulado <b>${money(equity)}</b>`,
    "<i>Paper — ningún dólar real se mueve.</i>",
  );
  return partes.join("\n");
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

/**
 * Símbolo de la opción como lo escribe thinkorswim: `.SPY260827C770`
 * (punto + raíz + YYMMDD + C/P + strike sin ceros de relleno). PURA.
 *
 * La raíz sale del propio símbolo OCC, NO del ticker del subyacente: el 0DTE de
 * SPX cotiza como SPXW (`SPXW260827C07655000`), y teclear "SPX" en TOS llevaría
 * al mensual, que es otro contrato con otra hora de liquidación. Devuelve null
 * si el símbolo no es un OCC válido.
 */
export function tosSymbol(optionSymbol: string): string | null {
  const occ = parseOcc(optionSymbol);
  if (!occ) return null;
  return tosSymbolFrom(occ.underlying, occ.expiration, occ.type, occ.strike);
}

/**
 * Igual que `tosSymbol` pero desde las partes sueltas, para quien no guarda el
 * símbolo OCC (la venta de prima almacena ticker/vencimiento/strike, no el OCC).
 *
 * `root` es la raíz de la OPCIÓN. Para acciones y ETFs coincide con el ticker;
 * los índices no (SPX → SPXW en el 0DTE). En el universo de venta de prima el
 * único que conviene mirar dos veces es BRKB, que cada fuente escribe distinto
 * (`BRKB` / `BRK.B` / `BRK/B`, ver spreadUniverse.ts). PURA.
 */
export function tosSymbolFrom(
  root: string,
  expiration: string,
  type: "call" | "put",
  strike: number,
): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiration);
  if (!root || !m || !(strike > 0)) return null;
  const cp = type === "call" ? "C" : "P";
  // String() ya deja 770 como "770" y 298.5 como "298.5", que es lo que TOS espera.
  return `.${root}${m[1].slice(2)}${m[2]}${m[3]}${cp}${strike}`;
}

/** Tope de un mensaje de Telegram. El troceo deja margen para no rozarlo. */
export const TELEGRAM_LIMIT = 4096;
const CHUNK = 3900;

/**
 * Trocea un mensaje largo por SALTOS DE LÍNEA. PURA.
 *
 * Hace falta porque Telegram RECHAZA por encima de 4096 caracteres y `sendAlert`
 * es best-effort: un aviso demasiado largo no fallaba ruidosamente, desaparecía.
 * Con la venta de prima abriendo hasta 5 órdenes completas en una tanda eso deja
 * de ser hipotético — y un aviso que no llega es justo el fallo mudo que este
 * proyecto lleva meses cerrando.
 *
 * Se corta SOLO entre líneas enteras: las etiquetas HTML de estos mensajes nunca
 * cruzan un salto, así que ningún trozo puede partir un `<b>` por la mitad. Una
 * línea suelta más larga que el tope se parte a lo bruto: mutilarla es mejor que
 * perder el mensaje entero.
 */
export function splitForTelegram(text: string, limit: number = CHUNK): string[] {
  if (text.length <= limit) return [text];
  const trozos: string[] = [];
  let buf = "";
  const empujar = () => { if (buf.length > 0) { trozos.push(buf); buf = ""; } };

  for (const linea of text.split("\n")) {
    if (linea.length > limit) {
      empujar();
      for (let i = 0; i < linea.length; i += limit) trozos.push(linea.slice(i, i + limit));
      continue;
    }
    if (buf.length + linea.length + 1 > limit) empujar();
    buf = buf.length > 0 ? `${buf}\n${linea}` : linea;
  }
  empujar();
  return trozos;
}

/**
 * Apertura de 0DTE. Es la alerta ACCIONABLE: el dueño la replica a mano en el
 * paper de thinkorswim para comparar su ejecución con la del simulador, así que
 * lleva 🚨 y "COPIAR EN TOS" delante para distinguirla de un vistazo del resto
 * (✂️ venta de prima, ✅/🔴 cierres, ⚠️ fallos) y trae TODO lo necesario para
 * teclear la orden sin abrir la web.
 *
 * `ticket` es el contrato tal y como lo vio el agente al abrir. Es opcional a
 * propósito: sin él el mensaje sigue sirviendo —pierde horquilla, delta y
 * proyecciones, pero conserva la orden—, y un aviso incompleto es mucho mejor
 * que ninguno.
 */
export function zeroOpenedText(
  p: ZeroPaperPosition,
  equity: number,
  ticket?: ZeroDteTicket | null,
): string {
  const esCall = p.type === "call";
  const tos = tosSymbol(p.optionSymbol);
  const debito = p.entryPrice * 100 * p.contracts;

  const partes: string[] = [
    `🚨 <b>COPIAR EN TOS</b> — 0DTE <code>${esc(p.id)}</code>`,
    "",
    "<b>ORDEN</b>",
    `COMPRAR PARA ABRIR · <b>${p.contracts}</b> contrato${p.contracts === 1 ? "" : "s"}`,
  ];
  if (tos) partes.push(`<code>${esc(tos)}</code>`);
  partes.push(
    `${esc(p.ticker)} · ${esCall ? "CALL" : "PUT"} <b>${p.strike}</b> · vence ${esc(p.expiration)}`,
  );

  // El límite es el MID, que es también el precio al que entró el simulador: si el
  // dueño entrara al ask y el simulador al mid, la comparación mediría la horquilla
  // en vez del modelo, que es justo lo que se quiere comparar.
  const horquilla =
    ticket?.bid != null && ticket?.ask != null
      ? `  (bid ${ticket.bid.toFixed(2)} / ask ${ticket.ask.toFixed(2)})`
      : "";
  partes.push(`LÍMITE <b>${p.entryPrice.toFixed(2)}</b>${horquilla}`);
  partes.push(`Débito total ≈ <b>${money(debito)}</b> — es el riesgo máximo`);

  if (ticket) {
    const trozos: string[] = [];
    if (ticket.delta != null) trozos.push(`delta ${ticket.delta.toFixed(2)}`);
    if (ticket.spreadPct != null) trozos.push(`horquilla ${ticket.spreadPct.toFixed(1)}%`);
    trozos.push(`liquidez ${esc(ticket.liquidity)}`);
    partes.push("", "<b>CONTRATO</b>", trozos.join(" · "));
    partes.push(
      `volumen ${ticket.volume.toLocaleString("en-US")} · OI ${ticket.openInterest.toLocaleString("en-US")}`,
    );
  }

  // LA línea que evita el error caro: en TOS la tentación es poner el stop sobre
  // el precio de la OPCIÓN, y estos niveles son del subyacente.
  partes.push(
    "",
    `<b>SALIDA — los niveles son del SUBYACENTE (${esc(p.ticker)}), no de la opción</b>`,
  );
  partes.push(
    `🎯 Objetivo ${esc(p.ticker)} <b>${p.target.toFixed(2)}</b>` +
      (ticket?.targetPrice != null
        ? ` → contrato ≈ ${ticket.targetPrice.toFixed(2)} (${signedMoney(ticket.targetGain * p.contracts)})`
        : ""),
  );
  partes.push(
    `🛑 Stop ${esc(p.ticker)} <b>${p.stop.toFixed(2)}</b>` +
      (ticket?.stopLoss != null ? ` (${signedMoney(ticket.stopLoss * p.contracts)})` : ""),
  );
  partes.push(
    `Spot a la entrada ${p.entrySpot.toFixed(2)} · modelo ${MODELO[p.model] ?? esc(p.model)}`,
  );

  partes.push(
    "",
    "⚠️ El límite es el MID de este instante. En un 0DTE el precio corre: mira la horquilla antes de enviar.",
    `Capital simulado <b>${money(equity)}</b>`,
    "<i>Paper — ningún dólar real se mueve.</i>",
  );

  return partes.join("\n");
}

/**
 * Cierre de 0DTE. Dos formas, y la diferencia NO es cosmética:
 *
 *  · Por OBJETIVO o STOP la posición se cierra en mitad de la sesión, así que hay
 *    una orden que teclear: lleva 🚨 <b>CERRAR EN TOS</b> y el "vender para
 *    cerrar" completo, igual que la apertura lleva el "comprar para abrir".
 *  · Por CIERRE DE SESIÓN no hay nada que teclear — el aviso salta en el tick de
 *    las 16:00, cuando el contrato ya venció. Fingir una orden ahí mandaría al
 *    dueño a un mercado cerrado, así que ese caso se queda informativo y dice qué
 *    le pasa a lo que él tenga abierto.
 *
 * En los dos casos repite la referencia de la apertura, que es lo que permite
 * emparejar las dos ejecuciones.
 */
export function zeroClosedText(p: ZeroPaperPosition, equity: number): string {
  // El resultado que se publica es el NETO: es el que queda en una cuenta real.
  const bruto = p.realizedPnl ?? 0;
  const fees = zeroFeesOf(p);
  const pnl = bruto - fees;
  // "expirada" no dice que el modelo acertara o fallara: dice que se acabó el día.
  const icono = p.status === "expirada" ? "⏳" : pnl > 0 ? "✅" : "🔴";
  const contrato = `${esc(p.ticker)} ${p.type === "call" ? "CALL" : "PUT"} ${p.strike}`;
  const entrada = p.entryPrice * 100 * p.contracts;
  const salida = p.currentPrice * 100 * p.contracts;
  // El % es el del CONTRATO (bruto): es la unidad en la que se piensa un 0DTE.
  const retorno =
    p.entryPrice > 0
      ? ` (${bruto >= 0 ? "+" : "−"}${Math.abs(((p.currentPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(0)}%)`
      : "";
  const balance =
    `Entraste por ${money(entrada)} · resultado neto <b>${signedMoney(pnl)}</b>${retorno}` +
    `\n<i>bruto ${signedMoney(bruto)} − ${money(fees)} de comisiones</i>`;

  if (p.closeReason === "cierre_de_sesion") {
    return [
      `${icono} <b>0DTE</b> — cerrada ${contrato} <code>${esc(p.id)}</code>`,
      "",
      `El simulador liquidó al cierre de sesión a ${p.currentPrice.toFixed(2)} (el 0DTE no sobrevive al día).`,
      balance,
      "",
      "⚠️ En TOS no hay nada que teclear: a estas horas el contrato ya venció. Si lo tienes abierto, expira sin valor si quedó OTM, y si quedó ITM tu bróker lo liquida o te asigna.",
      `Capital simulado <b>${money(equity)}</b>`,
    ].join("\n");
  }

  const tos = tosSymbol(p.optionSymbol);
  // Los TRES motivos que llegan aquí llevan orden que teclear, porque los tres
  // ocurren con el mercado abierto. Un `if/else` de dos ramas ponía "saltó el
  // stop" en el cierre por reloj, que es mentira y encima la peor posible: haría
  // creer que la idea falló cuando lo que pasó es que se acabó su ventana.
  const MOTIVOS: Record<string, string> = {
    objetivo: "llegó al objetivo",
    stop: "saltó el stop",
    trailing: `devolvió el ${Math.round(TRAIL_DEVOLUCION_PCT * 100)}% de su ganancia desde el pico`,
    cierre_reloj: "cierre por reloj de las 15:30 (un 0DTE no llega vivo a la campana)",
  };
  // Tabla y no una cadena de ternarios: cada motivo nuevo que se añadía acababa
  // heredando el texto del último `else`, y decir "saltó el stop" de un cierre que
  // no fue un stop hace creer que la idea falló cuando no es eso lo que pasó.
  const motivo = MOTIVOS[p.closeReason ?? ""] ?? "cierre";
  const partes = [
    `🚨 <b>CERRAR EN TOS</b> — 0DTE ${icono} <code>${esc(p.id)}</code>`,
    "",
    "<b>ORDEN</b>",
    `VENDER PARA CERRAR · <b>${p.contracts}</b> contrato${p.contracts === 1 ? "" : "s"}`,
  ];
  if (tos) partes.push(`<code>${esc(tos)}</code>`);
  partes.push(
    `${contrato} · vence ${esc(p.expiration)}`,
    `LÍMITE <b>${p.currentPrice.toFixed(2)}</b> · cobras ≈ <b>${money(salida)}</b>`,
    "",
    balance,
    `Motivo: ${motivo}`,
    "",
    // El mismo aviso que en la apertura: el simulador sale al mid y el mercado no
    // tiene por qué darlo. Sin esto, una diferencia de horquilla se leería como
    // que el modelo falló.
    "⚠️ El límite es el MID de este instante. En un 0DTE el precio corre: mira la horquilla antes de enviar.",
    `Capital simulado <b>${money(equity)}</b>`,
    "<i>Paper — ningún dólar real se mueve.</i>",
  );
  return partes.join("\n");
}

/**
 * El límite diario del 0DTE acaba de saltar. Sale UNA vez por sesión, en el tick
 * en que se alcanza, porque es accionable: si el dueño está replicando la cuenta en
 * TOS, también debe dejar de abrir hoy — si no, las dos cuentas dejan de medir lo
 * mismo. No lleva 🚨: no hay orden que teclear, hay una que NO teclear.
 */
export function zeroLimiteDiarioText(perdidas: number, pnlHoy: number, equity: number): string {
  return [
    "⛔ <b>0DTE — límite diario alcanzado</b>",
    "",
    // "operaciones" pierde la tilde: no se puede componer pegando "es" al singular.
    `${perdidas} ${perdidas === 1 ? "operación" : "operaciones"} en pérdida hoy · P&L neto del día <b>${signedMoney(pnlHoy)}</b>`,
    "El simulador <b>no abre nada más hasta la próxima sesión</b>. Lo que siga abierto se gestiona igual.",
    "",
    "Si estás replicando en TOS: tampoco abras más hoy, o las dos cuentas dejan de ser comparables.",
    `Capital simulado <b>${money(equity)}</b>`,
    "<i>Paper — ningún dólar real se mueve.</i>",
  ].join("\n");
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
