"use client";

// Agente ODTE — cadena del vencimiento de hoy con los strikes de mayor
// volumen. Calls a la izquierda, strike al centro, puts a la derecha. Ver
// Agente Principal/Proceso 0DTE.md. Puerto del fork Agente0DTE, adaptado como
// pestaña de Prueba de Fuego. Selector de ticker real (SPX/SPY/QQQ/ES/NQ);
// el selector de idioma es solo visual — español fijo, ver zerodteTickers.ts.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainLine, ZeroDteResult } from "@/lib/pdf/zerodte";
import type { AggressorRead, ClassifiedFlow, NetAggressorTotals, VolumeVelocity } from "@/lib/pdf/zerodteFlow";
import type { ZeroDteSuggestions } from "@/lib/pdf/zerodteSuggestions";
import {
  DEFAULT_PARAMS, dynamicParams, evaluateEntry, gateEntry, noSetupReason, riskReward,
  type EntryDecision, type FlowCtx,
} from "@/lib/pdf/zerodteStrategy";
import {
  altOutlook, altTradeState, despinEstimate, flowWeight, gammaWalls, momentumEntry,
  type AltFlowCtx, type Lean as AltLean,
} from "@/lib/pdf/zerodteAlt";
import { pickTicket, TICKET_DEFAULTS, type Ticket, type TicketChainRow } from "@/lib/pdf/zerodteTicket";
import type { TopTrade } from "@/lib/pdf/zerodteStream";
import { unpinRead, type UnpinRead } from "@/lib/pdf/zerodteUnpin";
import { isFuturesMarketOpen, isMarketOpen } from "@/lib/pdf/marketHours";
import { ZERO_DTE_TICKERS, DEFAULT_ZERO_DTE_TICKER, type ZeroDteTickerId } from "@/lib/pdf/zerodteTickers";
import ZeroDteChart from "@/app/prueba-de-fuego/_components/ZeroDteChart";

interface AltEvalState {
  n: number; origRate: number | null; altRate: number | null;
  bothActive: number; altBetterWhenActive: number;
}
interface TradeEvalState {
  origResolved: number; origWins: number; origRate: number | null;
  altResolved: number; altWins: number; altRate: number | null;
  differed: number; differedWon: number;
}

const KEY_TICKER = "visionary.zeroDte.ticker";

interface FlowState {
  cycles: number;
  contracts: number;
  updatedAt?: string;
  reads: Record<string, AggressorRead>;
  netAggressor?: NetAggressorTotals;
  velocity?: VolumeVelocity;
  classified?: ClassifiedFlow;
  topTrades?: TopTrade[];
  error?: string;
}

/** Streamer vivo = escribió el acumulador hace poco — SIN importar si hubo
 *  trades nuevos (puede estar conectado y al día sin que nadie haya operado
 *  todavía, ej. fin de semana). Umbral generoso vs. el ciclo de 10s del
 *  streamer para tolerar reconexiones. */
const STREAM_ALIVE_MS = 3 * 60 * 1000;
function streamAliveNow(flow: FlowState | null): boolean {
  if (!flow?.updatedAt) return false;
  const ts = Date.parse(flow.updatedAt);
  return Number.isFinite(ts) && Date.now() - ts < STREAM_ALIVE_MS;
}

const KEY_MOC = "visionary.zeroDte.moc";

function etTodayForMoc(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

interface EvalState {
  empty?: boolean;
  message?: string;
  error?: string;
  maturedCount?: number;
  meanAbsErrorPct?: number | null;
  biasPct?: number | null;
  bullTouchRate?: number | null;
  bearTouchRate?: number | null;
  closingMeanAbsErrorPts?: number | null;
  closingHitRate?: number | null;
  closingCount?: number;
}

const REFRESH_MS = 60 * 1000;

const nf = new Intl.NumberFormat("en-US");
const num = (v: number | null | undefined) => (v == null ? "—" : nf.format(v));
const dec = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const money = (v: number | null | undefined) =>
  v == null ? "—" : `${v < 0 ? "-" : ""}$${nf.format(Math.abs(Math.round(v)))}`;

function pctIn(o: { rangeLow: number; rangeHigh: number }, price: number): number {
  const span = o.rangeHigh - o.rangeLow;
  if (span <= 0) return 50;
  return Math.max(0, Math.min(100, ((price - o.rangeLow) / span) * 100));
}
const rangePos = (o: { rangeLow: number; rangeHigh: number; spot: number }) => pctIn(o, o.spot);
const magnetPos = (o: { rangeLow: number; rangeHigh: number; magnet: number | null }) =>
  o.magnet == null ? 50 : pctIn(o, o.magnet);
const inRange = (o: { rangeLow: number; rangeHigh: number; magnet: number | null }) =>
  o.magnet != null && o.magnet >= o.rangeLow && o.magnet <= o.rangeHigh;

function etTodayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function expirationDays(count = 5): string[] {
  const out = [etTodayStr()];
  const d = new Date(`${etTodayStr()}T12:00:00Z`);
  while (out.length <= count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function dayLabel(date: string, i: number): string {
  if (i === 0) return "Hoy";
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `${WEEKDAYS[wd]} ${Number(date.slice(8, 10))}`;
}

/** Sesión abierta AHORA para el ticker dado: CME (~23h) para /ES y /NQ,
 *  RTH 9:30-16:00 ET para el resto. */
function marketOpenNow(ticker: ZeroDteTickerId = "SPX"): boolean {
  const nativeFuture = ZERO_DTE_TICKERS.find((t) => t.id === ticker)?.nativeFuture;
  return nativeFuture ? isFuturesMarketOpen() : isMarketOpen();
}

function sessionWindowLabel(ticker: ZeroDteTickerId): string {
  const nativeFuture = ZERO_DTE_TICKERS.find((t) => t.id === ticker)?.nativeFuture;
  return nativeFuture ? "domingo 6pm a viernes 5pm ET, CME" : "9:30-16:00 ET";
}

function etNowParts(): { min: number; isWeekday: boolean } {
  const now = new Date();
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24;
  const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
  return { min: h * 60 + m, isWeekday: wd !== "Sat" && wd !== "Sun" };
}
function etClock(): string {
  return new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
}

const CONFIDENCE: Record<string, string> = { baja: "baja", media: "media", alta: "alta" };

export default function AgenteOdteTab() {
  const [data, setData] = useState<ZeroDteResult | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [evalu, setEvalu] = useState<EvalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days] = useState<string[]>(() => expirationDays(5));
  const [selDate, setSelDate] = useState<string>(() => etTodayStr());
  const [selTicker, setSelTicker] = useState<ZeroDteTickerId>(DEFAULT_ZERO_DTE_TICKER);
  // MOC manual (el usuario pega el imbalance del tweet ~3:50pm). Solo cliente,
  // se resetea solo (por fecha ET) para no arrastrar el dato de ayer.
  const [mocVal, setMocVal] = useState<string>("");
  const [mocSide, setMocSide] = useState<"buy" | "sell" | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY_TICKER);
    if (saved && ZERO_DTE_TICKERS.some((t) => t.id === saved)) setSelTicker(saved as ZeroDteTickerId);
    try {
      const raw = window.localStorage.getItem(KEY_MOC);
      if (raw) {
        const m = JSON.parse(raw) as { val?: string; side?: "buy" | "sell" | null; date?: string };
        if (m.date === etTodayForMoc()) { setMocVal(m.val ?? ""); setMocSide(m.side ?? null); }
      }
    } catch { /* noop */ }
  }, []);

  const saveMoc = (val: string, side: "buy" | "sell" | null) => {
    setMocVal(val); setMocSide(side);
    try {
      window.localStorage.setItem(KEY_MOC, JSON.stringify({ val, side, date: etTodayForMoc() }));
    } catch { /* noop */ }
  };

  const pickTicker = useCallback((id: ZeroDteTickerId) => {
    setSelTicker(id);
    window.localStorage.setItem(KEY_TICKER, id);
  }, []);

  const load = useCallback(async (date: string, ticker: ZeroDteTickerId) => {
    setLoading(true);
    setError(null);
    const isToday = date === etTodayStr();

    let flowPromise: Promise<void> = Promise.resolve();
    if (isToday) {
      flowPromise = fetch(`/api/pdf/0dte/flow?ticker=${ticker}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setFlow(j as FlowState))
        .catch(() => setFlow(null));
      fetch(`/api/pdf/0dte/eval?ticker=${ticker}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setEvalu(j as EvalState))
        .catch(() => setEvalu(null));
    } else {
      setFlow(null);
      setEvalu(null);
    }

    try {
      const res = await fetch(
        `/api/pdf/0dte?date=${encodeURIComponent(date)}&ticker=${ticker}`, { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as ZeroDteResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
      setData(null);
    } finally {
      setLoading(false);
      await flowPromise;
    }
  }, []);

  useEffect(() => {
    load(selDate, selTicker);
    if (selDate !== etTodayStr()) return;
    const id = setInterval(() => load(selDate, selTicker), REFRESH_MS);
    return () => clearInterval(id);
  }, [selDate, selTicker, load]);

  // σ para los parámetros dinámicos: el de "hasta el cierre" (forecast) si está
  // disponible; si no, el de la ventana de GEX Pinning (closing, solo 3-4pm).
  const sigmaForParams = data?.forecast?.sigma ?? data?.closing?.sigma ?? null;
  const strategyParams = useMemo(
    () => (data?.spot != null ? dynamicParams(data.spot, sigmaForParams, selTicker) : DEFAULT_PARAMS),
    [data?.spot, sigmaForParams, selTicker],
  );

  const live = useMemo(() => {
    if (!data || !data.isToday || data.spot == null) return null;
    return evaluateEntry(data.spot, data.gex.regime, data.gex.kingStrike, data.gex.flipStrike, strategyParams);
  }, [data, strategyParams]);

  // --- 0DTE Live: contratos entrantes (solo si el streamer de Tastytrade está
  // vivo — ver streamer/tastytrade-stream.mjs + lib/zerodteStream.ts). Igual
  // que en el proyecto standalone: solo TAKERS (compra al ask / vende al bid);
  // el mid es pasivo y se descarta de la señal.
  const usd = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
  const gexUsd = (n: number) => {
    const s = n >= 0 ? "+" : "−"; const a = Math.abs(n);
    return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(0)}M` : `${s}$${Math.round(a)}`;
  };
  const allTop = flow?.topTrades ?? [];
  const takers = allTop.filter((t) => t.side === "buy" || t.side === "sell");
  const discMid = allTop.length - takers.length;
  const discClose = takers.filter((t) => !t.open).length;
  const hasGamma = takers.some((t) => typeof t.gamma === "number" && Number.isFinite(t.gamma));
  const impact = (t: TopTrade) => t.premium * (hasGamma ? Math.abs(Number(t.gamma) || 0) : 1);
  const opensAgg = takers.filter((t) => t.open);
  const sig = opensAgg.length ? opensAgg : takers;
  let ttBull = 0, ttBear = 0, callPrem = 0, putPrem = 0;
  for (const t of sig) {
    const isBull = (t.type === "call" && t.side === "buy") || (t.type === "put" && t.side === "sell");
    const isBear = (t.type === "put" && t.side === "buy") || (t.type === "call" && t.side === "sell");
    if (isBull) ttBull += t.premium; else if (isBear) ttBear += t.premium;
    if (t.type === "call") callPrem += t.premium; else putPrem += t.premium;
  }
  const ttTot = ttBull + ttBear;
  const ttBiasPct = ttTot > 0 ? Math.round((ttBull / ttTot) * 100) : null;
  const ttDir: "bull" | "bear" | "mixed" | "none" = ttBiasPct == null ? "none" : ttBiasPct >= 58 ? "bull" : ttBiasPct <= 42 ? "bear" : "mixed";
  const ttDom: "call" | "put" = callPrem >= putPrem ? "call" : "put";
  const ttSweeps = sig.filter((t) => t.sweep).length;
  const rollMap = new Map<string, { strike: number; type: "call" | "put"; imp: number; prem: number; n: number }>();
  for (const t of sig) {
    const key = `${t.strike}:${t.type}`;
    const r = rollMap.get(key) ?? { strike: t.strike, type: t.type, imp: 0, prem: 0, n: 0 };
    r.imp += impact(t); r.prem += t.premium; r.n += 1;
    rollMap.set(key, r);
  }
  const ttRollup = [...rollMap.values()].sort((a, b) => b.imp - a.imp).slice(0, 4);
  const ttRollMax = ttRollup[0]?.imp ?? 1;
  const impMaxRow = Math.max(1, ...takers.map(impact));
  const scoreOf = (t: TopTrade) => Math.round((impact(t) / impMaxRow) * 100);
  const ttFeed = [...takers].sort((a, b) => (b.sweep ? 1 : 0) - (a.sweep ? 1 : 0) || b.ts - a.ts).slice(0, 12);
  const ttSlActive = allTop.some((t) => t.slKnown);
  const ttMagnet = data?.gex?.kingStrike ?? null;
  const ttNetGex = data?.gex?.totalNetGex ?? null;
  const ttNetPos = (data?.gex?.regime ?? "positive") === "positive";
  const domStrikes = ttRollup.filter((r) => r.type === ttDom).map((r) => r.strike).sort((a, b) => a - b);
  const ttPile = domStrikes.length ? (domStrikes[0] === domStrikes[domStrikes.length - 1] ? `${domStrikes[0]}` : `${domStrikes[0]}–${domStrikes[domStrikes.length - 1]}`) : null;

  // Marca "nuevo" en el tape: compara contra el ts más nuevo visto en el ciclo anterior.
  const prevTopRef = useRef<{ ticker: string; newest: number } | null>(null);
  const [newTopTs, setNewTopTs] = useState<Set<number>>(new Set());
  useEffect(() => {
    const newest = allTop.length ? Math.max(...allTop.map((t) => t.ts)) : 0;
    const prev = prevTopRef.current;
    setNewTopTs(!prev || prev.ticker !== selTicker ? new Set() : new Set(ttFeed.filter((t) => t.ts > prev!.newest).map((t) => t.ts)));
    prevTopRef.current = { ticker: selTicker, newest };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, selTicker]);

  // Contexto de flujo para el gate en vivo y la capa alterna. burstBull/burstBear
  // usan el flujo REAL del streamer (premium $ de contratos entrantes) cuando está
  // vivo; si no, caen al flujo clasificado acumulado de MarketSnack (ver nota de
  // adaptación en lib/zerodteAlt.ts).
  const altCtx: AltFlowCtx | null = useMemo(() => {
    if (!data?.isToday || data.spot == null) return null;
    const streamLive = allTop.length > 0;
    return {
      regime: data.gex.regime,
      cvd: flow?.netAggressor?.net ?? null,
      cvdDom: flow?.classified?.cvdDom ?? null,
      velocity: flow?.velocity?.ratio ?? null,
      burstBull: streamLive ? ttBull : (flow?.classified?.bull ?? 0),
      burstBear: streamLive ? ttBear : (flow?.classified?.bear ?? 0),
      netGex: data.gex.totalNetGex,
      spot: data.spot,
      magnet: data.gex.kingStrike,
      sigma: sigmaForParams,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, flow, sigmaForParams, ttBull, ttBear]);

  const flowCtx: FlowCtx | null = altCtx && {
    cvd: altCtx.cvd, velocity: altCtx.velocity, burstBull: altCtx.burstBull, burstBear: altCtx.burstBear, netGex: altCtx.netGex,
  };

  const gate = useMemo(
    () => (live && flowCtx ? gateEntry(live, flowCtx, data?.gex.flipStrike ?? null, strategyParams) : null),
    [live, flowCtx, data?.gex.flipStrike, strategyParams],
  );

  const walls = useMemo(
    () => (data?.spot != null ? gammaWalls(data.gex.nodes, data.spot) : { callWall: null, putWall: null }),
    [data?.gex.nodes, data?.spot],
  );

  const gexLean: AltLean = !data?.isToday ? "lateral"
    : data.gex.regime === "negative" ? "lateral"
    : live ? (live.direction === "long" ? "alcista" : "bajista") : "lateral";
  const gexConf: "baja" | "media" = live && gate?.status === "ready" ? "media" : "baja";

  const altOut = altCtx ? altOutlook(gexLean, gexConf, altCtx) : null;

  const momentumTrade: EntryDecision | null = altCtx
    ? momentumEntry(altCtx, walls.callWall, walls.putWall, data?.gex.flipStrike ?? null)
    : null;

  const altState = altCtx
    ? altTradeState(altCtx, live, momentumTrade)
    : null;

  // Despin: si rompe el pin en la dirección del flujo, objetivo estimado
  // (muro de gamma o spot ± 1σ). Mostrado en la tarjeta alterna de GEX Pinning
  // cuando el flujo tiene lectura.
  const despin = data?.closing && data.spot != null
    ? despinEstimate(
        data.spot, data.forecast?.sigma ?? data.closing.sigma, altOut?.flowLean ?? "lateral",
        data.gex.regime, walls.callWall, walls.putWall,
      )
    : null;

  // GEX Unpin — solo /ES y /NQ (siguen cotizando 4-5pm ET, cuando SPX/NDX ya
  // cerraron). Se muestra SIEMPRE (como GEX Pinning): fuera de 3-5pm entra en
  // "waiting" con preview del sesgo; se arma 3-4pm y se juega 4-5pm.
  const isNativeFutureTicker = !!ZERO_DTE_TICKERS.find((t) => t.id === selTicker)?.nativeFuture;
  const unpin: UnpinRead | null = isNativeFutureTicker && data?.spot != null
    ? unpinRead({
        spot: data.spot,
        magnet: data.closing?.strike ?? data.gex.kingStrike ?? null,
        burstBull: ttBull, burstBear: ttBear,
        etMin: etNowParts().min, isWeekday: etNowParts().isWeekday,
        sessionOpen: marketOpenNow(selTicker),
        regime: data.gex.regime,
      })
    : null;

  // --- GEX Ticket: traduce el trade activo a un CONTRATO concreto (stop/target
  // en $, con delta+gamma). Fuente: γ+ → "Mejor trade ahora" LISTO; γ− → "Trade
  // alterno" de momentum ya confirmado.
  const ticketChain: TicketChainRow[] = useMemo(() => {
    if (!data?.lines) return [];
    return data.lines.flatMap((l) => {
      const out: TicketChainRow[] = [];
      const push = (r: typeof l.call, type: "call" | "put") => {
        if (r) out.push({
          strike: l.strike, type, bid: r.bid ?? null, ask: r.ask ?? null,
          delta: r.greeks?.delta ?? null, gamma: r.greeks?.gamma ?? null, iv: r.greeks?.iv ?? null,
          volume: r.volume, oi: r.openInterest,
        });
      };
      push(l.call, "call"); push(l.put, "put");
      return out;
    });
  }, [data?.lines]);
  const ticketReg = gate?.status === "ready" && live ? live : null;
  const ticketMom = !ticketReg && altState?.isMomentum && altState.trade ? altState.trade : null;
  const ticketTrade = ticketReg ?? ticketMom;
  const ticketIsMom = !!ticketMom;
  const ticketIdxRR = ticketTrade ? riskReward(ticketTrade) : 0;
  const ticket: Ticket | null = useMemo(
    () => (ticketTrade && data?.spot != null ? pickTicket(ticketTrade, data.spot, ticketChain, TICKET_DEFAULTS) : null),
    [ticketTrade, data?.spot, ticketChain],
  );

  // Registro comparativo (original vs alterna del "próximo tramo"). Se postea
  // el snapshot actual una vez por minuto; el panel muestra la evaluación
  // acumulada del día.
  const altSnapRef = useRef<{ ticker: string; spot: number; ol: AltLean; al: AltLean; w: number } | null>(null);
  const [altEval, setAltEval] = useState<AltEvalState | null>(null);
  useEffect(() => {
    const post = () => {
      const s = altSnapRef.current;
      if (!s) return;
      fetch("/api/pdf/0dte/alt-log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...s, sec: Math.floor(Date.now() / 1000) }),
      }).catch(() => {});
    };
    post();
    const id = setInterval(post, 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!data?.isToday) { setAltEval(null); return; }
    fetch(`/api/pdf/0dte/alt-log?ticker=${encodeURIComponent(selTicker)}`).then((r) => r.json()).then(setAltEval).catch(() => {});
  }, [data, selTicker]);

  // Registro comparativo de TRADES (Mejor trade ahora vs Trade alterno). Mismo
  // patrón: cada minuto se postea la señal activa de cada uno; el panel
  // muestra el win-rate.
  const tradeSnapRef = useRef<{
    ticker: string; spot: number;
    o: { d: "long" | "short"; tgt: number; stop: number } | null;
    a: { d: "long" | "short"; tgt: number; stop: number; m: boolean } | null;
  } | null>(null);
  const [tradeEvalState, setTradeEvalState] = useState<TradeEvalState | null>(null);
  useEffect(() => {
    const post = () => {
      const s = tradeSnapRef.current;
      if (!s) return;
      fetch("/api/pdf/0dte/trade-log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...s, sec: Math.floor(Date.now() / 1000) }),
      }).catch(() => {});
    };
    post();
    const id = setInterval(post, 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!data?.isToday) { setTradeEvalState(null); return; }
    fetch(`/api/pdf/0dte/trade-log?ticker=${encodeURIComponent(selTicker)}`).then((r) => r.json()).then(setTradeEvalState).catch(() => {});
  }, [data, selTicker]);

  const sessionOpenForLog = data?.isToday && marketOpenNow(selTicker);
  altSnapRef.current = sessionOpenForLog && altOut && data?.spot != null
    ? { ticker: selTicker, spot: data.spot, ol: gexLean, al: altOut.lean, w: altOut.w }
    : null;
  tradeSnapRef.current = sessionOpenForLog && data?.spot != null
    ? {
        ticker: selTicker, spot: data.spot,
        o: ticketReg ? { d: ticketReg.direction, tgt: ticketReg.target, stop: ticketReg.stop } : null,
        a: altState?.trade ? { d: altState.trade.direction, tgt: altState.trade.target, stop: altState.trade.stop, m: altState.isMomentum } : null,
      }
    : null;

  const prevDir = useRef<string | null>(null);
  const [justChanged, setJustChanged] = useState(false);
  useEffect(() => {
    if (!data?.isToday) { prevDir.current = null; return; }
    const dir = live ? live.direction : "none";
    setJustChanged(prevDir.current !== null && prevDir.current !== dir);
    prevDir.current = dir;
  }, [live, data?.isToday]);

  const maxVol = data
    ? Math.max(1, ...data.lines.flatMap((l) => [l.call?.volume ?? 0, l.put?.volume ?? 0]))
    : 1;

  const spot = data?.spot ?? null;
  const spotAt = data && spot != null ? data.lines.findIndex((l) => l.strike < spot) : -1;

  return (
    <div className="z-wrap">
      <style>{CSS}</style>

      <div className="z-disclaimer">⚠️ Recordatorio: esto es solo informativo, NO es consejo de inversión.</div>

      <header className="z-head">
        <div>
          <h1>Agente ODTE</h1>
          <p>
            {selDate === etTodayStr() ? "Vencimiento de hoy" : "Vencimiento futuro"} · los{" "}
            {data ? data.lines.length : "—"} strikes de mayor volumen (top 10 calls + top 10 puts)
          </p>
        </div>
        <div className="z-controls">
          <select
            value={selTicker}
            onChange={(e) => pickTicker(e.target.value as ZeroDteTickerId)}
            aria-label="Ticker"
          >
            {ZERO_DTE_TICKERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}{t.sublabel ? ` (${t.sublabel})` : ""}
              </option>
            ))}
          </select>
          <select defaultValue="es" aria-label="Idioma">
            <option value="es">ES Español</option>
            <option value="en" disabled>EN English (próximamente)</option>
          </select>
          <button onClick={() => load(selDate, selTicker)} disabled={loading}>
            {loading ? "Cargando…" : "Actualizar"}
          </button>
        </div>
      </header>

      <div className="z-daybar">
        <span className="z-daybar-lbl">Vencimiento</span>
        {days.map((d, i) => (
          <button
            key={d}
            className={`z-daychip ${d === selDate ? "z-daychip-on" : ""}`}
            onClick={() => setSelDate(d)}
            disabled={loading && d === selDate}
          >
            {dayLabel(d, i)}<em>{i}DTE</em>
          </button>
        ))}
      </div>

      {data && (
        <div className="z-meta">
          <span><b>{data.ticker}</b></span>
          <span>Spot <b>{dec(spot)}</b></span>
          <span>Vence <b>{data.expiration}</b></span>
          <span>{num(data.contractCount)} contratos en la cadena</span>
          <span className="z-time">
            {new Date(data.asOf).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET
          </span>
          {!data.delayed ? (
            <span className="z-fresh" title="Cotizaciones, griegos y open interest en vivo de tastytrade — toda la cadena, no solo lo que operó.">
              ⚡ cadena en tiempo real
            </span>
          ) : (
            <span className="z-flag">cadena con retraso</span>
          )}
        </div>
      )}

      {error && <div className="z-error">{error}</div>}

      {data && !data.isToday && (
        <div className="z-future">
          Vista de cadena a futuro (vence {data.expiration}). Se muestran el ranking por volumen y el
          GEX de ese vencimiento. El panorama de 5 min, los escenarios hasta el cierre y el agresor
          solo aplican al 0DTE de hoy.
        </div>
      )}

      {data?.isToday && (
        <section className={`z-ticket ${ticket ? `z-ticket-${ticketTrade!.direction}` : "z-ticket-idle"}`}>
          <header>
            <h2>GEX Ticket</h2>
            <span className="z-ticket-sub">contrato sugerido</span>
            {ticket && (
              <span className={`z-ticket-badge z-dir-${ticketTrade!.direction}`}>
                {ticketTrade!.direction === "long" ? "COMPRAR CALL" : "COMPRAR PUT"}
              </span>
            )}
          </header>
          {!marketOpenNow(selTicker) ? (
            <p className="z-live-msg">Mercado cerrado — sin contrato en vivo que sugerir.</p>
          ) : ticketTrade && ticket ? (
            <>
              <p className="z-ticket-thesis">
                {ticketIsMom ? "Momentum γ−: " : "Fade al imán γ+: "}
                {ticketTrade.direction === "long" ? "▲ LONG" : "▼ SHORT"} hacia {ticketTrade.target.toFixed(0)}, stop {dec(ticketTrade.stop)}.
              </p>
              <div className="z-ticket-buy">
                <span className="z-ticket-act">COMPRAR</span>
                <span className="z-ticket-ctr">{selTicker} {ticket.strike} {ticket.type === "call" ? "C" : "P"}</span>
                <span className="z-ticket-at">@ mid</span>
                <span className="z-ticket-price">${ticket.mid.toFixed(2)}</span>
                <span className="z-ticket-quote">bid {ticket.bid.toFixed(2)} / ask {ticket.ask.toFixed(2)}</span>
              </div>
              <div className="z-ticket-st">
                <div className="z-ticket-box">
                  <span className="z-ticket-k">Target</span>
                  <span className="z-ticket-v z-ticket-tgt">${ticket.targetPx.toFixed(2)}</span>
                  <span className="z-ticket-idx">índice en {ticketTrade.target.toFixed(0)} · <b className="z-ticket-up">+{(ticket.gainPct * 100).toFixed(0)}%</b></span>
                </div>
                <div className="z-ticket-box">
                  <span className="z-ticket-k">Stop</span>
                  <span className="z-ticket-v z-ticket-stp">${ticket.stopPx.toFixed(2)}</span>
                  <span className="z-ticket-idx">índice en {dec(ticketTrade.stop)} · <b className="z-ticket-dn">−{(ticket.lossPct * 100).toFixed(0)}%</b></span>
                </div>
                <div className="z-ticket-box">
                  <span className="z-ticket-k">R:B</span>
                  <span className="z-ticket-v">{ticket.rbOption.toFixed(1)}</span>
                  <span className="z-ticket-idx">vs {ticketIdxRR.toFixed(1)} del índice</span>
                </div>
              </div>
              <div className="z-ticket-meta">
                <span className="z-ticket-chip">Δ <b>{ticket.delta.toFixed(2)}</b></span>
                <span className="z-ticket-chip">Γ <b>{ticket.gamma.toFixed(3)}</b></span>
                {ticket.iv != null && <span className="z-ticket-chip">IV <b>{(ticket.iv * 100).toFixed(0)}%</b></span>}
                <span className="z-ticket-chip">vol <b>{ticket.volume.toLocaleString()}</b></span>
                <span className="z-ticket-chip">OI <b>{ticket.oi.toLocaleString()}</b></span>
                <span className="z-ticket-chip">spread <b>{(ticket.spreadPct * 100).toFixed(1)}%</b></span>
                <span className="z-ticket-chip">costo <b>${ticket.cost.toFixed(0)}</b></span>
                <span className="z-ticket-chip">riesgo <b>${ticket.risk.toFixed(0)}</b>/ct</span>
              </div>
              <p className="z-ticket-foot">
                Proyección lineal por delta+gamma, sin theta — la opción pierde valor con el
                tiempo aunque el índice no se mueva. Verifica bid/ask reales antes de operar.
              </p>
            </>
          ) : ticketTrade ? (
            <p className="z-ticket-none">
              Hay trade activo pero ningún contrato del top-20 por volumen pasa los filtros de
              delta (0.40-0.60), liquidez o riesgo máximo.
            </p>
          ) : (
            <p className="z-ticket-none">Sin trade listo ahora — sin contrato que sugerir.</p>
          )}
        </section>
      )}

      {data?.isToday && (
        <section className={`z-live ${live ? `z-live-${live.direction}` : "z-live-none"} ${justChanged ? "z-live-changed" : ""}`}>
          <header>
            <h2>GEX Trade <span className="z-live-sub">— de vuelta al imán</span></h2>
            {justChanged && <span className="z-live-alert">⚡ el setup cambió</span>}
            <span className="z-live-clock">{marketOpenNow(selTicker) ? `en vivo · ${etClock()} ET` : "mercado cerrado"}</span>
          </header>
          {!marketOpenNow(selTicker) ? (
            <p className="z-live-msg">
              Fuera de sesión ({sessionWindowLabel(selTicker)}). Durante el mercado abierto, el agente busca el mejor
              trade en vivo y lo actualiza cada minuto.
            </p>
          ) : live ? (
            <>
              <div className="z-live-row">
                <span className={`z-live-dir z-dir-${live.direction}`}>
                  {live.direction === "long" ? "▲ LONG" : "▼ SHORT"}
                </span>
                {gate && (
                  <span className={`z-gate-pill z-gate-${gate.status}`}>
                    {gate.status === "ready" ? "✓ LISTO" : "⏳ ESPERAR"}
                  </span>
                )}
                <div><span className="z-sum-lbl">Entrada (ahora)</span><b>{dec(live.entry)}</b></div>
                <div><span className="z-sum-lbl">Objetivo (imán)</span><b>{live.target}</b></div>
                <div><span className="z-sum-lbl">Stop</span><b>{dec(live.stop)}</b></div>
                <div><span className="z-sum-lbl">Riesgo / Beneficio</span><b>{riskReward(live).toFixed(1)} : 1</b></div>
              </div>
              <p className="z-live-reason">{gate && gate.status === "wait" ? gate.reason : live.reason}</p>
            </>
          ) : (
            <p className="z-live-msg">
              Sin setup ahora — {noSetupReason(data.spot, data.gex.regime, data.gex.kingStrike, strategyParams)}
            </p>
          )}
          <p className="z-outlook-caveat">
            Se recalcula cada minuto con el GEX en vivo. El agente calcula y muestra; tú decides y
            ejecutas. No es una orden ni un consejo.
          </p>
        </section>
      )}

      {data?.isToday && (
        <section className={`z-alt ${altState ? `z-alt-${altState.tier}` : ""}`}>
          <header>
            <h2>GEX Trade <span className="z-alt-suffix">· alterna</span></h2>
            {marketOpenNow(selTicker) && altState && (
              <span className={`z-alt-tier z-alt-tier-${altState.tier}`}>
                {altState.tier === "strong" ? "✓ flujo confirma" : altState.tier === "soft" ? "◐ sin confirmar" : "⏳ esperando"}
              </span>
            )}
            <span className="z-live-clock">{marketOpenNow(selTicker) ? `en vivo · ${etClock()} ET` : "mercado cerrado"}</span>
          </header>
          {!marketOpenNow(selTicker) || !altState || !altCtx ? (
            <p className="z-live-msg">
              Fuera de sesión ({sessionWindowLabel(selTicker)}). Durante el mercado abierto, el agente busca el mejor trade
              alterno en vivo y lo actualiza cada minuto.
            </p>
          ) : altState.trade ? (
            <>
              <div className="z-live-row">
                <span className={`z-live-dir z-dir-${altState.trade.direction}`}>
                  {altState.trade.direction === "long" ? "▲ LONG" : "▼ SHORT"}
                </span>
                <span className="z-alt-kind">{altState.isMomentum ? "momentum γ−" : "fade al imán γ+"}</span>
                <div><span className="z-sum-lbl">Entrada</span><b>{dec(altState.trade.entry)}</b></div>
                <div><span className="z-sum-lbl">Objetivo</span><b>{dec(altState.trade.target)}</b></div>
                <div><span className="z-sum-lbl">Stop</span><b>{dec(altState.trade.stop)}</b></div>
              </div>
              {altState.reversal && (
                <p className="z-alt-reversal">⚠️ El flujo está girando en contra de este trade — vigila la salida.</p>
              )}
              <p className="z-live-reason">{altState.trade.reason}</p>
            </>
          ) : (
            <p className="z-live-msg">
              {altCtx.regime === "negative"
                ? "γ− sin ruptura confirmada por el flujo todavía — el momentum necesita que el precio ya se haya movido a favor."
                : "Sin trade alterno ahora — el imán no tiene setup base o el flujo no aporta nada nuevo."}
            </p>
          )}
          <p className="z-outlook-caveat">
            Mezcla el imán del GEX con el flujo agresivo acumulado hoy (peso {altOut ? altOut.w.toFixed(2) : "—"}).{" "}
            {altOut?.flowNote}
          </p>
        </section>
      )}

      {data?.isToday && (
        <div className="z-cmp-row">
          <div className="z-cmp">
            <span className="z-cmp-tag">Alterna vs. original · próximos 5 min (hoy)</span>
            {altEval && altEval.n > 0 ? (
              <p className="z-cmp-line">
                Original acertó {altEval.origRate?.toFixed(0) ?? "—"}% · Alterna acertó{" "}
                {altEval.altRate?.toFixed(0) ?? "—"}% (de {altEval.n} lecturas maduradas).{" "}
                {altEval.bothActive > 0 && (
                  <>La alterna se apartó de la original {altEval.bothActive} veces; de esas, acertó ella sola {altEval.altBetterWhenActive}.</>
                )}
              </p>
            ) : (
              <p className="z-cmp-line z-cmp-wait">
                Recopilando… cada lectura se evalúa 5 min después. Mantén la página abierta durante la sesión.
              </p>
            )}
          </div>
          <div className="z-cmp">
            <span className="z-cmp-tag">Trade alterno vs. original · hoy</span>
            {tradeEvalState && (tradeEvalState.origResolved > 0 || tradeEvalState.altResolved > 0) ? (
              <p className="z-cmp-line">
                Original: {tradeEvalState.origWins}/{tradeEvalState.origResolved} ({tradeEvalState.origRate?.toFixed(0) ?? "—"}%) ·
                {" "}Alterna: {tradeEvalState.altWins}/{tradeEvalState.altResolved} ({tradeEvalState.altRate?.toFixed(0) ?? "—"}%).{" "}
                {tradeEvalState.differed > 0 && (
                  <>De {tradeEvalState.differed} trades de momentum γ− (que la original no tomó), ganó {tradeEvalState.differedWon}.</>
                )}
              </p>
            ) : (
              <p className="z-cmp-line z-cmp-wait">
                Midiendo en vivo — se llena cuando los trades tocan su target o stop.
              </p>
            )}
          </div>
        </div>
      )}

      {data?.isToday && flow && !flow.error && (
        <LiveVolumeCvd flow={flow} direction={live?.direction ?? null} />
      )}

      {data?.outlook && (
        <section className={`z-outlook z-lean-${data.outlook.lean}`}>
          <div className="z-outlook-top">
            <span className="z-outlook-tag">Sesgo GEX <span className="z-live-sub">próximos ~{data.outlook.horizonMinutes} min</span></span>
            <span className={`z-lean-chip z-lean-chip-${data.outlook.lean}`}>
              {data.outlook.lean === "alcista" ? "▲ sesgo alcista"
                : data.outlook.lean === "bajista" ? "▼ sesgo bajista"
                : "▬ lateral"}
            </span>
            <span className="z-conf">confianza {CONFIDENCE[data.outlook.confidence] ?? data.outlook.confidence}</span>
          </div>
          <p className="z-outlook-head">{data.outlook.headline}</p>
          <div className="z-outlook-range">
            <span>{dec(data.outlook.rangeLow)}</span>
            <div className="z-range-bar">
              <i className="z-range-fill" />
              <b className="z-range-now" style={{ left: `${rangePos(data.outlook)}%` }}>{dec(data.outlook.spot)}</b>
              {data.outlook.magnet != null && inRange(data.outlook) && (
                <span className="z-range-magnet" style={{ left: `${magnetPos(data.outlook)}%` }} title="Imán (mayor gamma)">
                  {data.outlook.magnet}
                </span>
              )}
            </div>
            <span>{dec(data.outlook.rangeHigh)}</span>
          </div>
          <p className="z-outlook-detail">{data.outlook.detail}</p>
          {(data.outlook.charmNote || data.outlook.vannaNote) && (
            <div className="z-flow">
              {data.outlook.charmNote && (
                <p className="z-flow-line">
                  <span className="z-flow-tag">CHARM</span>{" "}
                  {data.outlook.charmNote.replace(/^Charm \d+%: /, "")}
                  {data.outlook.charmIntensity != null && (
                    <span className="z-flow-bar"><i style={{ width: `${data.outlook.charmIntensity * 100}%` }} /></span>
                  )}
                </p>
              )}
              {data.outlook.vannaNote && (
                <p className="z-flow-line">
                  <span className="z-flow-tag">VANNA</span> {data.outlook.vannaNote.replace(/^Vanna: /, "")}
                </p>
              )}
            </div>
          )}
          <p className="z-outlook-caveat">
            Estimación probabilística a partir del posicionamiento de opciones — el rango es ~68%
            (±1σ). No es una certeza ni un consejo de inversión.
          </p>
        </section>
      )}

      {data?.outlook && altOut && (
        <section className={`z-outlook z-lean-${altOut.lean}`}>
          <div className="z-outlook-top">
            <span className="z-outlook-tag">
              Sesgo GEX <span className="z-live-sub">próximos ~{data.outlook.horizonMinutes} min</span>{" "}
              <span className="z-alt-suffix">· alterna</span>
            </span>
            <span className={`z-lean-chip z-lean-chip-${altOut.lean}`}>
              {altOut.lean === "alcista" ? "▲ sesgo alcista" : altOut.lean === "bajista" ? "▼ sesgo bajista" : "▬ lateral"}
            </span>
            <span className="z-conf">confianza {CONFIDENCE[altOut.confidence] ?? altOut.confidence}</span>
          </div>
          <p className="z-outlook-head">{data.outlook.headline}</p>
          <div className="z-outlook-range">
            <span>{dec(data.outlook.rangeLow)}</span>
            <div className="z-range-bar">
              <i className="z-range-fill" />
              <b className="z-range-now" style={{ left: `${rangePos(data.outlook)}%` }}>{dec(data.outlook.spot)}</b>
              {data.outlook.magnet != null && inRange(data.outlook) && (
                <span className="z-range-magnet" style={{ left: `${magnetPos(data.outlook)}%` }} title="Imán (mayor gamma)">
                  {data.outlook.magnet}
                </span>
              )}
            </div>
            <span>{dec(data.outlook.rangeHigh)}</span>
          </div>
          <p className="z-outlook-detail">{data.outlook.detail}</p>
          <div className="z-flow">
            <p className="z-flow-line"><span className="z-flow-tag z-flow-tag-flow">FLUJO</span> {altOut.flowNote}</p>
            {data.outlook.charmNote && (
              <p className="z-flow-line"><span className="z-flow-tag">CHARM</span> {data.outlook.charmNote.replace(/^Charm \d+%: /, "")}</p>
            )}
            {data.outlook.vannaNote && (
              <p className="z-flow-line"><span className="z-flow-tag">VANNA</span> {data.outlook.vannaNote.replace(/^Vanna: /, "")}</p>
            )}
          </div>
          <p className="z-outlook-caveat">
            Mezcla el sesgo del GEX con el flujo agresivo acumulado hoy — puede diferir del panel
            original cuando la cinta corre fuerte. No es una certeza ni un consejo de inversión.
          </p>
        </section>
      )}

      {data?.isToday && flow && !flow.error && (
        <section className="z-tt">
          <div className="z-tt-head">
            <span className="z-tt-tag">0DTE Live <span className="z-live-sub">top 10 entrantes</span></span>
            <span className="z-tt-inst">{data.ticker}{ttMagnet != null ? ` · imán ${ttMagnet}` : ""}</span>
            <span className="z-tt-takers"><b>⚡</b> solo takers</span>
            {!ttSlActive && allTop.length > 0 && <span className="z-tt-warn" title="Aún no se pudo confirmar single-leg de estos bloques">⚠ sin confirmar single-leg</span>}
          </div>

          {allTop.length === 0 ? (
            <div className="z-tt-empty">
              {streamAliveNow(flow)
                ? "Streamer conectado — sin contratos entrantes que califiquen todavía (normal fuera de sesión o recién arrancado)."
                : (
                  <>Sin streamer en vivo todavía — esta tarjeta necesita <code className="z-mono">streamer/tastytrade-stream.mjs</code> corriendo (websocket de tastytrade en tiempo real).</>
                )}
            </div>
          ) : (
            <>
              {ttNetGex != null && (
                <div className="z-tt-net">
                  <div className={`z-tt-net-val ${ttNetPos ? "pos" : "neg"}`}>
                    <span className="z-tt-net-lbl">Net GEX</span>
                    <span className="z-tt-net-num"><b>{gexUsd(ttNetGex)}</b> <span>{ttNetPos ? "γ+ ancla" : "γ− amplifica"}</span></span>
                  </div>
                  <div className="z-tt-net-read">
                    {ttNetPos ? `Los dealers tienden a anclar cerca del imán${ttMagnet != null ? ` ${ttMagnet}` : ""}.` : "Sin efecto de anclaje fiable — los movimientos se amplifican."}
                  </div>
                </div>
              )}

              <div className={`z-tt-summary z-tt-sum-${ttDir}`}>
                <div className="z-tt-sum-top">
                  <span className="z-tt-sum-word">
                    {ttDir === "bull" ? "▲ alcista" : ttDir === "bear" ? "▼ bajista" : ttDir === "mixed" ? "= mixto" : "sin sesgo"}
                  </span>
                  {ttBiasPct != null && <span className="z-tt-sum-chip">{ttDom === "call" ? "calls dominan" : "puts dominan"} · {ttBiasPct}%</span>}
                </div>
                <p className="z-tt-sum-line">
                  {usd(ttBull)} alcista vs {usd(ttBear)} bajista{ttPile ? `, concentrado en ${ttPile}` : ""}
                  {ttSweeps > 0 ? ` · ${ttSweeps} sweep${ttSweeps === 1 ? "" : "s"}` : ""}.
                </p>
              </div>

              {ttRollup.length > 0 && (
                <>
                  <div className="z-tt-sech">Strikes con más impacto</div>
                  <div className="z-tt-roll">
                    {ttRollup.map((r) => {
                      const isC = r.type === "call";
                      const score = Math.round((r.imp / ttRollMax) * 100);
                      return (
                        <div key={`${r.strike}:${r.type}`} className="z-tt-rollrow">
                          <span className="z-tt-roll-k" style={{ color: isC ? "var(--green)" : "var(--red)" }}>{r.strike} {isC ? "C" : "P"}</span>
                          <span className="z-tt-roll-bar"><i style={{ width: `${Math.max(6, (r.imp / ttRollMax) * 100)}%`, background: isC ? "var(--green)" : "var(--red)" }} /></span>
                          <span className="z-tt-roll-v"><b>{score}</b> <span>impacto</span></span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <div className="z-tt-sech z-tt-sech-top">
                Feed{newTopTs.size > 0 ? <span className="z-tt-newcnt"> · {newTopTs.size} nuevo{newTopTs.size === 1 ? "" : "s"}</span> : null}
              </div>
              <div className="z-tt-table">
                {ttFeed.map((t, i) => {
                  const isNew = newTopTs.has(t.ts);
                  const isCall = t.type === "call";
                  const buy = t.side === "buy";
                  const bull = (isCall && buy) || (!isCall && !buy);
                  const hhmmss = new Date(t.ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
                  return (
                    <div
                      key={`${t.ts}-${i}`}
                      className={`z-tt-row ${bull ? "z-tt-bull" : "z-tt-bear"} ${t.sweep ? "z-tt-sweep" : ""} ${isNew ? "z-tt-new" : ""} ${t.open ? "" : "z-tt-closed"}`}
                      title={t.open ? "apertura" : "cierre"}
                    >
                      <span className="z-tt-time">{hhmmss}</span>
                      <span><b>{t.strike} {isCall ? "C" : "P"}</b></span>
                      <span>{buy ? "▲ compra al ask" : "▼ vende al bid"}</span>
                      <span className="z-tt-r">{t.delta != null ? Math.abs(t.delta).toFixed(2) : "—"}</span>
                      <span className="z-tt-r z-tt-prem">{usd(t.premium)}</span>
                      <span className="z-tt-r z-tt-score">{t.sweep && <b className="z-tt-swi" title="sweep">⚡</b>}{scoreOf(t)}</span>
                    </div>
                  );
                })}
              </div>

              {(discMid > 0 || discClose > 0) && (
                <div className="z-tt-disc">
                  <span className="z-tt-disc-ic">⊘</span> {discMid} bloques pasivos y {discClose} de cierre descartados de la señal.
                </div>
              )}

              <div className="z-tt-foot">
                Solo bloques agresivos (compra al ask / venta al bid) que pasan los filtros de delta,
                volumen y liquidez. El score es relativo al mayor impacto (premium × |gamma|) del ciclo.
              </div>
            </>
          )}
        </section>
      )}

      {data && (
        <div className="z-summary">
          <div className="z-sum-card z-sum-call">
            <span className="z-sum-lbl">Call de mayor volumen</span>
            <b>{data.summary.maxCallStrike ?? "—"}</b>
            <span className="z-sum-sub">{num(data.summary.maxCallVolume)} contratos</span>
          </div>
          <div className="z-sum-card z-sum-put">
            <span className="z-sum-lbl">Put de mayor volumen</span>
            <b>{data.summary.maxPutStrike ?? "—"}</b>
            <span className="z-sum-sub">{num(data.summary.maxPutVolume)} contratos</span>
          </div>
          <div className="z-sum-card">
            <span className="z-sum-lbl">Ratio Put / Call</span>
            <b>{data.summary.putCallRatio?.toFixed(2) ?? "—"}</b>
            <span className="z-sum-sub">{num(data.summary.putVolume)} puts · {num(data.summary.callVolume)} calls</span>
          </div>
        </div>
      )}

      {data && data.gex.n > 0 && (
        <section className={`z-gex z-gex-${data.gex.regime}`}>
          <header>
            <h2>Gamma del día (GEX)</h2>
            <span>{data.gex.n} strikes · gamma real en {(data.gex.realGammaShare * 100).toFixed(0)}% de los contratos</span>
          </header>
          <div className="z-gex-grid">
            <div>
              <span className="z-sum-lbl">Régimen</span>
              <b>{data.gex.regime === "positive" ? "γ positiva" : "γ negativa"}</b>
              <span className="z-sum-sub">
                {data.gex.regime === "positive"
                  ? "los dealers operan CONTRA el movimiento → el precio tiende a revertir hacia el imán"
                  : "los dealers operan A FAVOR → los movimientos se amplifican"}
              </span>
            </div>
            <div>
              <span className="z-sum-lbl">Imán (mayor gamma)</span>
              <b>{data.gex.kingStrike ?? "—"}</b>
              <span className="z-sum-sub">strike que más ancla al precio</span>
            </div>
            <div>
              <span className="z-sum-lbl">Zona de inversión</span>
              <b>{data.gex.flipStrike ?? "—"}</b>
              <span className="z-sum-sub">
                {data.gex.flipStrike == null ? "el GEX no cambia de signo en la ventana" : "cruzarlo cambia el régimen"}
              </span>
            </div>
          </div>
        </section>
      )}

      {data?.closing && (
        <section className={`z-close z-close-${data.closing.phase === "live" ? data.closing.confidence : data.closing.phase}`}>
          <div className="z-close-top">
            <span className="z-close-tag">GEX Pinning <span className="z-live-sub">cierre 4:00pm ET</span></span>
            {data.closing.phase === "live" && (
              <>
                <span className="z-close-min">faltan {data.closing.minutesLeft.toFixed(0)} min</span>
                <span className="z-conf">confianza {CONFIDENCE[data.closing.confidence] ?? data.closing.confidence}</span>
              </>
            )}
            {data.closing.phase === "pending" && <span className="z-close-min">se calcula a las 3:00pm ET</span>}
            {data.closing.phase === "final" && <span className="z-close-min">fijado · sesión {data.closing.fromDate ?? ""}</span>}
          </div>
          {data.closing.phase === "live" && (
            <div className="z-moc">
              <div className="z-moc-head">
                <span className="z-sum-lbl">Imbalance MOC (manual)</span>
                <span className="z-moc-hint">pégalo del tweet de Nasdaq/NYSE ~3:50pm ET</span>
              </div>
              <div className="z-moc-row">
                <input
                  className="z-moc-in" value={mocVal} placeholder="0"
                  inputMode="decimal" onChange={(e) => saveMoc(e.target.value, mocSide)}
                />
                <span className="z-moc-unit">MLN</span>
                <span className="z-moc-toggle">
                  <button type="button" className={mocSide === "buy" ? "z-moc-buy" : ""} onClick={() => saveMoc(mocVal, "buy")}>Compra</button>
                  <button type="button" className={mocSide === "sell" ? "z-moc-sell" : ""} onClick={() => saveMoc(mocVal, "sell")}>Venta</button>
                </span>
                {mocVal !== "" && <button type="button" className="z-moc-clear" onClick={() => saveMoc("", null)} aria-label="limpiar">×</button>}
              </div>
            </div>
          )}
          <div className="z-close-main">
            <div>
              <span className="z-sum-lbl">Strike de cierre más probable</span>
              <b className="z-close-strike">{data.closing.strike ?? "—"}</b>
            </div>
            {data.closing.maxPain != null && (
              <div>
                <span className="z-sum-lbl">Max Pain (OI)</span>
                <b className="z-close-maxpain">{data.closing.maxPain}</b>
              </div>
            )}
            {data.closing.phase === "live" && (
              <div className="z-close-range">
                <span className="z-sum-lbl">Rango probable</span>
                <b>{data.closing.rangeLow} – {data.closing.rangeHigh}</b>
                <span className="z-sum-sub">±{data.closing.sigma.toFixed(1)} pts de margen</span>
              </div>
            )}
          </div>
          <p className="z-close-note">{data.closing.note}</p>
          {evalu?.closingCount != null && evalu.closingCount > 0 && (
            <p className="z-close-acc">
              Historial: en {evalu.closingCount} cierre{evalu.closingCount === 1 ? "" : "s"} medido{evalu.closingCount === 1 ? "" : "s"}, error medio {evalu.closingMeanAbsErrorPts?.toFixed(1) ?? "—"} pts
              {evalu.closingHitRate != null && ` · acierto (±5 pts) ${evalu.closingHitRate.toFixed(0)}%`}
            </p>
          )}

          {data.closing.phase === "live" && data.closing.regime === "negative" && (
            despin ? (
              <div className={`z-pinalt-dir z-pinalt-dir-${despin.dir}`}>
                <div className="z-pinalt-top">
                  <span className="z-pinalt-tag">GEX Pinning · Charm</span>
                  <span className="z-pinalt-dir-w" style={{ color: despin.dir === "down" ? "var(--red-text, #c0392b)" : "var(--green-dark, #1a7f4b)" }}>
                    {despin.dir === "down" ? "▼ tiende a bajar" : "▲ tiende a subir"}
                  </span>
                </div>
                <div className="z-close-main">
                  <div><span className="z-sum-lbl">Objetivo si rompe el pin</span><b>{despin.target.toFixed(0)}</b></div>
                  <div><span className="z-sum-lbl">Distancia</span><b>{despin.pts.toFixed(0)} pts</b></div>
                </div>
                <p className="z-pinalt-note">
                  {despin.anchored ? `Anclado al muro de gamma en ${despin.wall}.` : "Sin muro alcanzable — objetivo estimado por movimiento esperado (1σ)."}
                  {" "}γ negativa: sin efecto de anclaje fiable, el flujo agresivo decide.
                  {mocVal !== "" && mocSide != null && (
                    (mocSide === "buy") === (despin.dir === "up")
                      ? ` MOC (${mocVal}M ${mocSide === "buy" ? "compra" : "venta"}) confirma.`
                      : ` MOC (${mocVal}M ${mocSide === "buy" ? "compra" : "venta"}) contradice — ojo.`
                  )}
                </p>
              </div>
            ) : (
              <p className="z-pinalt-none">γ negativa y sin flujo direccional claro todavía — sin pin ni despin, mejor esperar.</p>
            )
          )}

          <p className="z-outlook-caveat">
            Estimación del efecto de anclaje de los dealers, no certeza. Una noticia o un cambio de
            régimen puede romperlo. Tú decides.
          </p>
        </section>
      )}

      {isNativeFutureTicker && unpin && unpin.state !== "idle" && data && (() => {
        const up = unpin.dir === "up";
        const dirCol = up ? "var(--green-dark)" : "var(--red-text)";
        const sgn = up ? "+" : "−";
        const magnet = data.closing?.strike ?? data.gex.kingStrike ?? null;
        const flowBullish = ttBull >= ttBear;
        const armed = unpin.state === "armed", post = unpin.state === "post", waiting = unpin.state === "waiting";
        const dirLbl = up ? "▲ pop (rebote)" : "▼ drop (caída)";
        return (
          <section className={`z-unpin ${waiting ? "z-unpin-wait" : ""}`}>
            <header className="z-unpin-top">
              <h2 className="z-unpin-tag">GEX Unpin <span className="z-live-sub">{selTicker} · resorte post-cierre</span></h2>
              {unpin.dir && (armed || post
                ? <span className="z-live-hdir" style={{ color: dirCol }}>{dirLbl}</span>
                : <span className="z-live-hdir z-live-hdir-would" style={{ color: dirCol }}>sería {dirLbl}</span>)}
            </header>
            <div className="z-unpin-badges">
              {armed && <span className="z-live-waitbadge">● armado (3-4pm)</span>}
              {post && <span className="z-lean-chip" style={{ color: dirCol, background: up ? "var(--green-bg)" : "var(--red-bg)" }}>{up ? "▲ " : "▼ "}jugando (4-5pm)</span>}
              {waiting && <span className="z-live-waitbadge">● esperando</span>}
              {(armed || (waiting && unpin.hasPin)) && unpin.defendedFrom && (
                <span className="z-unpin-tell">
                  {unpin.defendedFrom === "above" ? "precio defendido desde arriba (dealer vendía) → compra reprimida" : "precio defendido desde abajo (dealer compraba) → venta reprimida"}
                </span>
              )}
            </div>
            {armed && (
              <div className="z-close-main z-unpin-row">
                <div><span className="z-sum-lbl">Snapback esperado {selTicker}</span><b className="z-close-netgex" style={{ color: dirCol }}>{sgn}{unpin.lo} a {sgn}{unpin.hi} pts</b></div>
                <div><span className="z-sum-lbl">Spot / imán</span><b>{dec(data.spot)} / {magnet ?? "—"}</b></div>
                <div><span className="z-sum-lbl">Flujo agresivo</span><b style={{ color: flowBullish ? "var(--green-dark)" : "var(--red-text)" }}>{flowBullish ? "alcista" : "bajista"}</b></div>
                <div><span className="z-sum-lbl">Al cierre</span><b style={{ color: "var(--amber-text)" }}>{unpin.minToClose} min</b></div>
              </div>
            )}
            {post && (
              <div className="z-close-main z-unpin-row">
                <div><span className="z-sum-lbl">{selTicker} · desde el pin</span><b className="z-close-netgex" style={{ color: dirCol }}>{unpin.move != null && unpin.move >= 0 ? "+" : ""}{unpin.move?.toFixed(0)} pts</b></div>
                <div><span className="z-sum-lbl">Snapback esperado</span><b>{sgn}{unpin.lo} a {sgn}{unpin.hi} pts</b></div>
              </div>
            )}
            {waiting && unpin.hasPin && (
              <div className="z-close-main z-unpin-row">
                <div><span className="z-sum-lbl">Snapback esperado {selTicker}</span><b className="z-close-netgex" style={{ color: dirCol }}>{sgn}{unpin.lo} a {sgn}{unpin.hi} pts</b></div>
                <div><span className="z-sum-lbl">Spot / imán</span><b>{dec(data.spot)} / {magnet ?? "—"}</b></div>
              </div>
            )}
            <p className="z-close-note">
              {waiting ? (unpin.hasPin ? "Fuera de la ventana 3-5pm ET — vista previa del sesgo si el pin se sostiene hasta el cierre." : "γ negativa — sin pin que soltar, el unpin no aplica hoy.") : `Solo aplica a ${selTicker} — sigue cotizando 4-5pm ET cuando el índice cash ya cerró.`}
            </p>
          </section>
        );
      })()}

      {data?.forecast && (
        <section className="z-fc">
          <header>
            <h2>Escenarios hasta el cierre</h2>
            {data.forecast.calibShiftPct !== 0 && (
              <span className="z-calib-chip" title="El objetivo base se corrige según el sesgo histórico medido en 'Precisión del modelo'">
                🧠 auto-ajustado {data.forecast.calibShiftPct > 0 ? "+" : ""}{data.forecast.calibShiftPct.toFixed(2)}%
              </span>
            )}
            <span>
              {data.forecast.hoursToClose.toFixed(1)} h restantes · IV {(data.forecast.iv * 100).toFixed(1)}% ·
              1σ = ±{data.forecast.sigma.toFixed(1)} pts ({data.forecast.sigmaPct.toFixed(2)}%)
            </span>
          </header>

          {data.forecast.caveat && <div className="z-fc-caveat">{data.forecast.caveat}</div>}

          <div className="z-fc-grid">
            {data.forecast.scenarios.map((s) => (
              <div key={s.kind} className={`z-fc-card z-fc-${s.kind}`}>
                <span className="z-sum-lbl">{s.kind === "bull" ? "Alcista" : s.kind === "bear" ? "Bajista" : "Base"}</span>
                <b>{s.target.toFixed(2)}</b>
                <span className="z-fc-pct">{s.changePct >= 0 ? "+" : ""}{s.changePct.toFixed(2)}%</span>
                <div className="z-fc-prob">
                  <i style={{ width: `${s.probTouch * 100}%` }} />
                  <span>{(s.probTouch * 100).toFixed(0)}% de tocarlo</span>
                </div>
                <p>{s.reason}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {data?.isToday && data.suggestions && <SpreadSuggestions s={data.suggestions} />}

      {data && (
        <p className="z-caveat">
          El volumen dice dónde hay actividad; el agresor dice de qué lado. VENTA de calls es
          resistencia y VENTA de puts es soporte; COMPRA es direccional. El número pequeño es cuántos
          trades sustentan el porcentaje — desconfía de los que tengan pocos. El agresor se acumula
          desde que arrancó el agente, así que gana fiabilidad conforme avanza la sesión.
        </p>
      )}

      {data && (
        <section className="z-chart-card">
          <div className="z-chart-head">Gráfica de {data.ticker} con niveles del agente</div>
          <ZeroDteChart
            ticker={selTicker}
            reloadKey={data.asOf}
            maxCall={data.summary.maxCallStrike}
            maxPut={data.summary.maxPutStrike}
            magnet={data.gex.kingStrike}
            flip={data.gex.flipStrike}
            target={data.closing?.strike ?? null}
            spot={data.spot}
          />
          <p className="z-chart-legend">
            <b style={{ color: "#5b21b6" }}>Violeta</b> = strike de mayor volumen (call/put) ·{" "}
            <b style={{ color: "#374151" }}>gris</b> = imán del GEX ·{" "}
            <b style={{ color: "#9a3412" }}>naranja</b> = flip gamma (anclaje ↔ aceleración) ·{" "}
            <b style={{ color: "#92400e" }}>amarillo</b> = target de cierre ·{" "}
            <b style={{ color: "#1d4ed8" }}>azul punteado</b> = precio actual
          </p>
        </section>
      )}

      {data && (
        <table className="z-chain">
          <thead>
            <tr className="z-side">
              <th colSpan={4} className="z-call">C A L L S</th>
              <th className="z-mid" />
              <th colSpan={4} className="z-put">P U T S</th>
            </tr>
            <tr className="z-spotrow-hidden">
              <th colSpan={9} className="z-aggr-note">
                {!data.isToday
                  ? "Agresor solo disponible en el 0DTE de hoy"
                  : flow?.error
                    ? `Agresor no disponible: ${flow.error}`
                    : flow
                      ? `Agresor acumulado en ${flow.cycles} ciclo${flow.cycles === 1 ? "" : "s"} · ${flow.contracts} contratos con muestra`
                      : "Cargando agresor…"}
              </th>
            </tr>
            <tr>
              <th>Agresor</th>
              <th className="z-vol">Volumen</th>
              <th>OI</th>
              <th>Delta</th>
              <th className="z-mid">Strike</th>
              <th>Delta</th>
              <th>OI</th>
              <th className="z-vol">Volumen</th>
              <th>Agresor</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line, i) => (
              <Fragment key={line.strike}>
                {i === spotAt && spot != null && (
                  <tr className="z-spotrow">
                    <td colSpan={9} className="z-spotband">
                      <span className="z-spot-flag">Precio actual</span>
                      <b>{dec(spot)}</b>
                      <span className="z-spot-hint">cae entre strikes — no es un contrato, por eso no tiene volumen ni OI</span>
                    </td>
                  </tr>
                )}
                <Line
                  line={line}
                  maxVol={maxVol}
                  spot={spot}
                  topCall={line.strike === data.summary.maxCallStrike}
                  topPut={line.strike === data.summary.maxPutStrike}
                  isMagnet={line.strike === data.gex.kingStrike}
                  callAggr={flow?.reads?.[`call:${line.strike}`] ?? null}
                  putAggr={flow?.reads?.[`put:${line.strike}`] ?? null}
                />
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {evalu && !evalu.error && (
        <section className="z-eval">
          <header>
            <h2>Precisión del modelo</h2>
            <span>
              {evalu.empty || !evalu.maturedCount
                ? "aún sin sesiones cerradas para medir"
                : `${evalu.maturedCount} sesión${evalu.maturedCount === 1 ? "" : "es"} evaluada${evalu.maturedCount === 1 ? "" : "s"}`}
            </span>
          </header>
          {evalu.empty || !evalu.maturedCount ? (
            <p className="z-eval-wait">
              El modelo guarda su pronóstico de hoy y lo contrasta contra el cierre real. La primera
              medición aparece mañana; la fiabilidad crece con los días.
            </p>
          ) : (
            <div className="z-eval-grid">
              <div>
                <span className="z-sum-lbl">Error medio del base</span>
                <b>{evalu.meanAbsErrorPct?.toFixed(2) ?? "—"}%</b>
              </div>
              <div>
                <span className="z-sum-lbl">Sesgo</span>
                <b>{evalu.biasPct == null ? "—" : `${evalu.biasPct >= 0 ? "+" : ""}${evalu.biasPct.toFixed(2)}%`}</b>
                <span className="z-sum-sub">
                  {evalu.biasPct == null ? "" : evalu.biasPct >= 0 ? "el precio cierra por encima del base" : "por debajo del base"}
                </span>
              </div>
              <div>
                <span className="z-sum-lbl">Alcista tocado</span>
                <b>{evalu.bullTouchRate?.toFixed(0) ?? "—"}%</b>
              </div>
              <div>
                <span className="z-sum-lbl">Bajista tocado</span>
                <b>{evalu.bearTouchRate?.toFixed(0) ?? "—"}%</b>
              </div>
            </div>
          )}
        </section>
      )}

      <p className="z-foot">
        Se actualiza sola cada minuto. Fondo sombreado = contrato ITM. La barra bajo el volumen es
        relativa al mayor de la tabla. Fila amarilla = muro de mayor volumen (MAX CALL/PUT); 🧲 gris =
        imán del GEX.
      </p>
    </div>
  );
}

function Line({
  line, maxVol, spot, topCall, topPut, isMagnet, callAggr, putAggr,
}: {
  line: ChainLine;
  maxVol: number;
  spot: number | null;
  topCall: boolean;
  topPut: boolean;
  isMagnet: boolean;
  callAggr: AggressorRead | null;
  putAggr: AggressorRead | null;
}) {
  const { call, put, strike, from } = line;
  const callItm = spot != null && strike < spot;
  const putItm = spot != null && strike > spot;
  const rankedCall = from === "call" || from === "both";
  const rankedPut = from === "put" || from === "both";

  return (
    <tr className={`${topCall || topPut ? "z-toprow" : ""} ${isMagnet ? "z-magnetrow" : ""}`}>
      <Aggr read={callAggr} itm={callItm} />
      <td className={`z-vol ${callItm ? "z-itm" : ""} ${rankedCall ? "z-ranked" : ""} ${topCall ? "z-top z-top-call" : ""}`}>
        {topCall && <em className="z-tag">MAX CALL</em>}
        <span>{num(call?.volume)}</span>
        <i style={{ width: `${((call?.volume ?? 0) / maxVol) * 100}%` }} className="z-bar z-bar-call" />
      </td>
      <td className={callItm ? "z-itm" : ""}>{num(call?.openInterest)}</td>
      <td className={callItm ? "z-itm" : ""}>{dec(call?.greeks?.delta)}</td>

      <td className={`z-mid ${isMagnet ? "z-magnet" : ""}`}>
        {isMagnet && <em className="z-magnet-tag" title="imán del GEX">🧲</em>}
        {strike}
      </td>

      <td className={putItm ? "z-itm" : ""}>{dec(put?.greeks?.delta)}</td>
      <td className={putItm ? "z-itm" : ""}>{num(put?.openInterest)}</td>
      <td className={`z-vol ${putItm ? "z-itm" : ""} ${rankedPut ? "z-ranked" : ""} ${topPut ? "z-top z-top-put" : ""}`}>
        {topPut && <em className="z-tag">MAX PUT</em>}
        <span>{num(put?.volume)}</span>
        <i style={{ width: `${((put?.volume ?? 0) / maxVol) * 100}%` }} className="z-bar z-bar-put" />
      </td>
      <Aggr read={putAggr} itm={putItm} />
    </tr>
  );
}

/** Celda de agresor. Vacía si no hubo muestra suficiente. */
function Aggr({ read, itm }: { read: AggressorRead | null; itm: boolean }) {
  if (!read) return <td className={`z-aggr ${itm ? "z-itm" : ""}`}>—</td>;
  const label =
    read.side === "compra" ? "COMPRA" :
    read.side === "venta" ? "VENTA" :
    read.side === "mid" ? "MID" : "mixto";
  return (
    <td className={`z-aggr z-aggr-${read.side} ${itm ? "z-itm" : ""}`} title={read.meaning}>
      <b>{label}</b> {(read.pct * 100).toFixed(0)}%
      <small>{read.trades}</small>
    </td>
  );
}

/** "LIVE VOLUME · VELOCITY + CVD" — velocidad de volumen (último ciclo vs promedio de
 * la ventana) + agresor neto acumulado del día (CVD), con nota de si favorece el
 * LONG/SHORT que sugiere "Mejor trade ahora". */
function LiveVolumeCvd({ flow, direction }: { flow: FlowState; direction: "long" | "short" | null }) {
  const agg = flow.netAggressor;
  const vel = flow.velocity;
  if (!agg || !vel) return null;

  if (!agg.enough) {
    return (
      <section className="z-cvd">
        <header className="z-cvd-head">
          <span className="z-cvd-title">Volumen en vivo · velocidad + CVD</span>
          <span className="z-cvd-count">{num(agg.total)} contratos</span>
        </header>
        <p className="z-cvd-note">Muestra insuficiente todavía — sigue acumulando cinta.</p>
      </section>
    );
  }

  const pressure: "venta" | "compra" | "neutral" = agg.net < 0 ? "venta" : agg.net > 0 ? "compra" : "neutral";
  const pillLabel = pressure === "venta" ? "▼ presión vendedora" : pressure === "compra" ? "▲ presión compradora" : "◆ neutral";

  const ratio = vel.ratio;
  const ratioLabel = ratio == null ? "—" : `${ratio.toFixed(1)}×`;
  const ratioClamped = ratio == null ? 0 : Math.max(0, Math.min(3, ratio));

  const velocityWord =
    ratio == null ? "Calculando volumen"
    : ratio < 0.7 ? "Volumen bajo"
    : ratio < 1.3 ? "Volumen tranquilo"
    : ratio < 2 ? "Volumen elevado"
    : "Volumen explosivo";

  const aggressorWord =
    pressure === "venta" ? "agresor vendiendo" : pressure === "compra" ? "agresor comprando" : "sin agresor claro";

  let directionNote = "";
  if (direction === "short") {
    directionNote = pressure === "venta" ? " A favor de tu CORTO — el imán tiene combustible."
      : pressure === "compra" ? " En contra de tu CORTO — cuidado." : "";
  } else if (direction === "long") {
    directionNote = pressure === "compra" ? " A favor de tu LARGO — el imán tiene combustible."
      : pressure === "venta" ? " En contra de tu LARGO — cuidado." : "";
  }

  const maxBar = Math.max(1, ...vel.series);
  const sliderPct = 50 + (agg.net / Math.max(agg.total, 1)) * 50;

  const cvdMax = Math.max(1, ...vel.cvdSeries.map((v) => Math.abs(v)));
  const sparkPoints = vel.cvdSeries.length > 1
    ? vel.cvdSeries
        .map((v, i) => {
          const x = (i / (vel.cvdSeries.length - 1)) * 140;
          const y = 15 - (v / cvdMax) * 13;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : "";

  return (
    <section className="z-cvd">
      <header className="z-cvd-head">
        <span className="z-cvd-title">Volumen en vivo · velocidad + CVD</span>
        <span className={`z-cvd-pill z-cvd-pill-${pressure}`}>{pillLabel}</span>
        <span className="z-cvd-count">{num(agg.total)} contratos</span>
      </header>

      <div className="z-cvd-grid">
        <div className="z-cvd-col">
          <span className="z-cvd-lbl">Velocidad de volumen</span>
          <b className="z-cvd-big">{ratioLabel}</b>
          <span className="z-cvd-sub">último minuto vs promedio de la ventana</span>
          <div className="z-cvd-track"><i style={{ width: `${(ratioClamped / 3) * 100}%` }} /></div>
          <div className="z-cvd-scale"><span>0×</span><span>1×</span><span>2×</span><span>3×</span></div>
          <div className="z-cvd-bars">
            {vel.series.map((v, i) => (
              <i key={i} style={{ height: `${Math.max(10, (v / maxBar) * 100)}%` }} />
            ))}
          </div>
        </div>

        <div className="z-cvd-col">
          <span className="z-cvd-lbl">Agresor neto (CVD)</span>
          <b className={`z-cvd-big z-cvd-net-${pressure}`}>{agg.net >= 0 ? "+" : ""}{num(agg.net)}</b>
          <span className="z-cvd-sub">
            {pressure === "venta" ? "domina la venta" : pressure === "compra" ? "domina la compra" : "sin dominancia clara"}
          </span>
          <div className="z-cvd-slider">
            <i className={`z-cvd-slider-mark z-cvd-slider-${pressure}`} style={{ left: `${Math.max(3, Math.min(97, sliderPct))}%` }} />
          </div>
          <div className="z-cvd-scale"><span>venta</span><span>0</span><span>compra</span></div>
          <svg className="z-cvd-spark" viewBox="0 0 140 30" preserveAspectRatio="none">
            <line x1="0" y1="15" x2="140" y2="15" className="z-cvd-spark-base" />
            {sparkPoints && <polyline points={sparkPoints} className={`z-cvd-spark-line z-cvd-spark-${pressure}`} />}
          </svg>
        </div>
      </div>

      <p className="z-cvd-note">{velocityWord}, {aggressorWord}.{directionNote}</p>
    </section>
  );
}

/** Sugerencias de spreads del día — vertical de débito (direccional), credit call
 * e iron condor (neutrales), armados con strikes reales cotizados (bid/ask). */
function SpreadSuggestions({ s }: { s: ZeroDteSuggestions }) {
  const biasLabel =
    s.bias === "alcista" ? `▲ sesgo alcista (${s.biasSource === "pin" ? "imán" : "agresor"})`
    : s.bias === "bajista" ? `▼ sesgo bajista (${s.biasSource === "pin" ? "imán" : "agresor"})`
    : "▬ sin sesgo claro";

  return (
    <section className="z-spreads">
      <header>
        <h2>Sugerencias de spreads</h2>
        <span className={`z-spreads-bias z-spreads-bias-${s.bias}`}>{biasLabel}</span>
      </header>

      <div className="z-spreads-grid">
        <div className="z-spread-card">
          <span className="z-sum-lbl">Vertical de débito</span>
          {s.vertical ? (
            <>
              <b>{s.vertical.kind === "bull_call" ? "Bull Call" : "Bear Put"}</b>
              <span className="z-spread-legs">
                Compra {s.vertical.longStrike} · Vende {s.vertical.shortStrike}
              </span>
              <div className="z-spread-nums">
                <div><span>Débito</span><b>{money(s.vertical.debit)}</b></div>
                <div><span>Máx. ganancia</span><b className="z-spread-good">{money(s.vertical.maxProfit)}</b></div>
                <div><span>Breakeven</span><b>{dec(s.vertical.breakeven)}</b></div>
              </div>
            </>
          ) : (
            <p className="z-spread-empty">
              {s.bias === "lateral" ? "Sin sesgo direccional claro — no se arma." : "Sin strikes cotizados suficientes."}
            </p>
          )}
        </div>

        <div className="z-spread-card">
          <span className="z-sum-lbl">Credit Call</span>
          {s.creditCall ? (
            <>
              <b>Bear Call</b>
              <span className="z-spread-legs">
                Vende {s.creditCall.shortCall} · Compra {s.creditCall.longCall}
              </span>
              <div className="z-spread-nums">
                <div><span>Crédito</span><b className="z-spread-good">{money(s.creditCall.credit)}</b></div>
                <div><span>Máx. pérdida</span><b>{money(s.creditCall.maxLoss)}</b></div>
                <div><span>Breakeven</span><b>{dec(s.creditCall.breakeven)}</b></div>
              </div>
            </>
          ) : (
            <p className="z-spread-empty">Sin strikes cotizados suficientes arriba del rango.</p>
          )}
        </div>

        <div className="z-spread-card">
          <span className="z-sum-lbl">Iron Condor</span>
          {s.ironCondor ? (
            <>
              <b>{s.ironCondor.shortPut}P / {s.ironCondor.shortCall}C</b>
              <span className="z-spread-legs">
                Alas: {s.ironCondor.longPut}P · {s.ironCondor.longCall}C
              </span>
              <div className="z-spread-nums">
                <div><span>Crédito</span><b className="z-spread-good">{money(s.ironCondor.credit)}</b></div>
                <div><span>Rango seguro</span><b>{dec(s.ironCondor.beLow)} – {dec(s.ironCondor.beHigh)}</b></div>
              </div>
            </>
          ) : (
            <p className="z-spread-empty">Sin strikes cotizados suficientes en ambos lados del rango.</p>
          )}
        </div>
      </div>

      <p className="z-spreads-note">
        Vertical: apunta al imán del GEX si hay setup de pin, o al borde de 1σ si no lo hay (ahí el
        sesgo sale del agresor neto/CVD). Credit Call e Iron Condor venden el borde de 1σ del
        movimiento esperado y compran el de 2σ como protección — spreads con riesgo definido, ambas
        patas. Precios de débito/crédito al ask/bid real de cada pata — pueden no llenarse a ese precio
        exacto. Dinero simulado, no es consejo financiero.
      </p>
    </section>
  );
}

const CSS = `
.z-wrap { max-width: 1440px; margin: 0 auto; padding: 0 0 40px; font-size: 15px; }
.z-disclaimer { background: var(--amber-bg); border: 1px solid var(--amber-border); color: var(--amber-text);
  font-size: 13px; font-weight: 600; text-align: center; padding: 9px 16px; border-radius: 8px; margin: 0 0 16px; }
.z-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.z-head h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.2px; }
.z-head p { margin: 0; color: var(--muted); font-size: 14px; }
.z-controls { display: flex; gap: 8px; }
.z-controls select, .z-controls button {
  font: inherit; padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer;
}
.z-controls button { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.z-controls button:disabled { opacity: .6; cursor: default; }

.z-meta { display: flex; gap: 18px; flex-wrap: wrap; align-items: center;
  margin: 20px 0 12px; color: var(--muted); font-size: 14px; }
.z-meta b { color: var(--text); }
.z-time { margin-left: auto; font-variant-numeric: tabular-nums; }
.z-fresh { background: var(--green-bg); border: 1px solid var(--green);
  color: var(--green-dark); padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.z-flag { background: var(--amber-bg); border: 1px solid var(--amber-border);
  color: var(--amber-text); padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.z-error { background: var(--red-bg); border: 1px solid var(--red-soft);
  color: #7a271a; padding: 12px 14px; border-radius: 8px; margin: 16px 0; }

.z-chain { width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
  font-variant-numeric: tabular-nums; }
.z-chain th, .z-chain td { padding: 9px 12px; text-align: right; font-size: 14.5px;
  border-bottom: 1px solid var(--border-soft); }
.z-chain thead th { background: var(--panel-2); color: var(--muted);
  font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.z-chain tr.z-side th { font-size: 12px; letter-spacing: .18em; padding: 8px; }
.z-side .z-call { color: var(--green-dark); background: var(--green-bg); }
.z-side .z-put { color: #b42318; background: var(--red-bg); }

.z-mid { text-align: center !important; font-weight: 700; background: var(--panel-2);
  border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
.z-itm { background: rgba(47,107,255,.05); }
.z-vol { position: relative; font-weight: 600; }
.z-ranked span { color: var(--text); }
.z-vol span { position: relative; z-index: 1; }
.z-bar { position: absolute; bottom: 0; height: 4px; display: block; border-radius: 2px; }
.z-bar-call { right: 0; background: var(--call); }
.z-bar-put { left: 0; background: var(--put); }

.z-spotband { background: var(--accent-dim);
  border-top: 2px solid var(--accent); border-bottom: 2px solid var(--accent);
  text-align: center !important; padding: 7px 10px !important; }
.z-spot-flag { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  font-weight: 700; color: #fff; background: var(--accent); padding: 2px 8px;
  border-radius: 999px; vertical-align: middle; }
.z-spotband b { color: var(--accent); font-size: 15px; font-weight: 700;
  margin: 0 8px; vertical-align: middle; font-variant-numeric: tabular-nums; }
.z-spot-hint { color: var(--muted); font-size: 11px; font-weight: 400; vertical-align: middle; }

.z-foot { color: var(--faint); font-size: 12px; margin-top: 14px; }

.z-chart-card { border: 1px solid var(--border); background: var(--panel);
  border-radius: 12px; padding: 14px 16px; margin: 0 0 16px; }
.z-chart-head { font-size: 14px; font-weight: 500; color: var(--text); margin-bottom: 8px; }
.z-chart-wrap { width: 100%; overflow-x: auto; }
.z-chart-legend { margin: 8px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
.z-chart-msg { padding: 28px 12px; text-align: center; color: var(--faint); font-size: 13px; }

.z-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--space-md); margin: 4px 0 16px; }
.z-sum-card { background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
.z-sum-card b { font-size: 24px; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; }
.z-sum-lbl { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.z-sum-sub { font-size: 13px; color: var(--faint); font-variant-numeric: tabular-nums; }
.z-sum-call { border-left: 3px solid var(--call); }
.z-sum-call b { color: var(--green-dark); }
.z-sum-put { border-left: 3px solid var(--put); }
.z-sum-put b { color: #b42318; }

.z-caveat { background: var(--amber-bg); border: 1px solid var(--amber-border);
  color: var(--amber-text); padding: 10px 14px; border-radius: 8px;
  font-size: 12.5px; line-height: 1.5; margin: 0 0 16px; }

.z-close { border: 2px solid var(--accent); background: var(--accent-dim);
  border-radius: 12px; padding: 18px 20px; margin: 0 0 16px; }
.z-close-baja { border-color: var(--border); background: var(--panel-2); }
.z-close-pending { border-color: var(--border); border-style: dashed; background: var(--panel-2); }
.z-close-pending .z-close-strike { color: var(--faint); }
.z-close-final { border-color: var(--border); background: var(--panel-2); }
.z-close-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-close-tag { font-size: 12px; font-weight: 800; letter-spacing: .03em; color: var(--accent); }
.z-close-min { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-close-main { display: flex; gap: 32px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 10px; }
.z-close-main > div { display: flex; flex-direction: column; gap: 2px; }
.z-close-strike { font-size: 34px; letter-spacing: -0.6px; color: var(--accent);
  font-variant-numeric: tabular-nums; line-height: 1.05; }
.z-close-range b { font-size: 18px; font-variant-numeric: tabular-nums; }
.z-close-note { margin: 0 0 6px; font-size: 12.5px; color: var(--text); line-height: 1.5; }
.z-close-acc { margin: 0 0 8px; font-size: 12px; color: var(--muted);
  padding: 6px 10px; background: var(--panel); border-radius: 6px; display: inline-block; }
.z-close-acc b { color: var(--text); }
.z-close-maxpain { font-size: 22px; color: var(--text); font-variant-numeric: tabular-nums; }

.z-moc { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; margin: 0 0 12px; }
.z-moc-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.z-moc-hint { font-size: 11px; color: var(--faint); }
.z-moc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.z-moc-in { width: 96px; font-size: 15px; font-weight: 600; color: var(--text);
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 10px; font-variant-numeric: tabular-nums; }
.z-moc-in:focus { outline: none; border-color: var(--accent); }
.z-moc-unit { font-size: 13px; color: var(--muted); }
.z-moc-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.z-moc-toggle button { font-size: 13px; font-weight: 600; color: var(--muted);
  background: var(--panel); border: none; padding: 7px 13px; cursor: pointer; }
.z-moc-toggle button.z-moc-buy { color: #fff; background: var(--green-dark); }
.z-moc-toggle button.z-moc-sell { color: #fff; background: #c23b46; }
.z-moc-clear { font-size: 15px; line-height: 1; color: var(--faint); background: none;
  border: none; cursor: pointer; padding: 4px 6px; }
.z-moc-clear:hover { color: var(--text); }

.z-pinalt-dir { border-left: 3px solid var(--faint); background: var(--panel-2);
  border-radius: 0 8px 8px 0; padding: 10px 14px; margin-top: 12px; }
.z-pinalt-dir-up { border-left-color: var(--green); background: var(--green-bg); }
.z-pinalt-dir-down { border-left-color: var(--red-soft); background: var(--red-bg); }
.z-pinalt-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.z-pinalt-tag { font-size: 11px; font-weight: 800; letter-spacing: .03em; color: var(--muted);
  text-transform: uppercase; }
.z-pinalt-dir-w { font-size: 13px; font-weight: 700; }
.z-pinalt-note { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.z-pinalt-none { margin: 12px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }

.z-calib-chip { font-size: 11px; font-weight: 700; background: var(--accent-dim);
  color: var(--accent); padding: 2px 9px; border-radius: 999px; }

.z-live { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px;
  margin: 0 0 16px; background: var(--panel); }
.z-live-long { border-color: var(--green); background: var(--green-bg); }
.z-live-short { border-color: var(--red-soft); background: var(--red-bg); }
.z-live-none { border-color: var(--border); background: var(--panel-2); }
.z-live-changed { box-shadow: 0 0 0 3px var(--amber-bg); }
.z-live header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-live h2 { margin: 0; font-size: 16px; }
.z-live-alert { font-size: 11px; font-weight: 700; background: var(--amber-bg);
  color: var(--amber-text); border: 1px solid var(--amber-border); padding: 2px 8px; border-radius: 999px; }
.z-live-clock { margin-left: auto; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-live-row { display: flex; align-items: flex-end; gap: 22px; flex-wrap: wrap; margin-bottom: 8px; }
.z-live-row > div { display: flex; flex-direction: column; gap: 2px; }
.z-live-row b { font-size: 23px; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }
.z-live-dir { font-size: 18px; font-weight: 700; }
.z-dir-long { color: var(--green-dark); }
.z-dir-short { color: #b42318; }
.z-live-reason { margin: 0 0 6px; font-size: 12.5px; color: var(--text); line-height: 1.45; }
.z-live-msg { margin: 0 0 6px; font-size: 13px; color: var(--muted); line-height: 1.5; }

.z-gate-pill { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
.z-gate-ready { background: var(--green-bg); color: var(--green-dark); }
.z-gate-wait { background: var(--amber-bg); color: var(--amber-text); border: 1px solid var(--amber-border); }

.z-alt { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px;
  margin: 0 0 16px; background: var(--panel); }
.z-alt-strong { border-color: var(--accent); background: var(--accent-dim); }
.z-alt-soft { border-color: var(--border); background: var(--panel-2); }
.z-alt-waiting { border-color: var(--border); background: var(--panel-2); opacity: .85; }
.z-alt header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-alt h2 { margin: 0; font-size: 16px; }
.z-alt-suffix { font-size: 13px; font-weight: 400; color: var(--muted); }
.z-live-sub { font-size: 13px; font-weight: 400; color: var(--muted); text-transform: none; letter-spacing: 0; }
.z-alt-tier { margin-left: auto; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
.z-alt-tier-strong { background: var(--green-bg); color: var(--green-dark); }
.z-alt-tier-soft { background: var(--amber-bg); color: var(--amber-text); }
.z-alt-tier-waiting { background: var(--panel-2); color: var(--faint); }
.z-alt-kind { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
.z-alt-reversal { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; color: var(--amber-text);
  background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 6px 10px; border-radius: 6px; }

.z-ticket { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; background: var(--panel); }
.z-ticket-long { border-color: var(--green); background: var(--green-bg); }
.z-ticket-short { border-color: var(--red-soft); background: var(--red-bg); }
.z-ticket-idle { border-color: var(--border); background: var(--panel-2); }
.z-ticket header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.z-ticket h2 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -.3px; }
.z-ticket-sub { font-size: 12px; font-weight: 400; color: var(--muted); }
.z-ticket-badge { margin-left: auto; font-size: 12px; font-weight: 800; letter-spacing: .05em;
  padding: 4px 12px; border-radius: 8px; color: var(--green-dark); background: var(--green-bg); border: 1px solid var(--green); }
.z-ticket-short .z-ticket-badge { color: var(--red-text); background: var(--red-bg); border-color: var(--red-soft); }
.z-ticket-thesis { margin: 0 0 12px; font-size: 12.5px; color: var(--muted); line-height: 1.4; }
.z-ticket-buy { display: flex; align-items: baseline; gap: 11px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.z-ticket-act { font-size: 12px; font-weight: 800; letter-spacing: .06em; padding: 3px 9px; border-radius: 6px;
  color: var(--green-dark); background: var(--green-bg); border: 1px solid var(--green); }
.z-ticket-short .z-ticket-act { color: var(--red-text); background: var(--red-bg); border-color: var(--red-soft); }
.z-ticket-ctr { font-size: 22px; font-weight: 800; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
.z-ticket-at { font-size: 13px; color: var(--muted); }
.z-ticket-price { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
.z-ticket-quote { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.z-ticket-st { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 14px 0 4px; }
.z-ticket-box { display: flex; flex-direction: column; gap: 3px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.z-ticket-k { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.z-ticket-v { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
.z-ticket-tgt { color: var(--green-dark); }
.z-ticket-stp { color: var(--red-text); }
.z-ticket-idx { font-size: 11px; color: var(--faint); }
.z-ticket-up { color: var(--green-dark); }
.z-ticket-dn { color: var(--red-text); }
.z-ticket-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.z-ticket-chip { font-size: 11px; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); padding: 4px 9px; border-radius: 6px; font-variant-numeric: tabular-nums; }
.z-ticket-chip b { color: var(--text); }
.z-ticket-foot { margin: 14px 0 0; font-size: 11px; color: var(--faint); line-height: 1.5; border-top: 1px solid var(--border); padding-top: 10px; }
.z-ticket-none { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
@media (max-width: 640px) { .z-ticket-st { grid-template-columns: 1fr; } }

.z-tt { border: 1px solid var(--border); border-left-width: 4px; border-left-color: var(--accent); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.z-tt-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-tt-tag { font-size: 18px; font-weight: 700; color: var(--text); letter-spacing: -.3px; }
.z-tt-inst { font-size: 12px; font-weight: 700; background: var(--accent); color: #fff; padding: 3px 11px; border-radius: 999px; }
.z-tt-warn { font-size: 11px; color: var(--amber-text); background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 3px 10px; border-radius: 999px; }
.z-tt-takers { margin-left: auto; font-size: 12px; color: var(--amber-text); background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 3px 11px; border-radius: 999px; }
.z-tt-net { display: flex; align-items: stretch; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.z-tt-net-val { flex: 1; min-width: 150px; border-radius: 8px; padding: 8px 13px; border: 1px solid var(--border); }
.z-tt-net-val.pos { background: var(--green-bg); }
.z-tt-net-val.neg { background: var(--red-bg); }
.z-tt-net-lbl { display: block; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-bottom: 1px; }
.z-tt-net-num { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.z-tt-net-num b { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.z-tt-net-val.pos .z-tt-net-num b { color: var(--green-dark); }
.z-tt-net-val.neg .z-tt-net-num b { color: var(--red-text); }
.z-tt-net-num span { font-size: 11px; color: var(--muted); }
.z-tt-net-read { flex: 1.3; min-width: 180px; display: flex; align-items: center; font-size: 11.5px; color: var(--text); line-height: 1.45; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 13px; }
.z-tt-disc { margin-top: 10px; display: flex; gap: 7px; align-items: flex-start; font-size: 11.5px; color: var(--faint); line-height: 1.5; border-top: 1px dashed var(--amber-border); padding-top: 9px; }
.z-tt-disc-ic { color: var(--faint); }
.z-tt-summary { border-left: 3px solid var(--faint); background: var(--panel-2); border-radius: 0 8px 8px 0; padding: 10px 14px; margin-bottom: 12px; }
.z-tt-sum-bull { border-left-color: var(--green); background: var(--green-bg); }
.z-tt-sum-bear { border-left-color: var(--red-soft); background: var(--red-bg); }
.z-tt-sum-mixed { border-left-color: var(--amber-border); background: var(--amber-bg); }
.z-tt-sum-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.z-tt-sum-word { font-size: 13px; font-weight: 700; color: var(--text); }
.z-tt-sum-bull .z-tt-sum-word { color: var(--green-dark); }
.z-tt-sum-bear .z-tt-sum-word { color: var(--red-text); }
.z-tt-sum-mixed .z-tt-sum-word { color: var(--amber-text); }
.z-tt-sum-chip { font-size: 11px; font-weight: 600; background: var(--panel); border: 1px solid var(--border); padding: 1px 8px; border-radius: 999px; color: var(--muted); }
.z-tt-sum-line { margin: 6px 0 0; font-size: 12.5px; color: var(--text); line-height: 1.5; }
.z-tt-sech { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
.z-tt-sech-top { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.z-tt-newcnt { color: var(--amber-text); text-transform: none; letter-spacing: 0; font-weight: 600; }
.z-tt-roll { display: flex; flex-direction: column; gap: 5px; }
.z-tt-rollrow { display: grid; grid-template-columns: 80px 1fr 120px; align-items: center; gap: 10px; }
.z-tt-roll-k { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.z-tt-roll-bar { height: 15px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
.z-tt-roll-bar i { display: block; height: 100%; border-radius: 4px; }
.z-tt-roll-v { text-align: right; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.z-tt-roll-v span { color: var(--muted); font-size: 11px; }
.z-tt-table { font-size: 12.5px; overflow-x: auto; }
.z-tt-row { display: grid; grid-template-columns: 68px minmax(56px,1fr) 110px 42px 70px 80px; align-items: center; gap: 4px; padding: 7px 8px; border-bottom: 1px solid var(--border); border-radius: 6px; }
.z-tt-bull { color: var(--green-dark); }
.z-tt-bear { color: var(--red-text); }
.z-tt-r { text-align: right; font-variant-numeric: tabular-nums; }
.z-tt-prem { font-weight: 700; }
.z-tt-time { color: inherit; opacity: .78; font-variant-numeric: tabular-nums; }
.z-tt-score { font-variant-numeric: tabular-nums; font-weight: 600; opacity: .85; display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
.z-tt-swi { color: var(--amber-text); }
.z-tt-closed { opacity: .5; }
.z-tt-empty { padding: 16px 8px; color: var(--faint); font-size: 13px; text-align: center; }
.z-tt-foot { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--faint); line-height: 1.5; }
.z-mono { font-family: ui-monospace, monospace; font-size: 11px; background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }

.z-unpin { border: 2px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.z-unpin-wait { background: var(--panel-2); opacity: .92; }
.z-unpin-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.z-unpin-tag { margin: 0; font-size: 18px; font-weight: 700; }
.z-live-hdir { font-size: 13px; font-weight: 700; margin-left: auto; }
.z-live-hdir-would { opacity: .75; }
.z-unpin-badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.z-live-waitbadge { font-size: 11px; font-weight: 700; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); padding: 3px 10px; border-radius: 999px; }
.z-unpin-tell { font-size: 11.5px; color: var(--muted); }
.z-unpin-row { margin-bottom: 8px; }

.z-cmp-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 0 0 16px; }
.z-cmp { border: 1px solid var(--border); background: var(--panel-2); border-radius: 10px; padding: 12px 14px; }
.z-cmp-tag { display: block; font-size: 10.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--faint); margin-bottom: 6px; }
.z-cmp-line { margin: 0; font-size: 12.5px; color: var(--text); line-height: 1.5; }
.z-cmp-wait { color: var(--muted); }

.z-eval { border: 1px solid var(--border); background: var(--panel);
  border-radius: 10px; padding: 16px; margin: 0 0 16px; }
.z-eval header { display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.z-eval h2 { margin: 0; font-size: 15px; }
.z-eval header span { color: var(--muted); font-size: 12px; }
.z-eval-wait { margin: 0; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
.z-eval-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-md); }
.z-eval-grid > div { display: flex; flex-direction: column; gap: 2px; }
.z-eval-grid b { font-size: 20px; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }

.z-aggr { font-size: 11px; white-space: nowrap; color: var(--faint); }
.z-aggr b { font-size: 10.5px; letter-spacing: .03em; }
.z-aggr small { display: inline-block; margin-left: 4px; font-size: 9.5px;
  color: var(--faint); opacity: .8; }
.z-aggr-compra { color: var(--green-dark); }
.z-aggr-venta { color: #b42318; }
.z-aggr-mixto, .z-aggr-mid { color: var(--muted); }
.z-aggr-note { text-align: center !important; font-weight: 500 !important;
  text-transform: none !important; letter-spacing: 0 !important;
  font-size: 11px !important; color: var(--muted) !important;
  background: var(--panel) !important; padding: 6px !important; }

.z-daybar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0 16px; }
.z-daybar-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--muted); font-weight: 600; margin-right: 4px; }
.z-daychip { display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border); background: var(--panel); color: var(--text); line-height: 1.2; }
.z-daychip em { font-style: normal; font-size: 10px; color: var(--faint); letter-spacing: .03em; }
.z-daychip:hover { border-color: var(--border); background: var(--panel-2); }
.z-daychip-on { border: 2px solid var(--accent); color: var(--accent); font-weight: 600; padding: 5px 13px; }
.z-daychip-on em { color: var(--accent); }

.z-future { background: var(--amber-bg); border: 1px solid var(--amber-border);
  color: var(--amber-text); padding: 10px 14px; border-radius: 8px; margin: 0 0 16px;
  font-size: 12.5px; line-height: 1.5; }

.z-outlook { border: 1px solid var(--border); border-left-width: 4px; background: var(--panel);
  border-radius: 12px; padding: 18px 20px; margin: 0 0 16px; }
.z-lean-alcista { border-left-color: var(--green); }
.z-lean-bajista { border-left-color: var(--red); }
.z-lean-lateral { border-left-color: var(--muted); }
.z-outlook-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.z-outlook-tag { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); font-weight: 600; }
.z-lean-chip { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
.z-lean-chip-alcista { background: var(--green-bg); color: var(--green-dark); }
.z-lean-chip-bajista { background: var(--red-bg); color: #b42318; }
.z-lean-chip-lateral { background: var(--panel-2); color: var(--muted); }
.z-conf { margin-left: auto; font-size: 11px; color: var(--faint); }
.z-outlook-head { margin: 0 0 14px; font-size: 20px; font-weight: 700; letter-spacing: -0.3px;
  line-height: 1.35; font-variant-numeric: tabular-nums; }
.z-outlook-range { display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
  font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-range-bar { position: relative; flex: 1; height: 30px; }
.z-range-fill { position: absolute; top: 12px; left: 0; right: 0; height: 6px;
  background: linear-gradient(90deg, var(--red-bg), var(--panel-2), var(--green-bg));
  border-radius: 3px; }
.z-range-now { position: absolute; top: 0; transform: translateX(-50%); font-size: 12px;
  font-weight: 700; color: var(--accent); white-space: nowrap;
  background: var(--panel); padding: 0 4px; border-radius: 4px; }
.z-range-now::after { content: ""; position: absolute; left: 50%; top: 18px; width: 2px; height: 12px;
  background: var(--accent); transform: translateX(-50%); }
.z-range-magnet { position: absolute; bottom: -2px; transform: translateX(-50%); font-size: 10px;
  color: var(--amber-text); background: var(--amber-bg); padding: 1px 5px; border-radius: 4px;
  border: 1px solid var(--amber-border); white-space: nowrap; }
.z-outlook-detail { margin: 0 0 8px; font-size: 13px; color: var(--text); line-height: 1.5; }
.z-flow { display: flex; flex-direction: column; gap: 5px; margin: 0 0 10px;
  padding: 8px 10px; background: var(--panel-2); border-radius: 8px; }
.z-flow-line { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.45;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.z-flow-tag { font-size: 9.5px; font-weight: 700; letter-spacing: .06em; padding: 2px 6px;
  border-radius: 4px; background: var(--accent-dim); color: var(--accent); }
.z-flow-tag-flow { background: var(--green-bg); color: var(--green-dark); }
.z-flow-bar { display: inline-block; width: 70px; height: 5px; border-radius: 3px;
  background: var(--border); position: relative; overflow: hidden; }
.z-flow-bar i { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
.z-outlook-caveat { margin: 0; font-size: 11.5px; color: var(--faint); line-height: 1.45; }

.z-gex { border: 1px solid var(--border); background: var(--panel);
  border-radius: 10px; padding: 16px; margin: 0 0 16px; border-left-width: 3px; }
.z-gex-positive { border-left-color: var(--green); }
.z-gex-negative { border-left-color: var(--red); }
.z-gex header { display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.z-gex h2 { margin: 0; font-size: 15px; }
.z-gex header span { color: var(--muted); font-size: 12px; }
.z-gex-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: var(--space-md); }
.z-gex-grid > div { display: flex; flex-direction: column; gap: 2px; }
.z-gex-grid b { font-size: 20px; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }
.z-gex-positive .z-gex-grid > div:first-child b { color: var(--green-dark); }
.z-gex-negative .z-gex-grid > div:first-child b { color: #b42318; }
.z-gex-grid .z-sum-sub { line-height: 1.45; }

.z-fc { border: 1px solid var(--border); background: var(--panel);
  border-radius: 10px; padding: 16px; margin: 0 0 16px; }
.z-fc header { display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.z-fc h2 { margin: 0; font-size: 15px; }
.z-fc header span { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.z-fc-caveat { background: var(--amber-bg); border: 1px solid var(--amber-border);
  color: var(--amber-text); padding: 8px 12px; border-radius: 6px;
  font-size: 12.5px; margin-bottom: 12px; }
.z-fc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-md); }
.z-fc-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 3px; background: var(--panel-2); }
.z-fc-card b { font-size: 22px; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; }
.z-fc-card p { margin: 6px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.45; }
.z-fc-pct { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.z-fc-bull { border-left: 3px solid var(--green); }
.z-fc-bull b, .z-fc-bull .z-fc-pct { color: var(--green-dark); }
.z-fc-bear { border-left: 3px solid var(--red); }
.z-fc-bear b, .z-fc-bear .z-fc-pct { color: #b42318; }
.z-fc-base { border-left: 3px solid var(--accent); }
.z-fc-base b, .z-fc-base .z-fc-pct { color: var(--accent); }
.z-fc-prob { position: relative; margin-top: 8px; height: 16px;
  background: var(--border-soft); border-radius: 4px; overflow: hidden; }
.z-fc-prob i { position: absolute; inset: 0 auto 0 0; background: var(--accent-dim); }
.z-fc-prob span { position: relative; z-index: 1; font-size: 10.5px; line-height: 16px;
  padding-left: 6px; color: var(--text); font-weight: 600; }

.z-toprow td { background: #ffeeba; }
.z-magnet { background: #d1d5db !important; }
.z-magnetrow td:not(.z-magnet) { background: #eceef1; }
.z-magnet-tag { font-style: normal; margin-right: 3px; font-size: 11px; }
.z-top { position: relative; }
.z-top span { font-weight: 800; font-size: 14px; }
.z-top-call span { color: var(--green-dark); }
.z-top-put span { color: #b42318; }
.z-tag { position: absolute; top: 50%; transform: translateY(-50%);
  font-size: 9px; font-style: normal; font-weight: 700; letter-spacing: .06em;
  padding: 2px 5px; border-radius: 4px; white-space: nowrap; }
.z-top-call .z-tag { left: 8px; background: var(--green-bg); color: var(--green-dark); }
.z-top-put .z-tag { left: 8px; background: var(--red-bg); color: #b42318; }
.z-top-call span { padding-left: 4px; }
.z-toprow .z-bar { height: 5px; }

.z-cvd { border: 1px solid var(--border); border-left: 4px solid var(--accent); background: var(--panel);
  border-radius: 12px; padding: 16px 18px 0; margin: 0 0 16px; overflow: hidden; }
.z-cvd-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 14px; }
.z-cvd-title { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.z-cvd-pill { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
.z-cvd-pill-venta { background: var(--red-bg); color: #b42318; }
.z-cvd-pill-compra { background: var(--green-bg); color: var(--green-dark); }
.z-cvd-pill-neutral { background: var(--panel-2); color: var(--muted); }
.z-cvd-count { margin-left: auto; font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }

.z-cvd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.z-cvd-col { display: flex; flex-direction: column; gap: 3px; padding-bottom: 14px; }
.z-cvd-lbl { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.z-cvd-big { font-size: 26px; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; color: var(--text); margin-top: 2px; }
.z-cvd-net-venta { color: #b42318; }
.z-cvd-net-compra { color: var(--green-dark); }
.z-cvd-sub { font-size: 11.5px; color: var(--faint); margin-bottom: 8px; }

.z-cvd-track { position: relative; height: 6px; border-radius: 3px; background: var(--border-soft); overflow: hidden; }
.z-cvd-track i { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 3px; }
.z-cvd-scale { display: flex; justify-content: space-between; font-size: 10px; color: var(--faint); margin: 4px 0 10px; }

.z-cvd-bars { display: flex; align-items: flex-end; gap: 6px; height: 46px; }
.z-cvd-bars i { flex: 1; background: var(--border); border-radius: 3px 3px 0 0; min-height: 4px; }

.z-cvd-slider { position: relative; height: 6px; border-radius: 3px; background: var(--border-soft); }
.z-cvd-slider-mark { position: absolute; top: -3px; width: 14px; height: 12px; margin-left: -7px;
  border-radius: 3px; }
.z-cvd-slider-venta { background: #d92d20; }
.z-cvd-slider-compra { background: #12b76a; }
.z-cvd-slider-neutral { background: var(--muted); }

.z-cvd-spark { width: 100%; height: 30px; margin-top: 4px; overflow: visible; }
.z-cvd-spark-base { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3 3; }
.z-cvd-spark-line { fill: none; stroke-width: 1.6; }
.z-cvd-spark-venta { stroke: #d92d20; }
.z-cvd-spark-compra { stroke: #12b76a; }
.z-cvd-spark-neutral { stroke: var(--muted); }

.z-cvd-note { margin: 0 -18px 0; padding: 10px 18px; background: var(--panel-2); font-size: 12.5px;
  color: var(--text); line-height: 1.5; border-top: 1px solid var(--border-soft); }

@media (max-width: 640px) {
  .z-cvd-grid { grid-template-columns: 1fr; gap: 14px; }
}

.z-spreads { border: 1px solid var(--border); background: var(--panel);
  border-radius: 10px; padding: 16px; margin: 0 0 16px; }
.z-spreads header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.z-spreads h2 { margin: 0; font-size: 15px; }
.z-spreads-bias { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  background: var(--panel-2); color: var(--muted); }
.z-spreads-bias-alcista { background: var(--green-bg); color: var(--green-dark); }
.z-spreads-bias-bajista { background: var(--red-bg); color: #b42318; }

.z-spreads-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-md); }
.z-spread-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 4px; background: var(--panel-2); }
.z-spread-card b { font-size: 17px; letter-spacing: -0.2px; }
.z-spread-legs { font-size: 12px; color: var(--muted); }
.z-spread-empty { margin: 4px 0 0; font-size: 12px; color: var(--faint); line-height: 1.5; }
.z-spread-nums { display: flex; flex-direction: column; gap: 3px; margin-top: 8px;
  padding-top: 8px; border-top: 1px solid var(--border-soft); }
.z-spread-nums > div { display: flex; justify-content: space-between; font-size: 12.5px; }
.z-spread-nums span { color: var(--muted); }
.z-spread-nums b { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.z-spread-good { color: var(--green-dark); }

.z-spreads-note { margin: 14px 0 0; font-size: 11.5px; color: var(--faint); line-height: 1.5; }
`;
