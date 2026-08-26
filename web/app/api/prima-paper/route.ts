// Paper trading de VENTA DE PRIMA dentro de Tito.
//
//   GET                    → estado de la cuenta (abiertas + libro + resumen)
//   POST {action:"manage"} → re-cotiza las abiertas y aplica las reglas de salida
//   POST {action:"scan"}   → pasada de observación 10:30-11:30: escanea y apunta,
//                            pero NO abre. Mide persistencia y caza fallos pronto.
//   POST {action:"open"}   → escanea y abre (SOLO lunes/martes; el motor lo comprueba)
//   POST {action:"preview"}→ ENSAYO: escanea y decide, pero NO escribe nada
//
// Cierra el traslado desde el bot Python: la estrategia ya vivía en
// `lib/creditSpread.ts`; esto trae la ejecución. Nada mueve dinero real.
//
// El escaneo de apertura es CARO (103 símbolos × cadena), así que solo corre cuando
// se pide explícitamente `open`, nunca en el GET que pinta la pantalla.

import { MassiveError } from "@/lib/massive";
import { fetchOptionChain2, MarketSnackError } from "@/lib/marketsnack";
import { dteOf, normalizeChain2, type Chain2Contract } from "@/lib/optionChain2";
import { DTE_MAX, type SpreadCandidate } from "@/lib/creditSpread";
import { SPREAD_UNIVERSE } from "@/lib/spreadUniverse";
import { addDaysStr, cachedMacroCalendar, macroEventsInWindow } from "@/lib/macroCalendar";
import { addPass, candidateKey, filterByPersistence, loadWatch, noWindow } from "@/lib/primaWatchStore";
import { sendAlert } from "@/lib/telegram";
import { primaClosedText, primaNotOpenedText, primaOpenedText, type PrimaNoOpenInfo } from "@/lib/alertText";
import { fetchWindowQuotes, fetchWindowQuotesTt, scanSymbol, type QuotesResult } from "@/lib/spreadScan";
import {
  fetchTastytradeChain, fetchQuoteToken, tastytradeConfigured,
  type QuoteToken, type TtContract,
} from "@/lib/tastytrade";
import type { SpreadQuote } from "@/lib/creditSpread";
import {
  RISK_PER_TRADE_MAX_PCT,
  START_EQUITY, closePosition, managePosition, planOpen, positionFrom,
  reprice, sizeFor, sizeForBand, summarize, type PrimaPosition,
} from "@/lib/primaPaper";
import { repriceFromChain } from "@/lib/primaReprice";
import { commit, loadClosed, loadOpen, saveOpen } from "@/lib/primaPaperStore";


/**
 * El ejecutor de paper escanea en MODO EXPERTO (2026-08-24, decisión del dueño).
 *
 * Corría en modo seguro y en una semana entera no abrió ni una posición: los
 * filtros de contexto (macro, tendencia, nivel guardián, 1σ) descartaban todo, y
 * un simulador que nunca opera no mide nada. Además medía una estrategia DISTINTA
 * de la que el dueño mira en pantalla, que usa /spreads en experto.
 *
 * Lo que esto relaja son SOLO los filtros de contexto de mercado; la banda 4–7
 * DTE, el delta corto 0.10–0.15, el ancho y toda la liquidez de la pata corta
 * siguen bloqueando igual. Cada posición guarda `expert` para que, si algún día
 * se vuelve al modo seguro, el win rate no mezcle dos regímenes distintos.
 */
const PAPER_EXPERT = true;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Concurrencia del escaneo. Igual que /spreads: MarketSnack no agradece más. */
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** TtContract → Chain2Contract (la forma que espera repriceFromChain). */
function ttToChain2(c: TtContract): Chain2Contract {
  return {
    symbol: "",
    type: c.type, strike: c.strike, expiration: c.expiration,
    bid: c.bid, ask: c.ask,
    mid: c.bid != null && c.ask != null ? (c.bid + c.ask) / 2 : null,
    delta: c.delta, gamma: c.gamma, theta: null, vega: null,
    iv: c.iv, openInterest: c.openInterest, volume: c.volume,
    premiumTraded: 0, lastPrice: c.last,
  };
}

/** Cadena de un vencimiento para re-cotizar, con cascada Tastytrade → MarketSnack. */
async function chainForReprice(
  ticker: string, expiration: string, now: Date, ttToken?: QuoteToken,
): Promise<Chain2Contract[]> {
  if (ttToken) {
    try {
      const dte = dteOf(expiration, now);
      const { contracts } = await fetchTastytradeChain(ticker, {
        dteMin: Math.max(0, dte - 1), dteMax: dte + 1, quoteToken: ttToken,
      });
      const c2 = contracts.map(ttToChain2);
      if (c2.some((c) => c.expiration === expiration)) return c2;
    } catch {
      // cae a MarketSnack
    }
  }
  return normalizeChain2(await fetchOptionChain2(ticker, expiration));
}

/**
 * fetchQuotes del escaneo de apertura, con cascada Tastytrade → MarketSnack.
 * Tastytrade trae además el SPOT en la misma respuesta; MarketSnack no, y quien
 * escanea cae entonces a Massive para el precio (caro: 5 peticiones/minuto).
 */
function makeFetchQuotes(ttToken?: QuoteToken): (t: string, n: Date) => Promise<QuotesResult> {
  if (!ttToken) return fetchWindowQuotes;
  return async (t, n) => {
    try { const r = await fetchWindowQuotesTt(t, n, ttToken); if (r.quotes.length > 0) return r; } catch { /* fallback */ }
    try { return await fetchWindowQuotes(t, n); } catch { return { quotes: [], spot: null }; }
  };
}

/** Un solo api-quote-token para todo el pase (reprice o escaneo). undefined si no aplica. */
async function scanToken(): Promise<QuoteToken | undefined> {
  return tastytradeConfigured() ? fetchQuoteToken().catch(() => undefined) : undefined;
}

// ---------------------------------------------------------------------------
// GET — estado
// ---------------------------------------------------------------------------

export async function GET() {
  const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);
  return Response.json({
    ok: true,
    summary: summarize(closed, open, START_EQUITY),
    open: open.filter((p) => p.status === "abierta"),
    closed: closed.slice(-60).reverse(), // lo más reciente primero
  });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido." }, { status: 400 });
  }

  try {
    if (body.action === "manage") return await doManage();
    if (body.action === "open") return await doOpen();
    if (body.action === "scan") return await doScan();
    if (body.action === "preview") return await doPreview();
    return Response.json({ ok: false, error: "action debe ser 'scan', 'preview', 'open' o 'manage'." }, { status: 400 });
  } catch (err) {
    const msg =
      err instanceof MarketSnackError || err instanceof MassiveError
        ? err.message
        : err instanceof Error ? err.message : "Error inesperado.";
    return Response.json({ ok: false, error: msg }, { status: 502 });
  }
}

/** Re-cotiza las abiertas y aplica las reglas. Barato: una cadena por posición. */
async function doManage() {
  const now = new Date();
  const abiertas = (await loadOpen()).filter((p) => p.status === "abierta");
  if (abiertas.length === 0) {
    return Response.json({ ok: true, managed: 0, closed: [], notes: ["Sin posiciones abiertas."] });
  }

  const notes: string[] = [];
  const siguen: PrimaPosition[] = [];
  const cerradas: PrimaPosition[] = [];
  const ttToken = await scanToken(); // un token para todas las re-cotizaciones

  await mapLimit(abiertas, CONCURRENCY, async (p) => {
    let actualizada = p;
    try {
      const chain = await chainForReprice(p.ticker, p.expiration, now, ttToken);
      const r = repriceFromChain(p, chain);
      if (r.currentValue == null) {
        // Sin precio NO se decide: aplicar una regla sobre un valor rancio podría
        // cerrar una posición sana. Se deja como está y se avisa.
        notes.push(`${p.ticker}: no se pudo re-cotizar (${r.problem}). Se mantiene sin evaluar.`);
        siguen.push(p);
        return;
      }
      actualizada = reprice(p, r.currentValue, r.shortDelta ?? undefined);
    } catch (e) {
      notes.push(`${p.ticker}: fallo al pedir la cadena (${e instanceof Error ? e.message : "?"}). Se mantiene.`);
      siguen.push(p);
      return;
    }

    const d = managePosition(actualizada, now);
    if (d.action === "cerrar") {
      cerradas.push(closePosition(actualizada, d.reason, now));
      notes.push(`${p.ticker}: CERRADA — ${d.reason}`);
    } else {
      if (d.action === "avisar") notes.push(`${p.ticker}: ⚠ ${d.reason}`);
      siguen.push(actualizada);
    }
  });

  await commit(siguen, cerradas);
  const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);

  // Un aviso por cierre: son eventos sueltos en el tiempo, no una tanda.
  if (cerradas.length > 0) {
    const eq = summarize(closed, open, START_EQUITY).equity;
    for (const c of cerradas) void sendAlert(primaClosedText(c, eq)).catch(() => null);
  }

  return Response.json({
    ok: true,
    managed: abiertas.length,
    closed: cerradas.map((c) => ({ ticker: c.ticker, pnl: c.realizedPnl, reason: c.closeReason })),
    notes,
    summary: summarize(closed, open, START_EQUITY),
  });
}

/**
 * Escanea los 103 símbolos. Copia ÚNICA: la usan la pasada de observación
 * (10:30-11:30) y el disparo de apertura (11:45). Si cada una montara la suya,
 * la ventana previa acabaría mirando un universo distinto del que abre, y la
 * persistencia que se mide no diría nada.
 */
async function escanearUniverso(now: Date, macroEvents: ReturnType<typeof macroEventsInWindow>) {
  const candidatos: SpreadCandidate[] = [];
  const fallos: string[] = [];
  let escaneados = 0;

  const ttToken = await scanToken(); // un token para todo el escaneo
  const fetchQuotes = makeFetchQuotes(ttToken);

  await mapLimit(SPREAD_UNIVERSE, CONCURRENCY, async (sym) => {
    const r = await scanSymbol(sym, { now, macroEvents, bias: "neutral", expert: PAPER_EXPERT, fetchQuotes });
    if (!r.ok) { fallos.push(`${sym.ticker}: ${r.reason}`); return; }
    escaneados += 1;
    candidatos.push(...r.scan.candidates);
  });

  return { candidatos, escaneados, fallos };
}

/**
 * Pasada de OBSERVACIÓN (10:30-11:30 ET). Escanea y apunta lo que ve, pero NO
 * abre nada — de eso se encarga el disparo de las 11:45.
 *
 * Su valor no es solo poder mirar: si la cookie caducó o Tastytrade no responde,
 * aquí se ve una hora antes y da tiempo a arreglarlo, en vez de descubrirlo con
 * la ventana semanal ya perdida.
 */
async function doScan() {
  const now = new Date();

  const macro = await cachedMacroCalendar(now);
  if (!macro) {
    return Response.json({
      ok: false,
      error: "No hay calendario macro (FRED falló y no hay cache). La pasada de observación no puede filtrar.",
    }, { status: 503 });
  }
  const today = now.toISOString().slice(0, 10);
  const macroEvents = macroEventsInWindow(macro.events, today, addDaysStr(today, DTE_MAX));

  const { candidatos, escaneados, fallos } = await escanearUniverso(now, macroEvents);
  const keys = candidatos.map(candidateKey);
  const book = await addPass(
    { at: now.toISOString(), scanned: escaneados, failed: fallos.length, keys },
    now,
  );

  // Se devuelve la persistencia acumulada del día: es lo que hace útil tener
  // varias pasadas en vez de una.
  const cuenta = new Map<string, number>();
  for (const p of book.passes) for (const k of p.keys) cuenta.set(k, (cuenta.get(k) ?? 0) + 1);

  return Response.json({
    ok: true,
    pass: book.passes.length,
    scanned: escaneados,
    failed: fallos.length,
    candidates: candidatos.length,
    top: [...cuenta.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([key, seen]) => ({ key, seen })),
    failures: fallos.slice(0, 10),
  });
}


/**
 * ENSAYO de la apertura: corre el escaneo y la selección COMPLETOS y responde qué
 * abriría, sin tocar el libro.
 *
 * Existe porque la pregunta "¿de verdad abriría acciones y no solo índices?" no se
 * puede contestar disparando la apertura de verdad: fuera de la ventana 10:30-12:00
 * ET las horquillas se disparan y el crédito que quedaría registrado no existe —
 * ensuciar la cuenta para comprobar algo es exactamente lo contrario de medir.
 *
 * Salta SOLO la puerta de día y hora (`ignoreWindow`). Todo lo demás —persistencia,
 * topes de cartera, sizing por la banda 2-3%— se aplica igual, así que lo que sale
 * aquí es lo que abriría con estos datos. Lo que NO se puede simular es el mercado:
 * con la sesión cerrada las primas son las del último cruce, así que los créditos
 * son orientativos.
 */
async function doPreview() {
  const now = new Date();

  const macro = await cachedMacroCalendar(now);
  if (!macro) {
    return Response.json({ ok: false, error: "No hay calendario macro: el ensayo no puede filtrar igual que la apertura." }, { status: 503 });
  }
  const today = now.toISOString().slice(0, 10);
  const macroEvents = macroEventsInWindow(macro.events, today, addDaysStr(today, DTE_MAX));

  const abiertas = (await loadOpen()).filter((p) => p.status === "abierta");
  const { candidatos, escaneados, fallos } = await escanearUniverso(now, macroEvents);

  const watch = await loadWatch(now);
  const { passing: persistentes, dropped, required, seen } = filterByPersistence(candidatos, watch);

  const equity = summarize(await loadClosed(), abiertas, START_EQUITY).equity;
  const plan = planOpen(persistentes, abiertas, now, { ignoreWindow: true });

  const abriria: unknown[] = [];
  const noCaben: unknown[] = [];
  for (const c of plan.chosen) {
    const { contracts, riskPct } = sizeForBand(c, equity);
    if (contracts < 1) {
      noCaben.push({
        ticker: c.ticker, width: c.economics.width,
        riesgo: Math.round(c.economics.maxRisk),
        necesita: Math.round(c.economics.maxRisk / RISK_PER_TRADE_MAX_PCT),
      });
      continue;
    }
    abriria.push({
      ticker: c.ticker, sector: c.sector, type: c.type,
      short: c.shortLeg.strike, long: c.longLeg.strike, width: c.economics.width,
      contracts, riskPct, credit: c.economics.credit, maxRisk: c.economics.maxRisk,
      pop: Math.round(c.stats.probOtmPct), seenInPasses: seen.get(candidateKey(c)) ?? 0,
    });
  }

  /**
   * Dimensionado de TODOS los candidatos, antes de la compuerta de persistencia.
   *
   * Va aparte a propósito: "¿esto abriría acciones o solo índices?" es una pregunta
   * sobre el TAMAÑO, y mezclarla con la persistencia la deja sin respuesta — fuera de
   * la ventana 10:30-11:30 los strikes de ahora no son los que se apuntaron entonces,
   * así que todo cae por persistencia y el desglose de tamaño no llegaría a verse.
   * `antes` es lo que daba la regla vieja (2% clavado); `ahora`, la banda 2-3%.
   */
  const dimensionado = candidatos.map((c) => {
    const { contracts, riskPct } = sizeForBand(c, equity);
    return {
      ticker: c.ticker, sector: c.sector, type: c.type,
      short: c.shortLeg.strike, long: c.longLeg.strike,
      width: c.economics.width, maxRisk: Math.round(c.economics.maxRisk),
      antes: sizeFor(c, equity), ahora: contracts,
      riskPct: Math.round(riskPct * 10000) / 100,
    };
  });

  return Response.json({
    ok: true,
    ensayo: true,
    aviso: "ENSAYO — no se ha escrito nada. Con el mercado cerrado las primas son del último cruce.",
    equity,
    dimensionado: {
      operables: dimensionado.filter((d) => d.ahora >= 1).length,
      rescatados: dimensionado.filter((d) => d.antes === 0 && d.ahora >= 1).length,
      sinSitio: dimensionado.filter((d) => d.ahora === 0).length,
      detalle: dimensionado,
    },
    scanned: escaneados,
    candidates: candidatos.length,
    watchPasses: watch.passes.length,
    requiredSeen: required,
    persistent: persistentes.length,
    droppedByPersistence: dropped,
    abriria,
    noCaben,
    skipped: plan.skipped,
    blocked: plan.blocked,
    failures: fallos.slice(0, 10),
  });
}


/**
 * Avisa de que HOY NO se abrió nada, y por qué.
 *
 * El silencio era ambiguo: la alerta solo salía con posiciones nuevas, así que un
 * lunes sin aperturas se leía igual que un lunes en que la cookie estaba muerta o la
 * ventana de observación no corrió. Best-effort como el resto de avisos — un aviso
 * que falla no debe tumbar la respuesta.
 */
function avisarNoAbrio(info: PrimaNoOpenInfo): void {
  void sendAlert(primaNotOpenedText(info)).catch(() => null);
}

/** Escanea el universo y abre lo que toque. SOLO lunes (lo decide `planOpen`). */
async function doOpen() {
  const now = new Date();

  // Se comprueba el día ANTES de escanear: 103 cadenas es caro y en martes no sirve.
  const abiertasPrev = (await loadOpen()).filter((p) => p.status === "abierta");
  const preflight = planOpen([], abiertasPrev, now);
  if (preflight.blocked && !preflight.blocked.includes("ningún candidato")) {
    // El bloqueo por DÍA no se avisa: la tarea solo corre lunes y martes, así que
    // "hoy es domingo" solo aparece si alguien la dispara a mano. Lo demás SÍ —
    // quedarse fuera de la ventana significa perder la ventana semanal.
    if (!preflight.blocked.includes("solo se abre los")) {
      avisarNoAbrio({
        motivo: `No se abrió: ${preflight.blocked}.`,
        accionable: preflight.blocked.includes("ventana"),
        yaAbiertas: abiertasPrev.map((p) => p.ticker),
        equity: summarize(await loadClosed(), abiertasPrev, START_EQUITY).equity,
      });
    }
    return Response.json({ ok: true, opened: [], scanned: 0, blocked: preflight.blocked });
  }

  // Ventana de observación: si no corrió, NO se abre. Se comprueba ANTES de
  // escanear por lo mismo que el día: 103 cadenas es caro y un escaneo que no
  // puede abrir nada es tiempo y cuota tirados. Decisión del dueño: sin las
  // pasadas de 10:30-11:30 no hay evidencia de persistencia, y sin evidencia no
  // se opera.
  const watch = await loadWatch(now);
  if (noWindow(watch)) {
    avisarNoAbrio({
      motivo:
        "No se abrió: no hubo ventana de observación (10:30-11:30 ET). La tarea Prima-Scan no corrió, así que no hay evidencia de persistencia y no se opera a ciegas. Revísala.",
      accionable: true,
      yaAbiertas: abiertasPrev.map((p) => p.ticker),
      equity: summarize(await loadClosed(), abiertasPrev, START_EQUITY).equity,
    });
    return Response.json({
      ok: true,
      opened: [],
      scanned: 0,
      watchPasses: 0,
      blocked: "Sin ventana de observación (10:30-11:30 ET): no se abre sin evidencia de persistencia.",
    });
  }

  // Calendario macro: si no hay, se BLOQUEA. No se abre a ciegas (mismo criterio
  // que /spreads: un CPI o un FOMC dentro de la semana cambia el riesgo por completo).
  const macro = await cachedMacroCalendar(now);
  if (!macro) {
    avisarNoAbrio({
      motivo:
        "No se abrió: no hay calendario macro (FRED falló y no hay cache). Sin saber si hay CPI o FOMC en la ventana no se opera a ciegas.",
      accionable: true,
      yaAbiertas: abiertasPrev.map((p) => p.ticker),
    });
    return Response.json({
      ok: false,
      error: "No hay calendario macro (FRED falló y no hay cache). No se abre a ciegas.",
    }, { status: 503 });
  }
  const today = now.toISOString().slice(0, 10);
  const macroEvents = macroEventsInWindow(macro.events, today, addDaysStr(today, DTE_MAX));

  const { candidatos, escaneados, fallos } = await escanearUniverso(now, macroEvents);

  // ── COMPUERTA DE PERSISTENCIA ──
  // Va ANTES de `planOpen` a propósito: el ranking por POP tiene que hacerse
  // sobre lo que de verdad puede abrirse. Filtrar después dejaría huecos —
  // elegiría 5, descartaría 3 por persistencia y abriría 2, en vez de coger los
  // 5 mejores DE ENTRE los persistentes.
  const { passing: persistentes, dropped: descartadosPorPersistencia, required: requerido, seen: vistas } =
    filterByPersistence(candidatos, watch);

  const equity = summarize(await loadClosed(), abiertasPrev, START_EQUITY).equity;
  const plan = planOpen(persistentes, abiertasPrev, now);

  const nuevas: PrimaPosition[] = [];
  /**
   * Candidatos que pasaron TODO y aun así no caben en el capital.
   *
   * Antes esto era un `continue` mudo y costó caro: el 2026-08-24 se abrieron 2 de 16
   * candidatos válidos y el log decía "abiertas 2" sin más, así que parecía que el
   * motor prefería los índices cuando lo que pasaba es que los demás no cabían. Un
   * tope que no se reporta se lee como una decisión de estrategia.
   */
  const noCaben: { ticker: string; riesgo: number; necesita: number }[] = [];

  for (const c of plan.chosen) {
    const { contracts, riskPct } = sizeForBand(c, equity);
    if (contracts < 1) {
      // Capital que haría falta para que UNO entrara por el tope del mandato.
      noCaben.push({
        ticker: c.ticker,
        riesgo: Math.round(c.economics.maxRisk),
        necesita: Math.round(c.economics.maxRisk / RISK_PER_TRADE_MAX_PCT),
      });
      continue;
    }
    nuevas.push(positionFrom(
      c, contracts, `VP-${Date.now()}-${nuevas.length}`, now, PAPER_EXPERT,
      vistas.get(candidateKey(c)) ?? 0, riskPct,
    ));
  }

  if (nuevas.length > 0) {
    await saveOpen([...abiertasPrev, ...nuevas]);
    // Aviso best-effort: una posición bien abierta cuyo mensaje falla sigue
    // siendo una posición bien abierta, así que no se espera ni se propaga error.
    const eq = summarize(await loadClosed(), [...abiertasPrev, ...nuevas], START_EQUITY).equity;
    void sendAlert(primaOpenedText(nuevas, eq)).catch(() => null);
  } else {
    // El escaneo corrió y aun así no entró nada: se dice CUÁL de los tres embudos
    // lo paró. Sin esto, "no llegó nada al móvil" y "el agente decidió no operar"
    // se leen igual, que es el fallo mudo que se viene cerrando.
    const motivo =
      candidatos.length === 0
        ? "No se abrió: el escaneo no encontró ningún candidato que pasara los filtros. Es una salida válida, no un fallo."
        : persistentes.length === 0
          ? `No se abrió: ninguno de los ${candidatos.length} candidatos aguantó la ventana de observación.`
          : noCaben.length > 0 && noCaben.length === plan.chosen.length
            ? `No se abrió: los ${noCaben.length} elegidos no caben en el capital.`
            : `No se abrió: ${plan.blocked ?? "ningún candidato llegó a abrirse"}.`;

    avisarNoAbrio({
      motivo,
      escaneados,
      candidatos: candidatos.length,
      persistentes: persistentes.length,
      requeridas: requerido,
      pasadas: watch.passes.length,
      noCaben,
      yaAbiertas: abiertasPrev.map((p) => p.ticker),
      equity,
    });
  }

  const [open, closed] = await Promise.all([loadOpen(), loadClosed()]);
  return Response.json({
    ok: true,
    scanned: escaneados,
    candidates: candidatos.length,
    watchPasses: watch.passes.length,
    requiredSeen: requerido,
    persistent: persistentes.length,
    droppedByPersistence: descartadosPorPersistencia,
    opened: nuevas.map((p) => ({ ticker: p.ticker, type: p.type, short: p.shortStrike, long: p.longStrike, contracts: p.contracts, credit: p.entryCredit, pop: p.popPct, seenInPasses: p.seenInPasses, riskPct: p.riskPctUsed })),
    noCaben,
    skipped: plan.skipped,
    blocked: plan.blocked,
    failures: fallos.slice(0, 10),
    summary: summarize(closed, open, START_EQUITY),
  });
}
