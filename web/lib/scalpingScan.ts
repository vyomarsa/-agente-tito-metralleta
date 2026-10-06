// ============================================================================
// Ensamblaje de la bitácora del Playbook del Rango — la copia ÚNICA.
//
// Vive fuera de la ruta porque lo consumen DOS clientes, igual que `zerodteScan`:
//   · `app/api/scalping` — lo que ve la pestaña.
//   · `scripts/scalping-run.mjs` (tarea programada) — la anotación de las 9:15 y
//     la calificación de las 16:05, que tienen que ocurrir SIN la página abierta.
//
// Ese segundo cliente es el que importa: el manual manda anotar los niveles CADA
// mañana durante dos semanas, y una bitácora que solo avanza cuando alguien se
// acuerda de abrir la pestaña mide la constancia del usuario, no la estrategia.
//
// FUENTES — este módulo NO toca Massive por ningún camino:
//   · Tastytrade  → vencimientos, cadena con GAMMA REAL, spot en vivo, velas
//                   (diarias y de 5m) y fecha de earnings.
//   · MarketSnack → solo de respaldo para vencimientos y cadena (desde el
//                   2026-09-17; antes era la única fuente de la cadena).
//   · Schwab      → solo como último escalón de la cascada de velas, para índices.
// ============================================================================

import { FrontChainError, fetchChainsByDate, listExpirations } from "./frontChain";
import { dteOf, gexByStrike, type Chain2Contract } from "./optionChain2";
import { fetchMarketMetrics, fetchTastytradeSpot, tastytradeConfigured } from "./tastytrade";
import { dailyBarDate, loadTfBars } from "./barSources";
import { cachedTfBars } from "./barsStore";
import type { EarningsFlag } from "./earnings";
import { marketDateStr } from "./occ";
import {
  calificar, earningsDeFecha, fueraDeVentana, faseDelDia, niveles, regimen, semaforo, tierDe,
  velasDeSesion,
  type Calificacion, type Fase, type Observacion,
} from "./scalping";
import { etMinutes } from "./zerodteScan";
import { anotar, calificarEnDisco, cargar, pendientes, type ResultadoAnotar } from "./scalpingStore";

/**
 * Universo de la bitácora: los tres índices "óptimos" del manual + las 7
 * magníficas. Elegido por el dueño el 2026-09-04.
 *
 * Coincide exactamente con las dos categorías altas del manual (§6) y no las
 * pasa: nada de la lista "depende del día" entra aquí. Diez tickers × diez
 * sesiones dan cien observaciones, que es muestra de sobra para contestar si las
 * paredes aguantan — y permite además cortar por ticker, que es donde puede
 * verse que la premisa vale para los índices y no para las acciones (o al revés).
 */
export const SEGUIDOS = [
  "SPY", "QQQ", "SPX",
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA",
];

/**
 * Vencimientos que entran al cálculo del % de gamma en 0–1 DTE.
 *
 * Seis y no toda la cadena: con Tastytrade van todos en la MISMA conexión, pero
 * cada uno son cientos de símbolos más que esperar (y en el respaldo de MarketSnack,
 * una llamada por fecha), y la gamma de un vencimiento a tres meses no compite por
 * ser la pared de hoy. Lo que el manual quiere saber —"¿está la gamma concentrada
 * en el frente?"— se contesta con el frente y sus vecinos inmediatos.
 */
const EXPIRACIONES_GAMMA = 6;

/** Timeframe con el que se califica la sesión. */
const TF_SESION = "5m5d";

export class ScalpingScanError extends Error {}

/** Suma de |GEX| de una cadena: cuánta gamma hay ahí, sin importar el lado. */
function gammaTotal(contracts: Chain2Contract[], spot: number): number {
  return gexByStrike(contracts, spot).reduce((s, k) => s + Math.abs(k.gex), 0);
}

/**
 * % de la gamma que vive en el vencimiento DEL FRENTE — el mismo del que salen
 * las paredes.
 *
 * El manual lo llama "el dato que lo explica todo" y lo enuncia en singular: *"el
 * 77% de toda la gamma estaba en **el vencimiento de 1 día**"*. En SPY, QQQ y SPX
 * ese vencimiento es el de hoy o el de mañana, así que medirlo "en 0–1 DTE" daba
 * lo mismo. **En acciones no**, y ahí la versión literal se rompía: las 7
 * magníficas no tienen vencimientos diarios, así que un lunes su frente es el
 * viernes (DTE 4) y el "% en 0–1 DTE" salía **0% para las siete, todos los lunes,
 * martes y miércoles** — un motivo ámbar permanente que no decía nada del ticker.
 *
 * Lo que la pregunta quiere saber es si la gamma está CONCENTRADA en el
 * vencimiento que manda hoy, y eso se responde igual con semanales que con
 * diarios. `frenteDte` acompaña al número porque un 60% con el frente a 0 días no
 * significa lo mismo que un 60% con el frente a 4.
 *
 * Best-effort: si algún vencimiento no llegó se calcula con los que sí, y si no
 * llega ninguno devuelve null. Un null baja el semáforo a ámbar, que es el
 * comportamiento correcto — no saberlo no es lo mismo que estar bien.
 *
 * PURA: las cadenas ya vienen bajadas (una sola conexión en `observar`).
 */
function gammaDelFrente(
  fechas: string[],
  spot: number,
  frenteFecha: string,
  byDate: Map<string, Chain2Contract[]>,
): number | null {
  let frente = 0;
  let total = 0;
  let vistas = 0;

  for (const fecha of fechas) {
    const contracts = byDate.get(fecha);
    if (!contracts || contracts.length === 0) continue;
    const g = gammaTotal(contracts, spot);
    if (g <= 0) continue;
    total += g;
    if (fecha === frenteFecha) frente = g;
    vistas += 1;
  }

  // Sin la cadena del frente no hay numerador: devolver 0% diría "paredes
  // blandísimas" cuando lo cierto es que no se pudo medir.
  if (vistas === 0 || total <= 0 || frente <= 0) return null;
  return (frente / total) * 100;
}

/**
 * Monta la anotación de la mañana de un ticker. NO la guarda: eso lo decide
 * quien llama, porque la pestaña también usa esto para el PREVIEW en vivo.
 */
export async function observar(ticker: string, now: Date): Promise<Observacion> {
  const clean = ticker.trim().toUpperCase();
  const fecha = marketDateStr(now);

  let listadas: string[];
  try {
    listadas = (await listExpirations(clean)).dates;
  } catch (e) {
    throw e instanceof FrontChainError ? new ScalpingScanError(e.message) : e;
  }
  const futuras = listadas.filter((d) => dteOf(d, now) >= 0);
  if (futuras.length === 0) {
    throw new ScalpingScanError(`No hay vencimientos futuros para ${clean}.`);
  }

  const expiracion = futuras[0];
  const fechasGamma = futuras.slice(0, EXPIRACIONES_GAMMA);
  const [cadenas, diarias, metricas] = await Promise.all([
    // El frente va PRIMERO: es el que manda y el que decide la fuente.
    fetchChainsByDate(clean, fechasGamma)
      .then(async (r) => ({ ...r, spot: r.spot ?? (await fetchTastytradeSpot(clean).catch(() => null)) }))
      .catch((e) => {
        throw e instanceof FrontChainError ? new ScalpingScanError(e.message) : e;
      }),
    // Diarias por la CASCADA (Tastytrade → Massive → Schwab) y con cache de disco,
    // no por `cachedDailyBars`, que va directo a Massive. Massive está cancelado y
    // además nunca cotizó índices, así que por ahí SPX no tendría ni el dato de
    // ayer ni respaldo. Es el mismo helper que usa `/api/bars`.
    cachedTfBars(clean, "1y", () => loadTfBars(clean, "1y")).then((r) => r.bars).catch(() => []),
    // La fecha de earnings sale de Tastytrade, que sí la sirve. El calendario
    // anterior venía de Massive y con el plan cancelado devolvía SIEMPRE
    // "no_aplica" — o sea que el filtro de earnings del manual, que no admite
    // excepciones, llevaba desde el primer día sin poder comprobar nada.
    tastytradeConfigured()
      ? fetchMarketMetrics([clean]).catch(() => [])
      : Promise.resolve([]),
  ]);

  const contracts = cadenas.byDate.get(expiracion) ?? [];
  const ttSpot = cadenas.spot;
  if (contracts.length === 0) {
    throw new ScalpingScanError(`Cadena vacía para ${clean} (${expiracion}).`);
  }

  // El spot tiene que ser un precio VIVO de Tastytrade. Sin él no se observa.
  //
  // Aquí había un respaldo al último cierre diario y era un fallo silencioso de
  // manual: el 2026-09-04, con el token de Tastytrade rechazado desde hacía dos
  // días, las diez fichas se pintaban tan campantes con el CIERRE DE AYER como si
  // fuera el precio de ahora (AAPL "spot" 328,21 = su cierre del día 3). Y el
  // precio no es un adorno de esta pantalla: el piso es el muro de puts POR DEBAJO
  // y el techo el de calls POR ENCIMA, así que un spot desplazado reparte los
  // strikes a los lados que no son y la observación del día sale envenenada sin
  // que nada lo delate. Ni paridad ni cierre de ayer: o hay precio vivo, o no hay
  // ficha.
  if (!(ttSpot != null && ttSpot > 0)) {
    throw new ScalpingScanError(
      `Sin precio en vivo de ${clean}. Tastytrade no está sirviendo el spot y los niveles no se pueden fijar contra un cierre viejo.`,
    );
  }
  const spot = ttSpot;

  const lvl = niveles(contracts, spot);
  const reg = regimen(contracts, spot);
  const gammaFrentePct = gammaDelFrente(fechasGamma, spot, expiracion, cadenas.byDate);

  // `earningsFlag` es la parte PURA de lib/earnings; lo único que cambia es de
  // dónde sale la fecha. `frontSkew: null` porque este escaneo no calcula el skew
  // del frente, igual que hace el de venta de prima.
  const earnings: EarningsFlag = earningsDeFecha(
    metricas.find((m) => m.symbol === clean)?.earningsDate ?? null,
    expiracion,
    fecha,
  );

  const sem = semaforo({
    ticker: clean, netGex: reg.netGex, flipDistPct: reg.flipDistPct,
    niveles: lvl, earnings, gammaFrentePct, frenteDte: dteOf(expiracion, now),
  });

  // Máximos y mínimos de AYER, que el manual manda marcar en la gráfica. `diarias`
  // puede traer ya la vela de hoy, así que se toma la última que NO sea de hoy.
  // El día se saca con `dailyBarDate` porque estas barras vienen en epoch, y
  // compararlas por su hora UTC cruda adelantaría un día las de después de las 20:00 ET.
  const previa = [...diarias].reverse().find((b) => dailyBarDate(b.time) < fecha) ?? null;

  return {
    ticker: clean, fecha, anotadaEn: now.toISOString(), expiracion,
    spotApertura: spot,
    netGex: reg.netGex, flipStrike: reg.flipStrike, flipDistPct: reg.flipDistPct,
    gammaFrentePct, frenteDte: dteOf(expiracion, now), earnings, tier: tierDe(clean),
    niveles: lvl, luz: sem.luz, motivos: sem.motivos,
    fueraVentana: fueraDeVentana(etMinutes(now)),
    fuenteCadena: cadenas.source,
    ayer: previa ? { alto: previa.high, bajo: previa.low } : null,
    cierre: null,
  };
}

/**
 * Cache SOLO PARA LA VISTA. Nunca lo toca `anotarSesion`.
 *
 * La pestaña enseña los diez tickers en vivo y cada uno cuesta una cadena de seis
 * vencimientos (varios segundos en SPX y SPY, las cadenas gordas): sin esto, un
 * refresco de página son setenta llamadas y un minuto de espera. Con las paredes
 * salidas del Open Interest —que no se mueve intradía hasta la liquidación— lo
 * único que cambia dentro del minuto es el spot, así que una foto de dos minutos
 * enseña lo mismo.
 *
 * **Lo que SE PERSISTE nunca sale de aquí.** `anotarSesion` vuelve a pedir los
 * datos, porque la fila del día es la medición y no puede nacer de una foto de
 * hace dos minutos ni heredar un `fueraVentana` calculado antes de que la ventana
 * abriera. En `globalThis` porque Next recarga módulos en desarrollo.
 */
const VISTA_TTL_MS = 120_000;

interface EntradaVista { at: number; obs: Observacion }
const vistaCache: Map<string, EntradaVista> =
  (globalThis as { __scalpingVista?: Map<string, EntradaVista> }).__scalpingVista ??
  ((globalThis as { __scalpingVista?: Map<string, EntradaVista> }).__scalpingVista = new Map());

export async function observarParaVista(ticker: string, now: Date): Promise<Observacion> {
  const clave = `${ticker.trim().toUpperCase()}|${marketDateStr(now)}`;
  const ya = vistaCache.get(clave);
  if (ya && now.getTime() - ya.at < VISTA_TTL_MS) return ya.obs;

  const obs = await observar(ticker, now);
  vistaCache.set(clave, { at: now.getTime(), obs });
  return obs;
}

/** Anota y guarda. Si el día ya estaba anotado, devuelve el existente sin tocarlo. */
export async function anotarSesion(ticker: string, now: Date): Promise<ResultadoAnotar> {
  return anotar(await observar(ticker, now));
}

/** Califica una sesión ya cerrada contra las velas de 5 minutos de ese día. */
export async function calificarSesion(
  o: Observacion,
  now: Date,
): Promise<{ ok: boolean; nota: string; cierre: Calificacion | null }> {
  let bars;
  try {
    bars = await loadTfBars(o.ticker, TF_SESION);
  } catch (e) {
    return { ok: false, nota: `Sin velas para ${o.ticker}: ${(e as Error).message}`, cierre: null };
  }

  const sesion = velasDeSesion(bars, o.fecha);
  if (sesion.length === 0) {
    // El timeframe guarda 5 días: pasada esa ventana la sesión ya no se puede
    // calificar. Se dice en claro en vez de dejar la fila pendiente para siempre.
    return {
      ok: false,
      nota: `No quedan velas de ${o.fecha} para ${o.ticker} (el histórico de 5m cubre 5 días).`,
      cierre: null,
    };
  }

  const cierre = calificar(o, sesion, now);
  if (!cierre) return { ok: false, nota: "No se pudo calificar.", cierre: null };

  const escrita = await calificarEnDisco(o.ticker, o.fecha, cierre);
  return {
    ok: escrita,
    nota: escrita ? "" : "Esa sesión ya tenía veredicto.",
    cierre,
  };
}

export interface TickResultado {
  fecha: string;
  fase: Fase;
  anotadas: string[];
  yaEstaban: string[];
  calificadas: string[];
  fallos: string[];
}

/**
 * Un paso de la bitácora: anota lo que falte de HOY y califica lo que quedó
 * pendiente de días anteriores.
 *
 * Es idempotente a propósito: la tarea programada lo llama varias veces dentro de
 * la ventana de apertura, y repetirla no debe reescribir nada. Que la ventana sea
 * ancha y el paso idempotente es lo que hace que un arranque tarde del portátil
 * no cueste el día.
 *
 * El paso AUTOMÁTICO no anota fuera de la ventana. La tarea se dispara cada diez
 * minutos hasta después del cierre, y sin esta puerta llenaría la bitácora de
 * filas tardías —niveles dibujados a las 15:50, viendo el precio— que además
 * ocuparían el hueco del día y bloquearían la anotación buena de mañana.
 * Anotar tarde a mano sigue siendo posible; hacerlo solo, no.
 */
export async function tickBitacora(tickers: string[], now: Date): Promise<TickResultado> {
  const fecha = marketDateStr(now);
  const fase = faseDelDia(etMinutes(now));
  const res: TickResultado = { fecha, fase, anotadas: [], yaEstaban: [], calificadas: [], fallos: [] };

  if (fase === "anotar") {
    for (const t of tickers) {
      try {
        const r = await anotarSesion(t, now);
        if (r.guardada) res.anotadas.push(`${t} (${r.observacion.luz})`);
        else res.yaEstaban.push(t);
      } catch (e) {
        res.fallos.push(`${t}: ${(e as Error).message}`);
      }
    }
  }

  for (const o of await pendientes(fecha)) {
    try {
      const r = await calificarSesion(o, now);
      if (r.ok && r.cierre) res.calificadas.push(`${o.ticker} ${o.fecha} → ${r.cierre.veredicto}`);
      else if (r.nota) res.fallos.push(r.nota);
    } catch (e) {
      res.fallos.push(`${o.ticker} ${o.fecha}: ${(e as Error).message}`);
    }
  }

  return res;
}

/** La bitácora completa, más reciente primero. */
export async function bitacora(): Promise<Observacion[]> {
  const todas = await cargar();
  return todas.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.ticker.localeCompare(b.ticker));
}
