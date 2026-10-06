// ============================================================================
// Playbook del Rango — FASE 1 (semanas 1–2): SOLO OBSERVAR.
//
// El manual (`Sub Agentes/Scalping de Rango.md`) manda ocho semanas y las dos
// primeras son sin operar: cada mañana se anotan los tres niveles y el GEX, y al
// cierre se contesta UNA pregunta — "¿el precio los respetó?".
//
// Este módulo implementa exactamente eso y nada más. NO hay detección de setups,
// NO hay tickets y NO hay cuenta de paper, a propósito: la estrategia entera se
// apoya en la premisa de que las paredes de gamma frenan el precio, y esa premisa
// todavía no está medida en los tickers del dueño. El documento de origen la
// reconstruyó de UNA sesión de MSFT con 4 de 4 ganadores, y él mismo avisa que
// "es un día excelente, no un día normal". Medir primero cuesta dos semanas;
// codificar los setups sobre una premisa falsa cuesta el resto.
//
// Todo aquí es PURO y testeable. La I/O vive en `scalpingScan.ts` (red) y
// `scalpingStore.ts` (disco).
// ============================================================================

import type { Chain2Contract } from "./optionChain2";
import { gexByStrike, totalGex } from "./optionChain2";
// `earningsDeFecha` vive en lib/earnings —es lógica de earnings y ahora la
// comparten scalping y venta de prima— y se reexporta para no cambiar los
// sitios que ya la importaban desde aquí.
import { earningsDeFecha, type EarningsFlag } from "./earnings";
export { earningsDeFecha };
import type { TfBar } from "./types";

// ── Umbrales del manual ─────────────────────────────────────────────────────

/** Net GEX mínimo para el semáforo VERDE. El manual pide "+$100M o más". */
export const NET_GEX_VERDE = 100_000_000;
/** Por debajo de esto el Net GEX está "cerca de cero": zona de transición. */
export const NET_GEX_AMBAR = 25_000_000;
/**
 * El Gamma Flip tiene que estar BIEN por debajo del precio. A menos de este %
 * el manual dice que no se opera: el régimen puede cambiar debajo de los pies.
 */
export const FLIP_MIN_PCT = 0.75;
/** Ventana de strikes (± % del spot) donde se buscan las paredes. */
export const MURO_VENTANA_PCT = 5;
/** "Tocó" un nivel: la mecha llegó a este % de distancia. */
export const TOQUE_PCT = 0.15;
/**
 * "Rompió" un nivel: una vela CERRÓ más allá de él por este margen. Es la regla
 * central del manual — tocar es una insinuación, cerrar es una respuesta — y por
 * eso la rotura se mide sobre cierres, nunca sobre mechas.
 */
export const ROTURA_PCT = 0.15;
/** "Pegado al imán": el cierre de la vela quedó a este % del centro. */
export const IMAN_PCT = 0.25;
/** Sesiones que dura la fase de observación (2 semanas de mercado). */
export const SESIONES_FASE_1 = 10;

/** Ventana en la que se pueden congelar los niveles, en minutos ET. */
export const ANOTAR_DESDE = 8 * 60;
export const ANOTAR_HASTA = 9 * 60 + 35;

export type Fase = "temprano" | "anotar" | "sesion" | "calificar";

/** En qué momento del día está la bitácora. `minutos` = minutos desde medianoche ET. */
export function faseDelDia(minutos: number | null): Fase {
  if (minutos == null) return "sesion";
  if (minutos < ANOTAR_DESDE) return "temprano";
  if (minutos < ANOTAR_HASTA) return "anotar";
  if (minutos < 16 * 60) return "sesion";
  return "calificar";
}

/**
 * Una anotación hecha fuera de la ventana de 8:00–9:35 ET.
 *
 * **La ventana tiene dos bordes y los dos importan, por motivos distintos.** Por
 * arriba: unos niveles dibujados a media sesión ya se eligieron viendo el precio.
 * Por abajo: a las 4 de la madrugada el único spot disponible es el cierre de
 * ayer, y con un precio viejo el piso y el techo pueden salir del lado que no es
 * — la observación queda envenenada sin que se note.
 *
 * No se prohíbe: si el portátil estaba apagado, tener la fila es mejor que perder
 * el día. Pero se marca, y `resumen()` la deja fuera de las estadísticas. Que
 * quede y no cuente es más honesto que las dos alternativas: bloquear (se pierde
 * el día) o contarla (se contamina la medición).
 */
export function fueraDeVentana(minutos: number | null): boolean {
  return minutos != null && (minutos < ANOTAR_DESDE || minutos >= ANOTAR_HASTA);
}

// ── Universo (página 5 del manual) ──────────────────────────────────────────

export type Tier = "optimo" | "funciona" | "depende" | "prohibido";

export const UNIVERSO: Record<string, Tier> = {
  SPY: "optimo", QQQ: "optimo", SPX: "optimo",
  MSFT: "funciona", AAPL: "funciona", NVDA: "funciona", AMZN: "funciona",
  META: "funciona", TSLA: "funciona", GOOGL: "funciona",
  UBER: "depende", MU: "depende", DAL: "depende", INTC: "depende", TSM: "depende",
  KO: "prohibido", WMT: "prohibido", GLW: "prohibido", SATS: "prohibido", BL: "prohibido",
};

export const TIER_TEXTO: Record<Tier, string> = {
  optimo: "Óptimo — vencimientos diarios, el efecto imán más limpio",
  funciona: "Funciona — semanales y gamma respetable",
  depende: "Depende del día — a veces hay paredes, muchas veces no",
  prohibido: "No lo intentes — poco volumen de opciones",
};

/**
 * Categoría del ticker. Lo que NO está en la lista se trata como "depende": el
 * manual califica por sesión, no por compañía, así que un desconocido no es un
 * "no" automático, pero tampoco entra en verde sin mirarlo.
 */
export function tierDe(ticker: string): Tier {
  return UNIVERSO[ticker.trim().toUpperCase()] ?? "depende";
}

/**
 * Productos de índice: no reportan resultados, nunca.
 *
 * Hace falta porque "no_aplica" cubre DOS situaciones que no son la misma: un ETF
 * que de verdad no reporta, y un ticker del que no se pudo obtener la fecha. Sin
 * esta lista, SPY y QQQ —dos de los tres que el manual pone en "óptimo"— nunca
 * llegarían a verde por un aviso que no les aplica, y el semáforo sería ruido.
 */
export const SIN_EARNINGS = new Set(["SPY", "QQQ", "SPX", "IWM", "DIA", "NDX", "RUT"]);

// ── Los tres niveles ────────────────────────────────────────────────────────

export interface Niveles {
  /** Put Wall = el piso. Strike de más Open Interest de puts POR DEBAJO del spot. */
  piso: number | null;
  pisoOi: number;
  /** Call Wall = el techo. Strike de más Open Interest de calls POR ENCIMA del spot. */
  techo: number | null;
  techoOi: number;
  /** Imán = strike de mayor |gamma neta| cerca del spot. */
  centro: number | null;
  /** Ancho del rango en % del spot. null si falta una pared. */
  anchoPct: number | null;
}

const SIN_NIVELES: Niveles = {
  piso: null, pisoOi: 0, techo: null, techoOi: 0, centro: null, anchoPct: null,
};

/**
 * Los tres números que se dibujan antes de las 9:30.
 *
 * La diferencia con `zerodte.ts` es el LADO: allí `maxCall`/`maxPut` son el máximo
 * OI de cada tipo caiga donde caiga, y para el 0DTE está bien. Aquí el techo tiene
 * que estar ARRIBA y el piso ABAJO o no son un rango: un "techo" por debajo del
 * precio no es contra lo que se vende, es lo que ya se rompió.
 */
export function niveles(contracts: Chain2Contract[], spot: number): Niveles {
  if (!(spot > 0) || contracts.length === 0) return SIN_NIVELES;
  const margen = spot * (MURO_VENTANA_PCT / 100);
  const min = spot - margen;
  const max = spot + margen;

  let piso: number | null = null, pisoOi = 0;
  let techo: number | null = null, techoOi = 0;
  for (const c of contracts) {
    if (c.openInterest <= 0 || c.strike < min || c.strike > max) continue;
    if (c.type === "put" && c.strike < spot && c.openInterest > pisoOi) {
      piso = c.strike; pisoOi = c.openInterest;
    }
    if (c.type === "call" && c.strike > spot && c.openInterest > techoOi) {
      techo = c.strike; techoOi = c.openInterest;
    }
  }

  // El imán se busca ESTRICTAMENTE ENTRE las dos paredes, no en toda la ventana.
  // Sin ese corte, el máximo |gamma neta| cae casi siempre sobre el propio Put
  // Wall —los puts acumulan mucho más OI que los calls en los strikes redondos—
  // y el "centro" acababa siendo el piso. Un centro pegado a una pared no es un
  // tercer nivel: son dos niveles y una etiqueta repetida.
  let centro: number | null = null, mejor = 0;
  if (piso != null && techo != null) {
    for (const s of gexByStrike(contracts, spot)) {
      if (s.strike <= piso || s.strike >= techo) continue;
      const mag = Math.abs(s.gex);
      if (mag > mejor) { mejor = mag; centro = s.strike; }
    }
  }

  const anchoPct = piso != null && techo != null ? ((techo - piso) / spot) * 100 : null;
  return { piso, pisoOi, techo, techoOi, centro, anchoPct };
}

export interface Regimen {
  netGex: number;
  flipStrike: number | null;
  /** % del spot al que está el flip. Positivo = POR DEBAJO del precio (lo bueno). */
  flipDistPct: number | null;
}

/**
 * Net GEX de la cadena y **Gamma Flip por la gamma ACUMULADA**.
 *
 * Esto NO es lo que hace `zerodte.ts`, y la diferencia importa. Allí el flip es el
 * primer cambio de signo entre DOS STRIKES VECINOS, y cerca del dinero eso es casi
 * siempre lo mismo: los puts dominan por debajo y los calls por encima, así que el
 * "cruce" cae en la frontera entre esos dos strikes pase lo que pase. Su distancia
 * al spot mide **cuán lejos está el siguiente strike**, no en qué régimen estás.
 *
 * Se vio midiendo: con la definición por strike, 8 de los 10 tickers seguidos
 * salían con el flip POR ENCIMA del precio, varios de ellos con un Net GEX
 * fuertemente positivo (GOOGL +$209M, SPX +$14,5B) — dos afirmaciones que no pueden
 * ser ciertas a la vez. Lo que fallaba era la medida, no el mercado.
 *
 * Aquí se acumula el GEX de abajo arriba y se busca dónde la SUMA cruza cero, que
 * es el proxy estándar de "gamma cero": por debajo de ese precio la gamma neta del
 * dealer es negativa (amplifica) y por encima positiva (revierte). Integrar hace
 * que un strike suelto a contracorriente no mueva el nivel.
 */
export function regimen(contracts: Chain2Contract[], spot: number): Regimen {
  const strikes = gexByStrike(contracts, spot);
  const netGex = totalGex(strikes);

  let flipStrike: number | null = null;
  let mejorDist = Infinity;
  let acum = 0;
  let previo: { strike: number; acum: number } | null = null;

  for (const s of strikes) {
    const nuevo = acum + s.gex;
    if (previo && ((previo.acum < 0 && nuevo >= 0) || (previo.acum > 0 && nuevo <= 0))) {
      const span = Math.abs(previo.acum) + Math.abs(nuevo);
      const cruce = span > 0
        ? previo.strike + (s.strike - previo.strike) * (Math.abs(previo.acum) / span)
        : (previo.strike + s.strike) / 2;
      const dist = Math.abs(cruce - spot);
      if (dist < mejorDist) { mejorDist = dist; flipStrike = cruce; }
    }
    previo = { strike: s.strike, acum: nuevo };
    acum = nuevo;
  }

  const flipDistPct = flipStrike != null && spot > 0 ? ((spot - flipStrike) / spot) * 100 : null;
  return { netGex, flipStrike, flipDistPct };
}

// ── El semáforo ─────────────────────────────────────────────────────────────

export type Luz = "verde" | "ambar" | "rojo";

export interface SemaforoInput {
  ticker: string;
  netGex: number;
  flipDistPct: number | null;
  niveles: Niveles;
  earnings: EarningsFlag;
  /** % de la gamma que vive en el vencimiento del frente. null si no se pudo medir. */
  gammaFrentePct: number | null;
  /** Días hasta ese vencimiento del frente. Da contexto al % de arriba. */
  frenteDte: number | null;
}

export interface Semaforo {
  luz: Luz;
  /** Frases cortas que explican la luz, en orden de peso. */
  motivos: string[];
  /** Lo que por sí solo pinta de rojo. Vacío si no hay ninguno. */
  bloqueos: string[];
}

/**
 * El semáforo de la página 4, que es la página que decide si hay día o no.
 *
 * Es DELIBERADAMENTE severo: el manual avisa de que la estrategia se ve igual de
 * buena los días verdes que los rojos y que la diferencia solo aparece cuando ya
 * perdiste. En fase 1 nadie opera, así que un ámbar de más no cuesta nada; lo que
 * sí importa es que la etiqueta sea honesta, porque las estadísticas de las dos
 * semanas se parten POR ESTA LUZ. Si el filtro se ablanda, la medición no dice nada.
 */
export function semaforo(i: SemaforoInput): Semaforo {
  const bloqueos: string[] = [];
  const tier = tierDe(i.ticker);

  if (tier === "prohibido") {
    bloqueos.push(`${i.ticker} está en la lista de "no lo intentes" (poco volumen de opciones).`);
  }
  if (i.earnings === "dentro" || i.earnings === "dentro_confirmado") {
    bloqueos.push("Hay earnings dentro del vencimiento. El manual no admite excepciones.");
  }
  if (i.netGex < 0) {
    bloqueos.push(`Net GEX NEGATIVO (${dinero(i.netGex)}): los movimientos se aceleran y el precio atraviesa los niveles.`);
  }
  if (i.niveles.piso == null || i.niveles.techo == null) {
    bloqueos.push("Falta una pared: sin piso o sin techo no hay rango que observar.");
  }

  if (bloqueos.length > 0) return { luz: "rojo", motivos: bloqueos, bloqueos };

  const tibios: string[] = [];
  const buenos: string[] = [];

  if (i.netGex < NET_GEX_AMBAR) {
    tibios.push(`Net GEX cerca de cero (${dinero(i.netGex)}): zona de transición, los niveles no aguantan.`);
  } else if (i.netGex < NET_GEX_VERDE) {
    tibios.push(`Net GEX de ${dinero(i.netGex)}, por debajo de los ${dinero(NET_GEX_VERDE)} que pide el manual.`);
  } else {
    buenos.push(`Net GEX positivo y grande: ${dinero(i.netGex)}.`);
  }

  // El manual solo pinta de ROJO el Net GEX negativo; el Gamma Flip aparece en su
  // semáforo como "el precio pegado al Gamma Flip → NO OPERES", que es ámbar. Un
  // flip POR ENCIMA del precio no es una categoría suya, así que se trata como el
  // caso peor del ámbar y no como bloqueo: ser más severo que la fuente dejaba sin
  // días verdes justo la medición que la fase 1 existe para hacer.
  if (i.flipDistPct == null) {
    tibios.push("No se pudo situar el Gamma Flip en esta cadena.");
  } else if (i.flipDistPct <= 0) {
    tibios.push(`El Gamma Flip está POR ENCIMA del precio (a ${Math.abs(i.flipDistPct).toFixed(2)}%): del lado malo del régimen.`);
  } else if (i.flipDistPct < FLIP_MIN_PCT) {
    tibios.push(`El precio está pegado al Gamma Flip (a ${i.flipDistPct.toFixed(2)}%).`);
  } else {
    buenos.push(`Gamma Flip a ${i.flipDistPct.toFixed(2)}% por debajo del precio.`);
  }

  if (tier === "depende") {
    tibios.push(`${i.ticker} es de los que "dependen del día": verifica las paredes a mano.`);
  } else {
    buenos.push(TIER_TEXTO[tier]);
  }

  // La concentración de gamma se APUNTA, no decide la luz. Y es a propósito.
  //
  // El manual la trata como un gradiente, no como una puerta: *"mientras más alto
  // el %, mejor"*. Tenía un umbral del 40% puesto por mí, sin nada detrás — y al
  // medirlo de verdad el 2026-09-07 los DIEZ tickers salieron por debajo (4%–30%,
  // mediana 17%), o sea que ese umbral no separaba nada: solo añadía el mismo
  // motivo ámbar a todo el mundo. Bajarlo hasta que "funcione" sería ajustar un
  // parámetro para producir el resultado que quiero ver, que es justo lo que la
  // fase 1 prohíbe.
  //
  // El número se guarda en cada fila. Cuando haya diez sesiones calificadas se
  // podrá cruzar contra el veredicto y ver qué concentración separa de verdad los
  // días que respetan de los que rompen. ESE es el umbral que valdrá, y saldrá de
  // los datos en vez de mi intuición.
  const dte = i.frenteDte == null ? "" : ` (vence en ${i.frenteDte} ${i.frenteDte === 1 ? "día" : "días"})`;
  if (i.gammaFrentePct == null) {
    buenos.push("Sin medida de la concentración de gamma en el vencimiento del frente.");
  } else {
    buenos.push(`${Math.round(i.gammaFrentePct)}% de la gamma en el vencimiento del frente${dte}.`);
  }

  if (i.earnings === "no_aplica" && !SIN_EARNINGS.has(i.ticker.trim().toUpperCase())) {
    tibios.push("Tastytrade no dio fecha de earnings para este ticker. Verifícalo tú antes de creerle a esta luz.");
  }

  return tibios.length > 0
    ? { luz: "ambar", motivos: [...tibios, ...buenos], bloqueos: [] }
    : { luz: "verde", motivos: buenos, bloqueos: [] };
}

export function dinero(n: number): string {
  const abs = Math.abs(n);
  const signo = n < 0 ? "−" : "+";
  if (abs >= 1e9) return `${signo}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${signo}$${(abs / 1e6).toFixed(0)}M`;
  return `${signo}$${Math.round(abs).toLocaleString("en-US")}`;
}

// ── La anotación de la mañana ───────────────────────────────────────────────

export interface Observacion {
  ticker: string;
  /** Día de mercado (ET), YYYY-MM-DD. Con `ticker` forma la clave. */
  fecha: string;
  /** Cuándo se congelaron los niveles (ISO). */
  anotadaEn: string;
  expiracion: string;
  spotApertura: number;
  netGex: number;
  flipStrike: number | null;
  flipDistPct: number | null;
  gammaFrentePct: number | null;
  /** Días hasta el vencimiento del que salen las paredes. */
  frenteDte: number | null;
  earnings: EarningsFlag;
  tier: Tier;
  niveles: Niveles;
  luz: Luz;
  motivos: string[];
  /** Anotada fuera de la ventana de apertura: queda en la bitácora, no cuenta. */
  fueraVentana: boolean;
  /**
   * De dónde salió la cadena (paredes, Net GEX, flip). Ausente en las filas
   * anteriores al 2026-09-17, que salieron TODAS de MarketSnack: el Open Interest
   * es el mismo dato en las dos fuentes, pero la gamma no, así que el Net GEX —y con
   * él el semáforo— puede diferir. Sirve para separar las dos poblaciones al leer
   * `porLuz` si las filas de Tastytrade dicen otra cosa.
   */
  fuenteCadena?: "tastytrade" | "marketsnack";
  /** Máximo y mínimo de AYER, que el manual manda marcar en la gráfica. */
  ayer: { alto: number; bajo: number } | null;
  /** Se rellena al cierre. null mientras la sesión no ha terminado. */
  cierre: Calificacion | null;
}

// ── La calificación del cierre ──────────────────────────────────────────────

export interface NivelCalificado {
  nivel: number;
  /** La mecha llegó a TOQUE_PCT del nivel. */
  toco: boolean;
  /** Una vela CERRÓ más allá del nivel por ROTURA_PCT. */
  rompio: boolean;
  /** true = tocó y aguantó · false = rompió · null = el precio no llegó. */
  respeto: boolean | null;
  /** Cuánto se pasó la mecha del nivel, en % (0 si nunca lo superó). */
  excursionPct: number;
}

export interface Calificacion {
  calificadaEn: string;
  velas: number;
  apertura: number;
  alto: number;
  bajo: number;
  cierre: number;
  piso: NivelCalificado | null;
  techo: NivelCalificado | null;
  /** El veredicto del día en una palabra. */
  veredicto: "respeto" | "rompio" | "no_llego";
  /** % de velas cuyo CIERRE quedó dentro del rango [piso, techo]. */
  contenidoPct: number | null;
  /** % de velas que cerraron pegadas al imán (±IMAN_PCT). */
  imanPct: number | null;
  /** Recorrido real del día como % del ancho del rango. >100 = se salió. */
  rangoUsadoPct: number | null;
}

/**
 * Contesta la pregunta del cierre: "¿el precio respetó mis tres niveles?".
 *
 * `respeto` es TERNARIO por diseño. Un día en que el precio nunca llegó al piso
 * no es una victoria del piso: es un día sin información sobre el piso. Contarlo
 * como acierto —el error obvio— inflaría la tasa justo en los días tranquilos,
 * que son los que menos dicen. Por eso "no llegó" es su propia categoría y sale
 * de la tasa de acierto en `resumen()`.
 *
 * `bars` son las velas de la SESIÓN (9:30–16:00 ET) del día de la observación.
 */
export function calificar(o: Observacion, bars: TfBar[], ahora: Date): Calificacion | null {
  if (bars.length === 0) return null;

  const alto = Math.max(...bars.map((b) => b.high));
  const bajo = Math.min(...bars.map((b) => b.low));
  const apertura = bars[0].open;
  const cierre = bars[bars.length - 1].close;

  const piso = o.niveles.piso != null ? calificarNivel(o.niveles.piso, bars, "piso") : null;
  const techo = o.niveles.techo != null ? calificarNivel(o.niveles.techo, bars, "techo") : null;

  const tocados = [piso, techo].filter((n): n is NivelCalificado => n != null && n.toco);
  const veredicto: Calificacion["veredicto"] =
    tocados.length === 0 ? "no_llego"
      : tocados.some((n) => n.rompio) ? "rompio"
        : "respeto";

  let contenidoPct: number | null = null;
  if (o.niveles.piso != null && o.niveles.techo != null) {
    const dentro = bars.filter((b) => b.close >= o.niveles.piso! && b.close <= o.niveles.techo!).length;
    contenidoPct = (dentro / bars.length) * 100;
  }

  let imanPct: number | null = null;
  if (o.niveles.centro != null && o.niveles.centro > 0) {
    const margen = o.niveles.centro * (IMAN_PCT / 100);
    const pegadas = bars.filter((b) => Math.abs(b.close - o.niveles.centro!) <= margen).length;
    imanPct = (pegadas / bars.length) * 100;
  }

  let rangoUsadoPct: number | null = null;
  if (o.niveles.piso != null && o.niveles.techo != null) {
    const ancho = o.niveles.techo - o.niveles.piso;
    if (ancho > 0) rangoUsadoPct = ((alto - bajo) / ancho) * 100;
  }

  return {
    calificadaEn: ahora.toISOString(),
    velas: bars.length,
    apertura, alto, bajo, cierre,
    piso, techo, veredicto,
    contenidoPct, imanPct, rangoUsadoPct,
  };
}

function calificarNivel(nivel: number, bars: TfBar[], lado: "piso" | "techo"): NivelCalificado {
  const toque = nivel * (TOQUE_PCT / 100);
  const rotura = nivel * (ROTURA_PCT / 100);

  let toco = false;
  let rompio = false;
  let excursion = 0;

  for (const b of bars) {
    if (lado === "piso") {
      if (b.low <= nivel + toque) toco = true;
      if (b.close < nivel - rotura) rompio = true;
      excursion = Math.max(excursion, nivel - b.low);
    } else {
      if (b.high >= nivel - toque) toco = true;
      if (b.close > nivel + rotura) rompio = true;
      excursion = Math.max(excursion, b.high - nivel);
    }
  }

  return {
    nivel,
    toco,
    rompio,
    respeto: !toco ? null : !rompio,
    excursionPct: nivel > 0 ? Math.max(0, excursion / nivel) * 100 : 0,
  };
}

/** Minutos desde medianoche en Nueva York y día de mercado (ET) de un epoch. */
function etDe(timeSec: number): { fecha: string; minutos: number } {
  const d = new Date(timeSec * 1000);
  const fecha = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const h = Number(partes.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(partes.find((p) => p.type === "minute")?.value ?? 0);
  return { fecha, minutos: (h % 24) * 60 + m };
}

/**
 * Las velas de la SESIÓN regular (9:30–16:00 ET) de un día de mercado.
 *
 * El filtro va en hora de Nueva York, no en la del portátil: esta máquina va en
 * UTC−4 todo el año pero Nueva York pasa a UTC−5 en noviembre, y una ventana
 * atada al reloj local desplazaría media sesión medio año. Es el mismo reparto
 * que ya hacen los disparadores de paper.
 *
 * Se excluye la pre y la post a propósito: el manual fija los niveles ANTES de
 * las 9:30 y los juzga contra la sesión, no contra un cruce de madrugada.
 */
export function velasDeSesion(bars: TfBar[], fecha: string): TfBar[] {
  return bars
    .filter((b) => {
      const { fecha: f, minutos } = etDe(b.time);
      return f === fecha && minutos >= 9 * 60 + 30 && minutos < 16 * 60;
    })
    .sort((a, b) => a.time - b.time);
}

// ── El recuento de las dos semanas ──────────────────────────────────────────

export interface Estadistica {
  sesiones: number;
  calificadas: number;
  respeto: number;
  rompio: number;
  noLlego: number;
  /** respetó / (respetó + rompió). null si ningún día llegó a un nivel. */
  tasaRespeto: number | null;
  /** Media del % de velas contenidas en el rango. */
  contenidoMedio: number | null;
  /** Media del % de velas pegadas al imán. */
  imanMedio: number | null;
}

export interface Resumen {
  total: Estadistica;
  porLuz: Record<Luz, Estadistica>;
  porTicker: { ticker: string; stats: Estadistica }[];
  /** Sesiones distintas anotadas EN VENTANA, de las SESIONES_FASE_1 del manual. */
  sesionesDistintas: number;
  /** Filas descartadas por haberse anotado tarde. */
  fueraDeVentanaCount: number;
  faseCompleta: boolean;
  /** La lectura en una frase. Es la salida de la fase 1. */
  lectura: string;
}

function vacia(): Estadistica {
  return {
    sesiones: 0, calificadas: 0, respeto: 0, rompio: 0, noLlego: 0,
    tasaRespeto: null, contenidoMedio: null, imanMedio: null,
  };
}

function acumular(obs: Observacion[]): Estadistica {
  const s = vacia();
  s.sesiones = obs.length;
  const contenidos: number[] = [];
  const imanes: number[] = [];
  for (const o of obs) {
    if (!o.cierre) continue;
    s.calificadas += 1;
    if (o.cierre.veredicto === "respeto") s.respeto += 1;
    else if (o.cierre.veredicto === "rompio") s.rompio += 1;
    else s.noLlego += 1;
    if (o.cierre.contenidoPct != null) contenidos.push(o.cierre.contenidoPct);
    if (o.cierre.imanPct != null) imanes.push(o.cierre.imanPct);
  }
  const decididas = s.respeto + s.rompio;
  s.tasaRespeto = decididas > 0 ? (s.respeto / decididas) * 100 : null;
  s.contenidoMedio = contenidos.length > 0 ? media(contenidos) : null;
  s.imanMedio = imanes.length > 0 ? media(imanes) : null;
  return s;
}

function media(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * El recuento que decide si la fase 2 tiene sentido.
 *
 * El corte que importa es `porLuz`: si los días VERDES no respetan los niveles
 * mejor que los ámbar y rojos, el filtro de la página 4 no está filtrando nada,
 * y esa es la conclusión — no una estadística más de la tabla.
 */
export function resumen(todas: Observacion[]): Resumen {
  const obs = todas.filter((o) => !o.fueraVentana);
  const total = acumular(obs);

  const porLuz: Record<Luz, Estadistica> = {
    verde: acumular(obs.filter((o) => o.luz === "verde")),
    ambar: acumular(obs.filter((o) => o.luz === "ambar")),
    rojo: acumular(obs.filter((o) => o.luz === "rojo")),
  };

  const tickers = [...new Set(obs.map((o) => o.ticker))].sort();
  const porTicker = tickers.map((t) => ({
    ticker: t,
    stats: acumular(obs.filter((o) => o.ticker === t)),
  }));

  const sesionesDistintas = new Set(obs.map((o) => o.fecha)).size;

  return {
    total, porLuz, porTicker, sesionesDistintas,
    fueraDeVentanaCount: todas.length - obs.length,
    faseCompleta: sesionesDistintas >= SESIONES_FASE_1,
    lectura: lecturaDe(total, porLuz, sesionesDistintas),
  };
}

function lecturaDe(
  total: Estadistica,
  porLuz: Record<Luz, Estadistica>,
  sesiones: number,
): string {
  if (total.calificadas === 0) {
    return "Todavía no hay ninguna sesión calificada. La lectura aparece cuando cierren los primeros días.";
  }
  if (sesiones < SESIONES_FASE_1) {
    return `Vas por ${sesiones} de ${SESIONES_FASE_1} sesiones. Aún es pronto para concluir nada: sigue anotando.`;
  }

  const v = porLuz.verde.tasaRespeto;
  const noVerdeDecididas = porLuz.ambar.respeto + porLuz.ambar.rompio + porLuz.rojo.respeto + porLuz.rojo.rompio;
  const noVerdeRespeto = porLuz.ambar.respeto + porLuz.rojo.respeto;
  const nv = noVerdeDecididas > 0 ? (noVerdeRespeto / noVerdeDecididas) * 100 : null;

  if (v == null) {
    return "Las dos semanas están completas pero ningún día VERDE llegó a un nivel. Sin días verdes decididos no hay nada que concluir: alarga la observación.";
  }

  // El veredicto sobre la PREMISA va antes que el veredicto sobre el FILTRO, y no
  // al revés: si los niveles no aguantan ni en los días verdes, da igual cuánto
  // separe el semáforo — no hay rango que operar. Tener solo días verdes no
  // convierte un 30% en "falta contraste".
  if (v < 70) {
    const cola = nv == null ? "" : ` (${nv.toFixed(0)}% en el resto)`;
    return `Los niveles solo aguantaron el ${v.toFixed(0)}% de las veces en días VERDES${cola}. La premisa del rango NO se sostiene en estos tickers: no pases a la fase 2.`;
  }
  if (nv == null) {
    return `Los niveles aguantaron el ${v.toFixed(0)}% de las veces en días VERDES, pero no hubo días no verdes decididos con los que comparar: la premisa se sostiene, el filtro está sin medir.`;
  }
  if (v - nv >= 15) {
    return `Los niveles aguantaron el ${v.toFixed(0)}% de las veces en días VERDES contra el ${nv.toFixed(0)}% en el resto. La premisa se sostiene y el filtro aporta: tiene sentido pasar a la fase 2 (papel, solo setup B).`;
  }
  return `Los niveles aguantaron el ${v.toFixed(0)}% en días VERDES y el ${nv.toFixed(0)}% en el resto: la premisa se sostiene, pero el semáforo NO está separando nada. Revísalo antes de la fase 2.`;
}
