"use client";

// Agente 0DTE — cadena del vencimiento de hoy con los strikes de mayor volumen.
// Calls a la izquierda, strike al centro, puts a la derecha. Ver Proceso 0DTE.md.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainLine, ZeroDteResult } from "@/lib/pdf/odteStandalone/zerodte";
import type { AggressorRead } from "@/lib/pdf/odteStandalone/zerodteFlow";
import { DEFAULT_PARAMS, dynamicParams, evaluateEntry, gateEntry, noSetupReason, riskReward, type EntryDecision } from "@/lib/pdf/odteStandalone/zerodteStrategy";
import { altOutlook, altTradeState, confirmMomentum, despinEstimate, gammaWalls, momentumEntry, momentumStreak, MOMENTUM_PERSISTENCE_REQUIRED, type AltFlowCtx, type Conf, type Lean } from "@/lib/pdf/odteStandalone/zerodteAlt";
import { pickTicket, type TicketChainRow } from "@/lib/pdf/odteStandalone/zerodteTicket";
import { unpinRead, type UnpinRead } from "@/lib/pdf/odteStandalone/zerodteUnpin";
import type { StrategySuggestions } from "@/lib/pdf/odteStandalone/strategySuggestions";
import ZeroDteChart from "@/app/prueba-de-fuego/_components/OdteStandaloneChart";
import { asLang, type Lang } from "@/lib/pdf/odteStandalone/i18n";
import { CONFIDENCE, DICT, type Dict, WEEKDAYS } from "./odteStandaloneI18n";

interface FlowState {
  cycles: number;
  contracts: number;
  reads: Record<string, AggressorRead>;
  error?: string;
  // Totales del día para el panel "Volumen en vivo".
  buyAggr?: number;
  sellAggr?: number;
  midAggr?: number;
  totalVol?: number;
  newestTs?: number;
  topSell?: { strike: number; type: string; net: number } | null;
  topBuy?: { strike: number; type: string; net: number } | null;
  topTrades?: TopTrade[];
}

// Un "contrato entrante": bloque grande single-leg 0DTE que cumplió los filtros.
interface TopTrade {
  ts: number;
  strike: number;
  type: "call" | "put";
  side: "buy" | "sell" | "mid"; // agresor: al ask / al bid / medio
  price: number;
  size: number;
  premium: number;
  delta: number;
  volume: number;
  oi?: number;
  open?: boolean; // apertura estimada (vol > OI): posicionamiento nuevo
  gamma?: number | null;
  sweep?: boolean; // orden intermarket (urgente)
  slKnown?: boolean; // ¿el filtro single-leg estaba activo de verdad?
}

interface EvalState {
  empty?: boolean;
  message?: string;
  error?: string;
  maturedCount?: number;
  meanAbsErrorPct?: number | null;
  biasPct?: number | null;
  baseTouchRate?: number | null;
  bullTouchRate?: number | null;
  bearTouchRate?: number | null;
  closingMeanAbsErrorPts?: number | null;
  closingHitRate?: number | null;
  closingCount?: number;
}

// Refresco ADAPTATIVO por hora ET (solo hoy): 30s en las franjas activas
// —apertura 9:30–12:00 y última hora 15:00–16:00— y 60s en la calma del mediodía
// (12:00–15:00) y fuera de RTH. Lun–vie; fin de semana usa el largo.
function refreshDelayMs(): number {
  const { wd, min } = etNow();
  if (wd === "Sat" || wd === "Sun") return 60_000;
  const fast = (min >= 570 && min < 720) || (min >= 900 && min < 960); // 9:30–12:00 o 15:00–16:00
  return fast ? 30_000 : 60_000;
}

const nf = new Intl.NumberFormat("en-US");
const num = (v: number | null | undefined) => (v == null ? "—" : nf.format(v));
const dec = (v: number | null | undefined, d = 2) =>
  v == null ? "—" : v.toFixed(d);

// Posición 0-100% de un precio dentro del rango [low, high] del panorama.
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

// Hoy en hora de Nueva York (YYYY-MM-DD), igual que el servidor.
function etTodayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Hoy + los próximos `count` días hábiles (salta fin de semana). Se ancla a
// mediodía UTC para que el corte de día coincida con la fecha ET.
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

function dayLabel(date: string, i: number, lang: Lang): string {
  if (i === 0) return DICT[lang].today;
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `${WEEKDAYS[lang][wd]} ${Number(date.slice(8, 10))}`;
}

// Hora de Nueva York AHORA: día de semana + minutos desde medianoche.
function etNow(): { wd: string; min: number } {
  const now = new Date();
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24;
  const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
  return { wd, min: h * 60 + m };
}

// ¿Sesión RTH de opciones de índice abierta? (lun-vie 9:30-16:00 ET). Para
// SPX/SPY/QQQ, cuyas opciones solo operan en horario regular.
function marketOpenNow(): boolean {
  const { wd, min } = etNow();
  if (wd === "Sat" || wd === "Sun") return false;
  return min >= 570 && min < 960; // 9:30–16:00
}

// ¿Sesión de FUTUROS de CME abierta? Los futuros de índice (ES/NQ) operan casi
// 24h: domingo 18:00 ET → viernes 17:00 ET, con corte de mantenimiento diario
// 17:00–18:00 ET. Aproxima (ignora feriados de CME). Para /ES y /NQ nativos,
// cuyo flujo viene de Tastytrade en vivo fuera de RTH.
function futuresSessionOpenNow(): boolean {
  const { wd, min } = etNow();
  const inBreak = min >= 1020 && min < 1080; // 17:00–18:00 mantenimiento
  if (wd === "Sat") return false;
  if (wd === "Sun") return min >= 1080; // abre a las 18:00 del domingo
  if (wd === "Fri") return min < 1020 && !inBreak; // cierra a las 17:00 del viernes
  return !inBreak; // lun–jue: abierto salvo el corte
}
function etClock(): string {
  return new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
}

export default function ZeroDtePage() {
  const [data, setData] = useState<ZeroDteResult | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [evalu, setEvalu] = useState<EvalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ticker, setTicker] = useState("SPX");
  // MOC manual (el usuario pega el imbalance del tweet 3:50pm). Solo cliente,
  // persistido en localStorage por día ET; se ignora si es de un día anterior.
  const [mocVal, setMocVal] = useState<string>("");
  const [mocSide, setMocSide] = useState<"buy" | "sell" | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("z-moc");
      if (!raw) return;
      const m = JSON.parse(raw) as { val?: string; side?: "buy" | "sell" | null; date?: string };
      if (m.date === etTodayStr()) { setMocVal(m.val ?? ""); setMocSide(m.side ?? null); }
    } catch { /* noop */ }
  }, []);
  const saveMoc = (val: string, side: "buy" | "sell" | null) => {
    setMocVal(val); setMocSide(side);
    try { localStorage.setItem("z-moc", JSON.stringify({ val, side, date: etTodayStr() })); } catch { /* noop */ }
  };
  const [days] = useState<string[]>(() => expirationDays(5));
  const [selDate, setSelDate] = useState<string>(() => etTodayStr());
  // Panel "contratos entrantes": qué trades son NUEVOS respecto al refresh previo.
  const [newTopTs, setNewTopTs] = useState<Set<number>>(() => new Set());
  const prevTop = useRef<{ ticker: string; newest: number } | null>(null);
  // Idioma: inglés por defecto; se lee del navegador tras montar (evita desajuste
  // de hidratación) y se persiste al cambiar. Cambiar idioma refresca los datos
  // para traer la prosa del backend (?lang=) en el nuevo idioma.
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => { setLang(asLang(localStorage.getItem("zerodte-lang"))); }, []);
  // Tema claro/oscuro: guardado en localStorage; si no hay, respeta el del sistema.
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const saved = localStorage.getItem("zerodte-theme");
    setTheme(saved === "dark" || saved === "light" ? saved : (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("zerodte-theme", theme); } catch { /* modo privado */ }
  }, [theme]);
  const tr = DICT[lang];
  const changeLang = (l: Lang) => {
    setLang(l);
    try { localStorage.setItem("zerodte-lang", l); } catch { /* modo privado */ }
  };

  // Marca como "nuevos" los contratos entrantes cuyo ts supera al más nuevo del
  // refresh anterior (del mismo ticker). Al cambiar de ticker, ninguno es nuevo.
  useEffect(() => {
    const tt = (flow?.topTrades ?? []) as TopTrade[];
    const newest = tt.reduce((m, t) => Math.max(m, t.ts || 0), 0);
    const prev = prevTop.current;
    setNewTopTs(!prev || prev.ticker !== ticker ? new Set() : new Set(tt.filter((t) => (t.ts || 0) > prev.newest).map((t) => t.ts)));
    prevTop.current = { ticker, newest };
  }, [flow, ticker]);

  // Registro comparativo (original vs alterna del "next 5 min"). Se postea el
  // snapshot actual una vez por minuto; el panel muestra la evaluación acumulada.
  const altSnapRef = useRef<{ ticker: string; spot: number; ol: Lean; al: Lean; w: number } | null>(null);
  const [altEval, setAltEval] = useState<{ n: number; origRate: number | null; altRate: number | null; bothActive: number; altBetterWhenActive: number } | null>(null);
  useEffect(() => {
    const post = () => {
      const s = altSnapRef.current;
      if (!s) return;
      fetch("/api/pdf/odte-standalone/alt-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, sec: Math.floor(Date.now() / 1000) }) }).catch(() => {});
    };
    post();
    const id = setInterval(post, 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!data?.isToday) { setAltEval(null); return; }
    fetch(`/api/pdf/odte-standalone/alt-log?ticker=${encodeURIComponent(ticker)}`).then((r) => r.json()).then(setAltEval).catch(() => {});
  }, [data, ticker]);

  // Registro comparativo de TRADES (GEX Trade original vs alterno). Mismo patrón:
  // cada minuto se postea la señal activa de cada uno; el panel muestra el win-rate.
  const tradeSnapRef = useRef<{ ticker: string; spot: number; o: { d: "long" | "short"; tgt: number; stop: number } | null; a: { d: "long" | "short"; tgt: number; stop: number; m: boolean } | null } | null>(null);
  const [tradeEval, setTradeEval] = useState<{ origResolved: number; origRate: number | null; altResolved: number; altRate: number | null; differed: number; differedWon: number } | null>(null);
  useEffect(() => {
    const post = () => {
      const s = tradeSnapRef.current;
      if (!s) return;
      fetch("/api/pdf/odte-standalone/trade-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, sec: Math.floor(Date.now() / 1000) }) }).catch(() => {});
    };
    post();
    const id = setInterval(post, 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!data?.isToday) { setTradeEval(null); return; }
    fetch(`/api/pdf/odte-standalone/trade-log?ticker=${encodeURIComponent(ticker)}`).then((r) => r.json()).then(setTradeEval).catch(() => {});
  }, [data, ticker]);

  // Registro CRUDO del contexto de momentum (γ−), para poder recalibrar
  // MOMENTUM_DEFAULTS después con datos reales — ver momentumCalibration.ts.
  // A diferencia de trade-log (la señal ya calculada), acá se guarda el INSUMO
  // sin procesar: cambiar los parámetros más adelante no invalida lo acumulado.
  const momentumRawRef = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    const post = () => {
      // Acumula la lectura CRUDA de este minuto para la persistencia del
      // momentum γ− (confirmMomentum) — mismo ritmo (1/min) que el journal.
      const arr = momentumHistoryRef.current;
      arr.push(altMomentumRawRef.current);
      if (arr.length > 10) arr.shift();
      setMomentumTick((x) => x + 1);
      const s = momentumRawRef.current;
      if (!s) return;
      fetch("/api/pdf/odte-standalone/momentum-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, sec: Math.floor(Date.now() / 1000) }) }).catch(() => {});
    };
    post();
    const id = setInterval(post, 60_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async (t: string, date: string) => {
    setLoading(true);
    setError(null);
    const isToday = date === etTodayStr();

    // El agresor y la precisión son intradía: solo aplican a 0DTE (hoy). En un
    // vencimiento futuro no se piden (no tendría sentido el tape de hoy sobre
    // otra expiración).
    let flowPromise: Promise<void> = Promise.resolve();
    if (isToday) {
      flowPromise = fetch(`/api/pdf/odte-standalone/flow?ticker=${encodeURIComponent(t)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setFlow(j as FlowState))
        .catch(() => setFlow(null));
      fetch(`/api/pdf/odte-standalone/eval?ticker=${encodeURIComponent(t)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setEvalu(j as EvalState))
        .catch(() => setEvalu(null));
    } else {
      setFlow(null);
      setEvalu(null);
    }

    try {
      const res = await fetch(
        `/api/pdf/odte-standalone?ticker=${encodeURIComponent(t)}&date=${encodeURIComponent(date)}&lang=${lang}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as ZeroDteResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : DICT[lang].unknownError);
      setData(null);
    } finally {
      setLoading(false);
      await flowPromise;
    }
  }, [lang]);

  useEffect(() => {
    load(ticker, selDate);
    // El refresco automático solo tiene sentido en vivo (hoy). En un vencimiento
    // futuro la cadena apenas cambia; no hace falta refrescar cada 5 min.
    if (selDate !== etTodayStr()) return;
    // Auto-reprogramado: recalcula el intervalo (30s/60s) en cada ciclo según la hora.
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { load(ticker, selDate); timer = setTimeout(tick, refreshDelayMs()); };
    timer = setTimeout(tick, refreshDelayMs());
    return () => clearTimeout(timer);
  }, [ticker, selDate, load]);

  // "Mejor trade ahora": se evalúa EN VIVO en cada refresco desde la señal
  // actual (spot + GEX), sin llamar al servidor. Solo para hoy.
  // Parámetros DINÁMICOS por volatilidad: la distancia de activación y los stops
  // se escalan con σ (expected move a cierre) y con el precio del instrumento, con
  // piso por ticker. Sustituye al fijo de 5/15/8 pts (mis-calibrado entre tickers).
  const liveParams = useMemo(() => {
    if (!data || data.spot == null) return DEFAULT_PARAMS;
    // σ = expected move a cierre (ya calculado server-side en el forecast).
    const sigma = data.forecast?.sigma ?? null;
    return dynamicParams(data.spot, sigma, ticker);
  }, [data, ticker]);

  const live = useMemo(() => {
    if (!data || !data.isToday || data.spot == null) return null;
    return evaluateEntry(data.spot, data.gex.regime, data.gex.kingStrike, data.gex.flipStrike, liveParams, data.basis ?? 0, lang);
  }, [data, lang, liveParams]);

  // Detecta si el setup cambió respecto al refresco anterior (para avisar).
  const prevDir = useRef<string | null>(null);
  const [justChanged, setJustChanged] = useState(false);
  useEffect(() => {
    if (!data?.isToday) { prevDir.current = null; return; }
    const dir = live ? live.direction : "none";
    setJustChanged(prevDir.current !== null && prevDir.current !== dir);
    prevDir.current = dir;
  }, [live, data?.isToday]);

  // --- Volumen en vivo (velocidad + CVD) ---------------------------------
  // El backend da los totales ACUMULADOS del día (buyAggr/sellAggr/…) en cada
  // refresco. Aquí se guarda una muestra por minuto y se derivan: la VELOCIDAD
  // (contratos del último minuto vs el promedio de la ventana) y el CVD (agresor
  // neto = compra − venta). La serie se acumula mientras la página está abierta.
  const volSeries = useRef<{ t: number; tape: number; cvd: number }[]>([]);
  const [volTick, setVolTick] = useState(0);
  useEffect(() => { volSeries.current = []; setVolTick((x) => x + 1); }, [ticker, selDate]);

  // --- Persistencia del momentum γ− (confirmMomentum, zerodteAlt.ts) -----
  // Historial de lecturas CRUDAS de momentumEntry (una por minuto, mismo
  // cadencia que el registro en data/odte-standalone/momentum-raw/). Solo se
  // trata como trade real cuando la MISMA señal se sostiene
  // MOMENTUM_PERSISTENCE_REQUIRED lecturas seguidas — evita operar un
  // parpadeo de 1 minuto de flujo agresivo (mismo principio que
  // applyPersistence en Contratos Vecinos 3.0). altMomentumRawRef guarda la
  // lectura cruda del render actual; el intervalo de 1 min (más abajo) la
  // acumula al mismo ritmo que ya loguea el momentum-raw journal.
  const momentumHistoryRef = useRef<(EntryDecision | null)[]>([]);
  const altMomentumRawRef = useRef<EntryDecision | null>(null);
  const [momentumTick, setMomentumTick] = useState(0);
  useEffect(() => { momentumHistoryRef.current = []; setMomentumTick((x) => x + 1); }, [ticker, selDate]);
  useEffect(() => {
    if (!flow || flow.error || flow.buyAggr == null) return;
    const tape = (flow.buyAggr ?? 0) + (flow.sellAggr ?? 0) + (flow.midAggr ?? 0);
    const cvd = (flow.buyAggr ?? 0) - (flow.sellAggr ?? 0);
    const arr = volSeries.current;
    const last = arr[arr.length - 1];
    if (!last || last.tape !== tape || last.cvd !== cvd) {
      arr.push({ t: Date.now(), tape, cvd });
      if (arr.length > 24) arr.shift();
      setVolTick((x) => x + 1);
    }
  }, [flow]);

  const vol = useMemo(() => {
    const arr = volSeries.current;
    if (arr.length < 2) return null;
    const deltas: number[] = [];
    for (let i = 1; i < arr.length; i++) deltas.push(Math.max(0, arr[i].tape - arr[i - 1].tape));
    const cur = deltas[deltas.length - 1] ?? 0;
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length || 1;
    const velocity = avg > 0 ? cur / avg : 0;
    const cvdSeries = arr.map((a) => a.cvd);
    const cvd = cvdSeries[cvdSeries.length - 1] ?? 0;
    const cvdPrev = cvdSeries[Math.max(0, cvdSeries.length - 4)] ?? cvd;
    return { deltas, cur, velocity, cvd, cvdSeries, rising: cvd > cvdPrev, n: arr.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volTick]);

  // El volumen mayor de toda la tabla marca la escala de las barras.
  const maxVol = data
    ? Math.max(
        1,
        ...data.lines.flatMap((l) => [l.call?.volume ?? 0, l.put?.volume ?? 0]),
      )
    : 1;

  const spot = data?.spot ?? null;
  // La tabla va de mayor a menor, así que la marca de precio entra en la
  // primera fila que ya cae POR DEBAJO del spot.
  const spotAt = data && spot != null
    ? data.lines.findIndex((l) => l.strike < spot)
    : -1;

  // Futuros nativos (/ES, /NQ): el backend ya devuelve todo en términos del
  // futuro, así que basis = 0 y cv() solo cuadra al tick de 0.25. (Con rollback
  // NATIVE_FUTURES=0 se analiza sobre el índice y basis != 0 convierte los
  // niveles.) El texto lo convierte el backend; los números sueltos, este cv().
  const basis = data?.basis ?? 0;
  const isFut = !!data?.future;
  // GEX Pinning (pronóstico de cierre) es SOLO para SPX — el índice con el pin de
  // gamma más limpio hacia el cierre. En los demás tickers la sección no se muestra.
  const isSpx = (data?.ticker ?? "").replace(/^\//, "").toUpperCase() === "SPX";
  // Futuro NATIVO (flujo de Tastytrade ~23h): se analiza a sí mismo (sin proxy),
  // así que se rige por el horario de FUTUROS, no por RTH. En rollback
  // (analysisTicker != future) el flujo es del índice y manda RTH.
  const isNativeFut = isFut && data?.analysisTicker === data?.future;
  const cv = (v: number) => (isFut ? Math.round((v + basis) * 4) / 4 : v);
  const cvN = (v: number | null | undefined) => (v == null ? null : cv(v));

  // Datos listos para dibujar el panel de volumen (histograma + línea del CVD).
  const volView = vol ? (() => {
    const d = vol.deltas.slice(-12);
    const dmx = Math.max(1, ...d);
    const dbw = 240 / d.length;
    const bars = d.map((val, i) => {
      const h = Math.max(1, (val / dmx) * 44);
      return { x: i * dbw + 2, w: Math.max(1, dbw - 4), h, y: 48 - h, last: i === d.length - 1 };
    });
    const s = vol.cvdSeries.slice(-12);
    const smx = Math.max(1, ...s.map((x) => Math.abs(x)));
    const step = 240 / Math.max(1, s.length - 1);
    const pts = s.map((val, i) => `${i * step},${(26 - (val / smx) * 22).toFixed(1)}`).join(" ");
    const cvdScale = Math.max(1, ...vol.cvdSeries.map((x) => Math.abs(x)));
    const divW = Math.min(Math.abs(vol.cvd) / cvdScale, 1) * 50;
    return { bars, pts, divW };
  })() : null;

  // Lectura: liga el CVD al setup en vivo — el "¿me quedo o salgo?".
  const volVerdict = (() => {
    if (!vol) return "";
    const es = lang === "es";
    const fast = vol.velocity >= 1.5;
    const buy = vol.cvd >= 0;
    const dirWord = buy ? (es ? "compra" : "buying") : (es ? "venta" : "selling");
    let s = fast
      ? (es ? `Volumen fuerte y el agresor va a ${dirWord}.` : `Strong volume and the aggressor is ${dirWord}.`)
      : (es ? `Volumen tranquilo, agresor ${dirWord}.` : `Calm volume, aggressor ${dirWord}.`);
    if (live) {
      const dLbl = live.direction === "long" ? "LONG" : "SHORT";
      const against = (live.direction === "long" && !buy) || (live.direction === "short" && buy);
      s += against
        ? (es ? ` ⚠️ Va EN CONTRA de tu ${dLbl} al imán — vigila la salida.` : ` ⚠️ It goes AGAINST your ${dLbl} to the magnet — watch the exit.`)
        : (es ? ` A favor de tu ${dLbl} — el pin tiene combustible.` : ` In favor of your ${dLbl} — the pin has fuel.`);
    }
    return s;
  })();

  // CVD directo del flujo (disponible siempre, sin necesidad de la serie): así el
  // panel muestra el agresor neto aunque no haya arrancado la serie o esté cerrado.
  const flowCvd = flow?.buyAggr != null ? flow.buyAggr - (flow.sellAggr ?? 0) : null;
  const flowDivW = flowCvd != null && flow
    ? Math.min(Math.abs(flowCvd) / Math.max(1, (flow.buyAggr ?? 0) + (flow.sellAggr ?? 0)), 1) * 50
    : 0;
  // Sesión activa AHORA según el instrumento: futuros nativos → horario CME
  // (~23h); índices/ETF → RTH 9:30-16:00.
  const sessionOpen = isNativeFut ? futuresSessionOpenNow() : marketOpenNow();
  const marketOpen = sessionOpen;

  // --- Contratos entrantes: resumen + rollup por strike + feed ---
  const usd = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);
  // Net GEX con signo y escala ($ por 1% de movimiento, como GammaFlow).
  const gexUsd = (n: number) => {
    const s = n >= 0 ? "+" : "−"; const a = Math.abs(n);
    return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(0)}M` : `${s}$${Math.round(a)}`;
  };
  const allTop = (flow?.topTrades ?? []) as TopTrade[];
  // Solo TAKERS: tomaron liquidez con urgencia (compra al ask / vende al bid). El
  // mid es pasivo y no mueve el precio; se descarta de la señal (pero se cuenta).
  const takers = allTop.filter((t) => t.side === "buy" || t.side === "sell");
  const discMid = allTop.length - takers.length;          // bloques pasivos (mid)
  const discClose = takers.filter((t) => !t.open).length;  // takers de cierre
  // IMPACTO = premium × |gamma| = contribución al hedging del dealer = lo que
  // realmente mueve el precio. Si el feed aún no trae gamma, cae a solo premium.
  const hasGamma = takers.some((t) => typeof t.gamma === "number" && isFinite(t.gamma as number));
  const impact = (t: TopTrade) => t.premium * (hasGamma ? Math.abs(Number(t.gamma) || 0) : 1);
  // La SEÑAL usa aperturas agresivas; si no hay, cae a todos los takers.
  const opensAgg = takers.filter((t) => t.open);
  const sig = opensAgg.length ? opensAgg : takers;
  // Sesgo direccional (en $ de premium agresivo) + quién domina (calls vs puts).
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
  // Rollup por strike+tipo, rankeado por IMPACTO (premium×gamma), top 4. El score
  // 0-100 es relativo al strike de mayor impacto del ciclo.
  const rollMap = new Map<string, { strike: number; type: "call" | "put"; imp: number; prem: number; n: number }>();
  for (const t of sig) {
    const key = `${t.strike}:${t.type}`;
    const r = rollMap.get(key) ?? { strike: t.strike, type: t.type, imp: 0, prem: 0, n: 0 };
    r.imp += impact(t); r.prem += t.premium; r.n += 1;
    rollMap.set(key, r);
  }
  const ttRollup = [...rollMap.values()].sort((a, b) => b.imp - a.imp).slice(0, 4);
  const ttRollMax = ttRollup[0]?.imp ?? 1;
  // El tape: solo takers, sweeps al tope, luego cronológico. Score 0-100 por impacto.
  const impMaxRow = Math.max(1, ...takers.map(impact));
  const scoreOf = (t: TopTrade) => Math.round((impact(t) / impMaxRow) * 100);
  const ttFeed = [...takers].sort((a, b) => (b.sweep ? 1 : 0) - (a.sweep ? 1 : 0) || b.ts - a.ts).slice(0, 12);
  const ttNewCount = ttFeed.filter((t) => newTopTs.has(t.ts)).length;
  const ttSlActive = allTop.some((t) => t.slKnown);
  const ttMagnet = data?.gex?.kingStrike ?? null;
  // Net GEX total ($ por 1% de mov.) + régimen, para la franja de contexto.
  const ttNetGex = data?.gex?.totalNetGex ?? null;
  const ttNetPos = (data?.gex?.regime ?? "positive") === "positive";
  // Rango donde pega el tipo dominante (para la frase del resumen).
  const domStrikes = ttRollup.filter((r) => r.type === ttDom).map((r) => r.strike).sort((a, b) => a - b);
  const ttPile = domStrikes.length ? (domStrikes[0] === domStrikes[domStrikes.length - 1] ? `${cv(domStrikes[0])}` : `${cv(domStrikes[0])}–${cv(domStrikes[domStrikes.length - 1])}`) : null;

  // Franja de flujo del Live volume: composición call/put (por tipo, del MISMO flujo
  // agresivo clasificado que el 0DTE Live) + rumbo respecto al imán. En γ− el imán no
  // ancla → se atenúa (vvWeak) y la línea avisa que es solo referencia.
  const vvCpTot = callPrem + putPrem;
  const vvCallPct = vvCpTot > 0 ? Math.round((callPrem / vvCpTot) * 100) : null;
  const vvMagAbove = ttMagnet != null && data?.spot != null ? ttMagnet > data.spot : null;
  const vvToward = vvMagAbove == null ? null : ttDir === "bull" ? vvMagAbove : ttDir === "bear" ? !vvMagAbove : null;
  const vvMagPts = ttMagnet != null && data?.spot != null ? Math.abs(ttMagnet - data.spot) : null;
  const vvWeak = !ttNetPos; // γ−: el imán no ancla

  // GATE del "mejor trade": la reversión al imán (live) solo es señal de ENTRADA si
  // el momentum/flujo no corre en contra. Se alimenta del CVD (vol) + los bursts
  // agresivos + Net GEX + flip. Si el flujo empuja contra el pin → "esperar".
  const liveGate = live
    ? gateEntry(
        live,
        { cvd: vol?.cvd ?? flowCvd, velocity: vol?.velocity ?? null, burstBull: ttBull, burstBear: ttBear, netGex: data?.gex?.totalNetGex ?? null },
        data?.gex?.flipStrike ?? null,
        liveParams,
        lang,
      )
    : null;
  const liveReady = !!live && liveGate?.status === "ready";
  const liveWait = !!live && liveGate?.status === "wait";
  // Estado INACTIVO enriquecido (ni listo): régimen, imán, distancia y cuánto falta
  // para activar, para que la tarjeta nunca se vea en una sola línea.
  const idleMagnet = data?.gex?.kingStrike ?? null;
  const idlePos = (data?.gex?.regime ?? "positive") === "positive";
  const idleGap = idleMagnet != null && data?.spot != null ? Math.abs(data.spot - idleMagnet) : null;
  const idleWouldDir: "long" | "short" | null = idleMagnet != null && data?.spot != null ? (data.spot > idleMagnet ? "short" : "long") : null;
  const idleToActivate = idleGap != null ? Math.max(0, liveParams.minGapPts - idleGap) : null;
  const idleReason = liveWait ? liveGate!.reason : (data?.spot != null ? noSetupReason(data.spot, data?.gex?.regime ?? "positive", idleMagnet, liveParams, lang) : "");

  // --- ALTERNAS (experimentales, NO tocan las originales): usan el flujo en vivo ---
  const cvdTot = (flow?.buyAggr ?? 0) + (flow?.sellAggr ?? 0);
  const altCtx: AltFlowCtx | null = data?.spot != null ? {
    regime: data.gex.regime,
    cvd: vol?.cvd ?? flowCvd,
    cvdDom: flow?.buyAggr != null && cvdTot > 0 ? Math.abs((flow.buyAggr ?? 0) - (flow.sellAggr ?? 0)) / cvdTot : null,
    velocity: vol?.velocity ?? null,
    burstBull: ttBull, burstBear: ttBear,
    netGex: data.gex.totalNetGex,
    spot: data.spot,
    magnet: data.gex.kingStrike,
    sigma: data.forecast?.sigma ?? null,
  } : null;
  // Next 5 min alterno: mezcla el lean del GEX con el del flujo (peso auto).
  const altOut = data?.outlook && altCtx ? altOutlook(data.outlook.lean as Lean, data.outlook.confidence as Conf, altCtx, lang) : null;
  // Best trade alterno: γ+ = igual que el original; γ− = momentum si el flujo confirma.
  // Muros de gamma reales (no por volumen): objetivo del momentum en γ−.
  const walls = data?.gex?.nodes && data.spot != null ? gammaWalls(data.gex.nodes, data.spot) : { callWall: null, putWall: null };
  const altMomentumRaw = data?.isToday && altCtx && altCtx.regime === "negative"
    ? momentumEntry(altCtx, walls.callWall, walls.putWall, data.gex.flipStrike, undefined, lang)
    : null;
  altMomentumRawRef.current = altMomentumRaw; // el intervalo de 1 min la acumula (ver arriba)
  // Persistencia: solo se opera si la MISMA señal cruda se sostuvo
  // MOMENTUM_PERSISTENCE_REQUIRED lecturas seguidas — ver confirmMomentum.
  // `void momentumTick` fuerza a leer el ref recién actualizado por el intervalo.
  void momentumTick;
  const altMomentum = confirmMomentum(momentumHistoryRef.current, MOMENTUM_PERSISTENCE_REQUIRED);
  const momentumStreakN = momentumStreak(momentumHistoryRef.current);
  // GEX Trade alterno UNIFICADO (γ+ fade / γ− momentum) con niveles de convicción
  // + aviso de reversión. `live` = fade base (evaluateEntry, sin gate); altMomentum
  // = momentum γ− YA CONFIRMADO (persistente). El flujo decide el nivel
  // (strong/soft/waiting) y el aviso.
  const altState = altCtx ? altTradeState(altCtx, live, altMomentum) : null;
  const altTradeD = altState?.trade ?? null;
  const altRR = altTradeD ? riskReward(altTradeD) : 0;
  const altIsMomentum = !!altState?.isMomentum;

  // --- GEX Ticket: traduce el trade activo a un CONTRATO concreto (stop/target en $).
  // Fuente: γ+ → GEX Trade REGULAR listo; γ− → GEX Trade ALTERNO (momentum al muro).
  const ticketChain: TicketChainRow[] = data?.lines
    ? data.lines.flatMap((l) => {
        const out: TicketChainRow[] = [];
        const push = (r: typeof l.call, type: "call" | "put") => {
          if (r) out.push({ strike: l.strike, type, bid: r.bid ?? null, ask: r.ask ?? null, delta: r.greeks?.delta ?? null, gamma: r.greeks?.gamma ?? null, iv: r.greeks?.iv ?? null, volume: r.volume, oi: r.openInterest });
        };
        push(l.call, "call"); push(l.put, "put");
        return out;
      })
    : [];
  const ticketReg = liveReady && live ? live : null;
  const ticketMom = !ticketReg && altIsMomentum && altTradeD ? altTradeD : null; // momentum γ− confirmado
  const ticketTrade = ticketReg ?? ticketMom;
  const ticketIsMom = !!ticketMom;
  const ticketIdxRR = ticketTrade ? riskReward(ticketTrade) : 0;
  const ticket = ticketTrade && spot != null ? pickTicket(ticketTrade, spot, ticketChain) : null;
  if (ticket) {
    // Confirmación de flujo: sweeps agresivos COMPRANDO el mismo contrato hoy.
    ticket.flowSweeps = allTop.filter((t) => t.strike === ticket.strike && t.type === ticket.type && t.side === "buy" && t.sweep).length;
  }

  // Despin: si rompe el pin en la dirección del flujo, objetivo estimado (spot ± 1σ)
  // + muro de gamma de ese lado. Se muestra en GEX Pinning cuando el flujo va a algún lado.
  // σ del despin = expected move A CIERRE (`forecast.sigma`, la misma que usa el
  // momentum y la que basó la decisión de 1.0σ). Se colapsa a 0 al cierre → el
  // despin se oculta after-hours (correcto: sin tiempo no hay "si rompe").
  const despin = data?.closing && data.spot != null && data.gex
    ? despinEstimate(data.spot, data.forecast?.sigma ?? data.closing.sigma, altOut?.flowLean ?? "lateral", data.gex.regime, walls.callWall, walls.putWall)
    : null;
  // GEX Unpin (solo /ES y /NQ): el snapback post-cierre cuando la 0DTE expira.
  const isUnpinFut = data?.future === "/ES" || data?.future === "/NQ";
  const et = etNow();
  const unpin: UnpinRead = data?.spot != null && data.gex && isUnpinFut
    ? unpinRead({
        spot: data.spot,
        magnet: data.closing?.strike ?? data.gex.kingStrike ?? null,
        burstBull: ttBull, burstBear: ttBear,
        etMin: et.min,
        isWeekday: et.wd !== "Sat" && et.wd !== "Sun",
        sessionOpen,
        regime: data.gex.regime,
      })
    : { state: "idle", dir: null, defendedFrom: null, lo: 0, hi: 0, move: null, flowConfirms: false, minToClose: 0, hasPin: false };
  // Snapshot para el registro comparativo (lo lee el intervalo de 1 min).
  altSnapRef.current = data?.isToday && sessionOpen && data.outlook && altOut && data.spot != null
    ? { ticker, spot: data.spot, ol: data.outlook.lean as Lean, al: altOut.lean, w: altOut.w }
    : null;
  // Snapshot de TRADES: la señal activa del GEX Trade (original) y del alterno.
  // Se loguea cada minuto (con spot) aunque no haya señal, para resolver los abiertos.
  tradeSnapRef.current = data?.isToday && sessionOpen && data.spot != null
    ? {
        ticker,
        spot: data.spot,
        o: liveReady && live ? { d: live.direction, tgt: live.target, stop: live.stop } : null,
        a: altTradeD ? { d: altTradeD.direction, tgt: altTradeD.target, stop: altTradeD.stop, m: altIsMomentum } : null,
      }
    : null;
  // Snapshot CRUDO para la calibración del momentum γ− (ver momentumCalibration.ts):
  // el mismo AltFlowCtx que ya arma la UI, aplanado, más los muros/flip que usa
  // momentumEntry. Se loguea siempre que haya spot (no solo en γ−) para que la
  // ausencia de señal negativa también quede registrada.
  momentumRawRef.current = data?.isToday && sessionOpen && altCtx
    ? {
        ticker,
        spot: altCtx.spot,
        regime: altCtx.regime,
        cvd: altCtx.cvd,
        cvdDom: altCtx.cvdDom ?? null,
        velocity: altCtx.velocity,
        burstBull: altCtx.burstBull,
        burstBear: altCtx.burstBear,
        netGex: altCtx.netGex,
        magnet: altCtx.magnet,
        sigma: altCtx.sigma,
        flip: data?.gex?.flipStrike ?? null,
        callWall: walls.callWall,
        putWall: walls.putWall,
      }
    : null;
  // Etiqueta de dirección (junto al título de "best trade"). tr.long/tr.short ya
  // traen la flecha (▲/▼), no agregar otra.
  const dirLabel = (d: "long" | "short") => (d === "long" ? tr.long : tr.short);

  return (
    <div className="z-wrap">
      <style>{CSS}</style>

      <div className="z-disclaimer">⚠️ {tr.disclaimer}</div>

      <header className="z-head">
        <div>
          <h1>{tr.brand}</h1>
          <p>
            {selDate === etTodayStr() ? tr.subToday : tr.subFuture}{" "}
            {tr.subStrikes(data ? data.lines.length : "—")}
          </p>
        </div>
        <div className="z-controls">
          <button className="z-theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={tr.themeLabel} title={tr.themeLabel}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <select value={lang} onChange={(e) => changeLang(e.target.value as Lang)} aria-label={tr.langLabel} title={tr.langLabel}>
            <option value="en">🇬🇧 English</option>
            <option value="es">🇪🇸 Español</option>
          </select>
          <select value={ticker} onChange={(e) => setTicker(e.target.value)}>
            <option value="SPX">SPX</option>
            <option value="SPY">SPY</option>
            <option value="QQQ">QQQ</option>
            <option value="/ES">{tr.optES}</option>
            <option value="/NQ">{tr.optNQ}</option>
          </select>
          <button onClick={() => load(ticker, selDate)} disabled={loading}>
            {loading ? tr.loading : tr.refresh}
          </button>
        </div>
      </header>

      <div className="z-daybar">
        <span className="z-daybar-lbl">{tr.expiration}</span>
        {days.map((d, i) => (
          <button
            key={d}
            className={`z-daychip ${d === selDate ? "z-daychip-on" : ""}`}
            onClick={() => setSelDate(d)}
            disabled={loading && d === selDate}
          >
            {dayLabel(d, i, lang)}<em>{i}DTE</em>
          </button>
        ))}
      </div>

      {data && (
        <div className="z-meta">
          <span><b>{data.ticker}</b></span>
          <span>{tr.spot} <b>{dec(cvN(data.spot))}</b></span>
          <span>{tr.expires} <b>{data.expiration}</b></span>
          <span>{tr.contractsInChain(num(data.contractCount))}</span>
          <span className="z-time">
            {new Date(data.asOf).toLocaleTimeString("en-US", {
              timeZone: "America/New_York",
              hour12: false,
            })} ET
          </span>
          {data.realtimeStrikes > 0 ? (
            <span className="z-fresh" title={tr.realtimeTitle}>
              {tr.realtimeStrikes(data.realtimeStrikes, data.realtimeAgeSec != null ? ` (${data.realtimeAgeSec}s)` : "")}
            </span>
          ) : (
            data.delayed && <span className="z-flag">{tr.delayedChain}</span>
          )}
        </div>
      )}

      {data && isFut && data.future && data.analysisTicker !== data.future && (
        <div className="z-basis">
          <span className="z-basis-tag">{tr.convertedTo(data.future)}</span>
          <span>
            {tr.analysisOn} <b>{data.analysisTicker}</b> · {tr.liveBasis}{" "}
            <b>{basis >= 0 ? "+" : ""}{basis.toFixed(2)}</b> {tr.pts}
          </span>
          <span className="z-basis-note">
            {tr.basisNote(data.future, data.analysisTicker)}
            {data.analysisTicker === "NDX" && <> {tr.ndxWarn}</>}
          </span>
        </div>
      )}

      {error && <div className="z-error">{error}</div>}

      {data && !data.isToday && (
        <div className="z-future">{tr.futureNote(data.expiration)}</div>
      )}

      {data?.isToday && (
        <section className={`z-ticket ${ticket ? `z-ticket-${ticketTrade!.direction}` : "z-ticket-idle"}`}>
          <header>
            <h2>{tr.ticketName} <span className="z-live-sub">{tr.ticketSub}</span></h2>
            {ticket && <span className={`z-ticket-badge z-dir-${ticketTrade!.direction}`}>{tr.ticketBuy}</span>}
          </header>
          {!sessionOpen ? (
            <p className="z-live-msg">{tr.ticketClosed}</p>
          ) : ticket ? (
            <>
              <p className="z-ticket-thesis">{(ticketIsMom ? tr.ticketThesisMom : tr.ticketThesis)(dirLabel(ticketTrade!.direction), cv(ticketTrade!.target), dec(cvN(ticketTrade!.stop)))}</p>
              <div className="z-ticket-buy">
                <span className="z-ticket-act">{tr.ticketBuy}</span>
                <span className="z-ticket-ctr">{ticker} {cv(ticket.strike)} {ticket.type === "call" ? "C" : "P"}</span>
                <span className="z-ticket-at">@ {tr.ticketMid}</span>
                <span className="z-ticket-price">${ticket.mid.toFixed(2)}</span>
                <span className="z-ticket-quote">bid {ticket.bid.toFixed(2)} / ask {ticket.ask.toFixed(2)}</span>
              </div>
              <div className="z-ticket-st">
                <div className="z-ticket-box"><span className="z-ticket-k">{tr.ticketTarget}</span><span className="z-ticket-v z-ticket-tgt">${ticket.targetPx.toFixed(2)}</span><span className="z-ticket-idx">{tr.ticketIndexAt} {cv(ticketTrade!.target)} · <b className="z-ticket-up">+{(ticket.gainPct * 100).toFixed(0)}%</b></span></div>
                <div className="z-ticket-box"><span className="z-ticket-k">{tr.stop}</span><span className="z-ticket-v z-ticket-stp">${ticket.stopPx.toFixed(2)}</span><span className="z-ticket-idx">{tr.ticketIndexAt} {dec(cvN(ticketTrade!.stop))} · <b className="z-ticket-dn">−{(ticket.lossPct * 100).toFixed(0)}%</b></span></div>
                <div className="z-ticket-box"><span className="z-ticket-k">{tr.ticketRB}</span><span className="z-ticket-v">{ticket.rbOption.toFixed(1)}</span><span className="z-ticket-idx">{tr.ticketRBvsIndex(ticketIdxRR.toFixed(1))}</span></div>
              </div>
              <div className="z-ticket-meta">
                <span className="z-ticket-chip">Δ <b>{ticket.delta.toFixed(2)}</b></span>
                <span className="z-ticket-chip">Γ <b>{ticket.gamma.toFixed(3)}</b></span>
                {ticket.iv != null && <span className="z-ticket-chip">IV <b>{(ticket.iv * 100).toFixed(0)}%</b></span>}
                <span className="z-ticket-chip">vol <b>{ticket.volume.toLocaleString()}</b></span>
                <span className="z-ticket-chip">OI <b>{ticket.oi.toLocaleString()}</b></span>
                <span className="z-ticket-chip">spread <b>{(ticket.spreadPct * 100).toFixed(1)}%</b></span>
                <span className="z-ticket-chip">{tr.ticketCost} <b>${ticket.cost.toFixed(0)}</b></span>
                <span className="z-ticket-chip">{tr.ticketRisk} <b>${ticket.risk.toFixed(0)}</b>/ct</span>
                {ticket.flowSweeps > 0 && <span className="z-ticket-chip z-ticket-flow">{tr.ticketFlow(ticket.flowSweeps)}</span>}
              </div>
              <p className="z-ticket-foot">{tr.ticketTheta}</p>
            </>
          ) : ticketTrade ? (
            <p className="z-ticket-none">{tr.ticketNone}</p>
          ) : (
            <p className="z-ticket-none">{tr.ticketWait}</p>
          )}
        </section>
      )}

      {data?.isToday && (
        <section className={`z-live ${liveReady ? `z-live-${live!.direction}` : "z-live-idle"} ${justChanged ? "z-live-changed" : ""}`}>
          <header>
            <h2>{tr.bestTradeNow} <span className="z-live-sub">{tr.bestTradeSub}</span></h2>
            {sessionOpen && (liveReady && live ? (
              <span className={`z-live-hdir z-dir-${live.direction}`}>{dirLabel(live.direction)}</span>
            ) : idlePos && idleWouldDir ? (
              <span className={`z-live-hdir z-live-hdir-would z-dir-${idleWouldDir}`}>{tr.wouldBe(dirLabel(idleWouldDir))}</span>
            ) : null)}
            {justChanged && <span className="z-live-alert">{tr.setupChanged}</span>}
            <span className="z-live-clock">
              {sessionOpen ? tr.liveClock(etClock()) : tr.marketClosed}
            </span>
          </header>
          {!sessionOpen ? (
            <p className="z-live-msg">{isNativeFut ? tr.offSessionFut : tr.offSession}</p>
          ) : liveReady ? (
            <>
              <div className="z-live-row">
                <div><span className="z-sum-lbl">{tr.entryNow}</span><b>{dec(cvN(live!.entry))}</b></div>
                <div><span className="z-sum-lbl">{tr.targetMagnet}</span><b>{cv(live!.target)}</b></div>
                <div><span className="z-sum-lbl">{tr.stop}</span><b>{dec(cvN(live!.stop))}</b></div>
                <div><span className="z-sum-lbl">{tr.riskReward}</span><b>{liveGate!.rr.toFixed(1)} : 1</b></div>
              </div>
              <p className="z-live-reason">{live!.reason}</p>
            </>
          ) : (
            <>
              <div className="z-live-idlehead">
                <span className={`z-live-waitbadge ${idlePos ? "" : "z-live-nopin"}`}>{idlePos ? tr.waitLabel : tr.noPinLabel}</span>
                {idleReason && <span className="z-live-idlereason">{idleReason}</span>}
              </div>
              <div className="z-live-row z-live-idlerow">
                <div><span className="z-sum-lbl">{tr.regime}</span><b style={{ color: (data?.gex?.totalNetGex ?? 0) >= 0 ? "var(--green-dark)" : "var(--red-text)" }}>GEX {gexUsd(data?.gex?.totalNetGex ?? 0)}</b></div>
                {spot != null && <div><span className="z-sum-lbl">{tr.priceNow}</span><b>{dec(cvN(spot))}</b></div>}
                {idleMagnet != null && <div><span className="z-sum-lbl">{tr.targetMagnet}</span><b>{cv(idleMagnet)}</b></div>}
                {idleGap != null && <div><span className="z-sum-lbl">{tr.distance}</span><b>{idleGap.toFixed(0)} {tr.pts}</b></div>}
                {idlePos && idleToActivate != null && idleToActivate > 0 && (
                  <div><span className="z-sum-lbl">{tr.toActivate}</span><b style={{ color: "var(--amber-text)" }}>~{idleToActivate.toFixed(0)} {tr.pts}</b></div>
                )}
              </div>
            </>
          )}
          <p className="z-outlook-caveat">{tr.liveCaveat}</p>
        </section>
      )}

      {/* GEX Trade · ALTERNA UNIFICADO (no toca la original): γ+ fade / γ− momentum,
          con niveles de convicción (fuerte/suave) + aviso vivo de reversión. */}
      {data?.isToday && (() => {
        const tier = altState?.tier ?? "waiting";
        const t = altTradeD;
        const rev = !!altState?.reversal;
        return (
          <section className={`z-live z-live-alt ${t ? `z-live-${t.direction}` : "z-live-idle"} ${tier === "soft" ? "z-live-soft" : ""}`}>
            <header>
              <h2>{tr.bestTradeNow} <span className="z-alt-suffix">{tr.altSuffix}</span></h2>
              {sessionOpen && (t ? (
                <span className={`z-live-hdir z-dir-${t.direction}`}>{dirLabel(t.direction)}</span>
              ) : idlePos && idleWouldDir ? (
                <span className={`z-live-hdir z-live-hdir-would z-dir-${idleWouldDir}`}>{tr.wouldBe(dirLabel(idleWouldDir))}</span>
              ) : null)}
              {sessionOpen && t && rev && <span className="z-live-revwarn">{tr.altRevWarn}</span>}
              {altIsMomentum && <span className="z-live-momtag">{tr.momentumTag}</span>}
              <span className="z-live-clock">{sessionOpen ? tr.liveClock(etClock()) : tr.marketClosed}</span>
            </header>
            {!sessionOpen ? (
              <p className="z-live-msg">{isNativeFut ? tr.offSessionFut : tr.offSession}</p>
            ) : t ? (
              <>
                <div className="z-live-tierrow">
                  <span className={`z-live-tier z-live-tier-${tier}`}>{tier === "strong" ? tr.altTierStrong : tr.altTierSoft}</span>
                  <span className="z-live-tiernote">{rev ? tr.altRevNote : tier === "strong" ? tr.altTierStrongNote : tr.altTierSoftNote}</span>
                </div>
                <div className="z-live-row">
                  <div><span className="z-sum-lbl">{tr.entryNow}</span><b>{dec(cvN(t.entry))}</b></div>
                  {spot != null && <div><span className="z-sum-lbl">{tr.priceNow}</span><b>{dec(cvN(spot))}</b></div>}
                  <div><span className="z-sum-lbl">{altIsMomentum ? tr.targetWall : tr.targetMagnet}</span><b>{cv(t.target)}</b></div>
                  <div><span className="z-sum-lbl">{tr.stop}</span><b>{dec(cvN(t.stop))}</b></div>
                  <div><span className="z-sum-lbl">{tr.riskReward}</span><b>{altRR.toFixed(1)} : 1</b></div>
                </div>
                <p className="z-live-reason">{t.reason}</p>
              </>
            ) : (
              <>
                <div className="z-live-idlehead">
                  <span className={`z-live-waitbadge ${idlePos ? "" : "z-live-nopin"}`}>{idlePos ? tr.waitLabel : tr.noPinLabel}</span>
                  {idleReason && <span className="z-live-idlereason">{idleReason}</span>}
                </div>
                {momentumStreakN > 0 && momentumStreakN < MOMENTUM_PERSISTENCE_REQUIRED && (
                  <p className="z-live-idlereason">{tr.momentumBuilding(momentumStreakN, MOMENTUM_PERSISTENCE_REQUIRED)}</p>
                )}
                <div className="z-live-row z-live-idlerow">
                  <div><span className="z-sum-lbl">{tr.regime}</span><b style={{ color: (data?.gex?.totalNetGex ?? 0) >= 0 ? "var(--green-dark)" : "var(--red-text)" }}>GEX {gexUsd(data?.gex?.totalNetGex ?? 0)}</b></div>
                  {spot != null && <div><span className="z-sum-lbl">{tr.priceNow}</span><b>{dec(cvN(spot))}</b></div>}
                  {idleMagnet != null && <div><span className="z-sum-lbl">{tr.targetMagnet}</span><b>{cv(idleMagnet)}</b></div>}
                  {idleGap != null && <div><span className="z-sum-lbl">{tr.distance}</span><b>{idleGap.toFixed(0)} {tr.pts}</b></div>}
                </div>
              </>
            )}
            <p className="z-outlook-caveat">{tr.liveCaveat}</p>
          </section>
        );
      })()}

      {data?.outlook && (
        <section className={`z-outlook z-lean-${data.outlook.lean}`}>
          <div className="z-outlook-top">
            <span className="z-outlook-tag">{tr.gexBiasName} <span className="z-live-sub">{tr.nextMin(data.outlook.horizonMinutes)}</span></span>
            <span className={`z-lean-chip z-lean-chip-${data.outlook.lean}`}>
              {data.outlook.lean === "alcista" ? tr.biasBull
                : data.outlook.lean === "bajista" ? tr.biasBear
                : tr.biasSide}
            </span>
            <span className="z-conf">{tr.confidence(CONFIDENCE[lang][data.outlook.confidence] ?? data.outlook.confidence)}</span>
          </div>
          <p className="z-outlook-head">{data.outlook.headline}</p>
          <div className="z-outlook-range">
            <span>{dec(cvN(data.outlook.rangeLow))}</span>
            <div className="z-range-bar">
              <i className="z-range-fill" />
              <b className="z-range-now" style={{ left: `${rangePos(data.outlook)}%` }}>
                {dec(cvN(data.outlook.spot))}
              </b>
              {data.outlook.magnet != null && inRange(data.outlook) && (
                <span className="z-range-magnet" style={{ left: `${magnetPos(data.outlook)}%` }} title={tr.magnetLabel}>
                  {cv(data.outlook.magnet)}
                </span>
              )}
            </div>
            <span>{dec(cvN(data.outlook.rangeHigh))}</span>
          </div>
          <p className="z-outlook-detail">{data.outlook.detail}</p>
          {(data.outlook.charmNote || data.outlook.vannaNote) && (
            <div className="z-flow">
              {data.outlook.charmNote && (
                <p className="z-flow-line">
                  <span className="z-flow-tag">CHARM</span>{" "}
                  {data.outlook.charmNote.replace(/^Charm \d+%: /, "")}
                  {data.outlook.charmIntensity != null && (
                    <span className="z-flow-bar">
                      <i style={{ width: `${data.outlook.charmIntensity * 100}%` }} />
                    </span>
                  )}
                </p>
              )}
              {data.outlook.vannaNote && (
                <p className="z-flow-line">
                  <span className="z-flow-tag">VANNA</span>{" "}
                  {data.outlook.vannaNote.replace(/^Vanna: /, "")}
                </p>
              )}
            </div>
          )}
          <p className="z-outlook-caveat">{tr.outlookCaveat}</p>
        </section>
      )}

      {/* Next 5 min · ALTERNA (flujo ponderado; no toca la original) */}
      {data?.outlook && altOut && (
        <section className={`z-outlook z-outlook-alt z-lean-${altOut.lean}`}>
          <div className="z-outlook-top">
            <span className="z-outlook-tag">{tr.gexBiasName} <span className="z-live-sub">{tr.nextMin(data.outlook.horizonMinutes)}</span> <span className="z-alt-suffix">{tr.altSuffix}</span></span>
            <span className={`z-lean-chip z-lean-chip-${altOut.lean}`}>
              {altOut.lean === "alcista" ? tr.biasBull : altOut.lean === "bajista" ? tr.biasBear : tr.biasSide}
            </span>
            <span className="z-conf">{tr.confidence(CONFIDENCE[lang][altOut.confidence] ?? altOut.confidence)}</span>
          </div>
          <p className="z-outlook-head">{data.outlook.headline}</p>
          <div className="z-outlook-range">
            <span>{dec(cvN(data.outlook.rangeLow))}</span>
            <div className="z-range-bar">
              <i className="z-range-fill" />
              <b className="z-range-now" style={{ left: `${rangePos(data.outlook)}%` }}>{dec(cvN(data.outlook.spot))}</b>
              {data.outlook.magnet != null && inRange(data.outlook) && (
                <span className="z-range-magnet" style={{ left: `${magnetPos(data.outlook)}%` }} title={tr.magnetLabel}>{cv(data.outlook.magnet)}</span>
              )}
            </div>
            <span>{dec(cvN(data.outlook.rangeHigh))}</span>
          </div>
          <p className="z-outlook-detail">{data.outlook.detail}</p>
          <div className="z-flow">
            <p className="z-flow-line"><span className="z-flow-tag z-flow-tag-flow">{tr.flowTag}</span>{" "}{altOut.flowNote}</p>
            {data.outlook.charmNote && (
              <p className="z-flow-line"><span className="z-flow-tag">CHARM</span>{" "}{data.outlook.charmNote.replace(/^Charm \d+%: /, "")}</p>
            )}
            {data.outlook.vannaNote && (
              <p className="z-flow-line"><span className="z-flow-tag">VANNA</span>{" "}{data.outlook.vannaNote.replace(/^Vanna: /, "")}</p>
            )}
          </div>
          <p className="z-outlook-caveat">{tr.outlookCaveat}</p>
        </section>
      )}

      {/* Registro comparativo: original vs alterna del next 5 min (se llena en vivo) */}
      {data?.isToday && altEval && (
        <section className="z-altcmp">
          <h3>{tr.altCmpTitle}</h3>
          {altEval.n > 0 ? (
            <>
              <p className="z-altcmp-line">{tr.altCmpLine(altEval.origRate?.toFixed(0) ?? "—", altEval.altRate?.toFixed(0) ?? "—", altEval.n)}</p>
              {altEval.bothActive > 0 && <p className="z-altcmp-sub">{tr.altCmpDiff(altEval.bothActive, altEval.altBetterWhenActive)}</p>}
            </>
          ) : (
            <p className="z-altcmp-sub">{tr.altCmpWait}</p>
          )}
        </section>
      )}

      {/* Registro comparativo de TRADES: GEX Trade original vs alterno (se llena en vivo) */}
      {data?.isToday && tradeEval && (
        <section className="z-altcmp">
          <h3>{tr.tradeCmpTitle}</h3>
          {tradeEval.altResolved > 0 ? (
            <>
              <p className="z-altcmp-line">{tr.tradeCmpLine(tradeEval.origRate?.toFixed(0) ?? "—", tradeEval.altRate?.toFixed(0) ?? "—", tradeEval.altResolved)}</p>
              {tradeEval.differed > 0 && <p className="z-altcmp-sub">{tr.tradeCmpDiff(tradeEval.differed, tradeEval.differedWon)}</p>}
            </>
          ) : (
            <p className="z-altcmp-sub">{tr.tradeCmpWait}</p>
          )}
        </section>
      )}

      {data?.isToday && flow && !flow.error && flowCvd != null && (
        <section className="z-vv">
          <div className="z-vv-top">
            <span className="z-vv-tag">{tr.volTitleName} <span className="z-live-sub">{tr.volTitleSub}</span></span>
            <span className={`z-vv-chip ${flowCvd >= 0 ? "z-vv-buy" : "z-vv-sell"}`}>
              {flowCvd >= 0 ? tr.volBuyLean : tr.volSellLean}
            </span>
            <span className="z-vv-clock">{marketOpen ? tr.contracts(num(flow.contracts)) : tr.marketClosed}</span>
          </div>
          <div className="z-vv-grid">
            <div>
              <span className="z-sum-lbl">{tr.volVelocity}</span>
              {vol && volView ? (
                <>
                  <div className="z-vv-big" style={{ color: vol.velocity >= 1.5 ? "var(--amber-text)" : "var(--text)" }}>{vol.velocity.toFixed(1)}×</div>
                  <div className="z-vv-sub">{tr.volVsAvg}</div>
                  <div className="z-vv-meter"><i style={{ width: `${Math.min(vol.velocity / 3, 1) * 100}%`, background: vol.velocity >= 1.5 ? "var(--amber)" : "var(--accent)" }} /></div>
                  <div className="z-vv-ticks"><span>0×</span><span>1×</span><span>2×</span><span>3×</span></div>
                  <div className="z-vv-live">{tr.volLive(num(flow.totalVol ?? 0), num(vol.cur))}</div>
                </>
              ) : (
                <>
                  <div className="z-vv-big" style={{ color: "var(--faint)" }}>—</div>
                  <div className="z-vv-sub">{marketOpen ? tr.volCollecting : (isNativeFut ? tr.volClosedNoteFut : tr.volClosedNote)}</div>
                  {flow.totalVol != null && <div className="z-vv-live">{tr.volDayOnly(num(flow.totalVol))}</div>}
                </>
              )}
            </div>
            <div>
              <span className="z-sum-lbl">{tr.volCvd}</span>
              <div className="z-vv-big" style={{ color: flowCvd >= 0 ? "var(--green-dark)" : "var(--red-text)" }}>{flowCvd >= 0 ? "+" : ""}{num(flowCvd)}</div>
              <div className="z-vv-sub">{flowCvd >= 0 ? tr.volBuyDom : tr.volSellDom}</div>
              <div className="z-vv-div">
                <span className="z-vv-zero" />
                <span className="z-vv-fill" style={flowCvd >= 0 ? { left: "50%", width: `${flowDivW}%`, background: "var(--green)" } : { right: "50%", width: `${flowDivW}%`, background: "var(--red)" }} />
              </div>
              <div className="z-vv-ends"><span>{tr.volSell}</span><span>0</span><span>{tr.volBuy}</span></div>
              {vol && volView && (
                <svg className="z-vv-spark" viewBox="0 0 240 52" width="100%" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="0" y1="26" x2="240" y2="26" stroke="var(--faint)" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
                  <polyline fill="none" stroke={flowCvd >= 0 ? "#12b76a" : "#f04438"} strokeWidth="2" points={volView.pts} />
                </svg>
              )}
            </div>
          </div>
          {vvCpTot > 0 && (
            <div className={`z-vv-flow z-vv-flow-${ttDir === "bull" ? "bull" : ttDir === "bear" ? "bear" : "mixed"} ${vvWeak ? "z-vv-flow-weak" : ""}`}>
              <div className="z-vv-flow-top">
                <span className="z-vv-flow-word">
                  {ttDir === "bull" ? "▲ " : ttDir === "bear" ? "▼ " : "= "}
                  {ttDom === "call" ? tr.volFlowCalls : tr.volFlowPuts}
                </span>
                {vvCallPct != null && <span className="z-vv-flow-chip">{tr.volTypeSplit(vvCallPct, 100 - vvCallPct)}</span>}
              </div>
              {vvCallPct != null && (
                <div className="z-vv-flow-bar">
                  <i style={{ width: `${vvCallPct}%`, background: "var(--green)" }} />
                  <i style={{ width: `${100 - vvCallPct}%`, background: "var(--red)" }} />
                </div>
              )}
              <p className="z-vv-flow-line">
                {vvWeak
                  ? tr.volMagNeg(ttMagnet != null ? String(cv(ttMagnet)) : "—")
                  : vvToward == null
                    ? tr.volMagMixed
                    : vvToward
                      ? tr.volMagToward(ttMagnet != null ? String(cv(ttMagnet)) : "—", vvMagPts != null ? vvMagPts.toFixed(0) : "—")
                      : tr.volMagAway(ttMagnet != null ? String(cv(ttMagnet)) : "—")}
              </p>
            </div>
          )}
          {(flow.topSell || flow.topBuy) && (
            <div className="z-vv-strikes">
              {flow.topSell && <span>🔴 {tr.volMostSold}: <b>{cv(flow.topSell.strike)} {flow.topSell.type}</b> ({num(flow.topSell.net)})</span>}
              {flow.topBuy && <span>🟢 {tr.volMostBought}: <b>{cv(flow.topBuy.strike)} {flow.topBuy.type}</b> (+{num(flow.topBuy.net)})</span>}
            </div>
          )}
          {marketOpen && vol ? (
            <p className="z-vv-verdict">{volVerdict}</p>
          ) : !marketOpen ? (
            <p className="z-vv-verdict">{isNativeFut ? tr.volClosedNoteFut : tr.volClosedNote}</p>
          ) : null}
        </section>
      )}

      {data?.isToday && flow && !flow.error && (
        <section className="z-tt">
          <div className="z-tt-head">
            <span className="z-tt-tag">{tr.ttTagName} <span className="z-live-sub">{tr.ttTagSub}</span></span>
            <span className="z-tt-inst">{data.ticker}{ttMagnet != null ? ` · ${tr.magnetShort} ${cv(ttMagnet)}` : ""}</span>
            <span className="z-tt-takers"><b>⚡</b> {tr.ttTakersOnly}</span>
            {!ttSlActive && allTop.length > 0 && <span className="z-tt-warn" title={tr.ttSlPending}>⚠ {tr.ttSlPendingShort}</span>}
          </div>

          {ttFeed.length === 0 ? (
            <div className="z-tt-empty">{tr.ttEmpty}</div>
          ) : (
            <>
              {ttNetGex != null && (
                <div className="z-tt-net">
                  <div className={`z-tt-net-val ${ttNetPos ? "pos" : "neg"}`}>
                    <span className="z-tt-net-lbl">{tr.netGexLabel}</span>
                    <span className="z-tt-net-num"><b>{gexUsd(ttNetGex)}</b> <span>{ttNetPos ? tr.ttNetShortPos : tr.ttNetShortNeg}</span></span>
                  </div>
                  <div className="z-tt-net-read">{ttNetPos ? tr.ttNetReadPos(ttMagnet != null ? String(cv(ttMagnet)) : null) : tr.ttNetReadNeg}</div>
                </div>
              )}

              <div className={`z-tt-summary z-tt-sum-${ttDir}`}>
                <div className="z-tt-sum-top">
                  <span className="z-tt-sum-word">{ttDir === "bull" ? `▲ ${tr.ttBiasBull}` : ttDir === "bear" ? `▼ ${tr.ttBiasBear}` : ttDir === "mixed" ? `= ${tr.ttBiasMixed}` : tr.ttBiasNone}</span>
                  {ttBiasPct != null && <span className="z-tt-sum-chip">{ttDom === "call" ? tr.ttCallsDom : tr.ttPutsDom} · {ttBiasPct}%</span>}
                </div>
                <p className="z-tt-sum-line">{tr.ttSummary(usd(ttBull), usd(ttBear), ttPile, ttMagnet != null ? String(cv(ttMagnet)) : null, ttSweeps)}</p>
              </div>

              {ttRollup.length > 0 && (
                <>
                  <div className="z-tt-sech">{tr.ttRollHead}</div>
                  <div className="z-tt-roll">
                    {ttRollup.map((r) => {
                      const isC = r.type === "call";
                      const score = Math.round((r.imp / ttRollMax) * 100);
                      return (
                        <div key={`${r.strike}:${r.type}`} className="z-tt-rollrow">
                          <span className="z-tt-roll-k" style={{ color: isC ? "var(--green)" : "var(--red)" }}>{cv(r.strike)} {isC ? "C" : "P"}</span>
                          <span className="z-tt-roll-bar"><i style={{ width: `${Math.max(6, (r.imp / ttRollMax) * 100)}%`, background: isC ? "var(--green)" : "var(--red)" }} /></span>
                          <span className="z-tt-roll-v"><b>{score}</b> <span>{tr.ttImpact}</span></span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <div className="z-tt-sech z-tt-sech-top">{tr.ttFeedHead}{ttSweeps > 0 ? <span className="z-tt-newcnt"> · {ttSweeps} sweep{ttSweeps === 1 ? "" : "s"}</span> : ttNewCount > 0 ? <span className="z-tt-newcnt"> · {ttNewCount} {tr.ttNew}</span> : null}</div>
              <div className="z-tt-table">
                {ttFeed.map((t, i) => {
                  const isNew = newTopTs.has(t.ts);
                  const isCall = t.type === "call";
                  const buy = t.side === "buy";
                  // Color de LÍNEA por sesgo: bull (call@ask / put@bid) verde, bear rojo.
                  const bull = (isCall && buy) || (!isCall && !buy);
                  const hhmmss = new Date(t.ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
                  return (
                    <div key={`${t.ts}-${i}`} className={`z-tt-row ${bull ? "z-tt-bull" : "z-tt-bear"} ${t.sweep ? "z-tt-sweep" : ""} ${isNew ? "z-tt-new" : ""} ${t.open ? "" : "z-tt-closed"}`} title={t.open ? tr.ttOpen : tr.ttClose}>
                      <span className="z-tt-time">{hhmmss}</span>
                      <span><b>{cv(t.strike)} {isCall ? "C" : "P"}</b></span>
                      <span>{`${buy ? "▲" : "▼"} ${buy ? tr.ttBuyAsk : tr.ttSellBid}`}</span>
                      <span className="z-tt-r">{Math.abs(t.delta).toFixed(2)}</span>
                      <span className="z-tt-r z-tt-prem">{usd(t.premium)}</span>
                      <span className="z-tt-r z-tt-score">{t.sweep && <b className="z-tt-swi" title="sweep">⚡</b>}{scoreOf(t)}</span>
                    </div>
                  );
                })}
              </div>

              {(discMid > 0 || discClose > 0) && (
                <div className="z-tt-disc"><span className="z-tt-disc-ic">⊘</span> {tr.ttDiscarded(discMid, discClose)}</div>
              )}

              <div className="z-tt-foot">{tr.ttFootNote2}</div>
            </>
          )}
        </section>
      )}

      {data && (
        <div className="z-summary">
          <div className="z-sum-card z-sum-call">
            <span className="z-sum-lbl">{tr.highestCall}</span>
            <b>{data.summary.maxCallStrike == null ? "—" : cv(data.summary.maxCallStrike)}</b>
            <span className="z-sum-sub">{tr.contracts(num(data.summary.maxCallVolume))}</span>
          </div>
          <div className="z-sum-card z-sum-put">
            <span className="z-sum-lbl">{tr.highestPut}</span>
            <b>{data.summary.maxPutStrike == null ? "—" : cv(data.summary.maxPutStrike)}</b>
            <span className="z-sum-sub">{tr.contracts(num(data.summary.maxPutVolume))}</span>
          </div>
          <div className="z-sum-card">
            <span className="z-sum-lbl">{tr.putCallRatio}</span>
            <b>{data.summary.putCallRatio?.toFixed(2) ?? "—"}</b>
            <span className="z-sum-sub">
              {tr.putsCalls(num(data.summary.putVolume), num(data.summary.callVolume))}
            </span>
          </div>
        </div>
      )}

      {data && data.gex.n > 0 && (
        <section className={`z-gex z-gex-${data.gex.regime}`}>
          <header>
            <h2>{tr.todayGamma}</h2>
            <span>{tr.gexSub(data.gex.n, (data.gex.realGammaShare * 100).toFixed(0))}</span>
          </header>
          <div className="z-gex-grid">
            <div>
              <span className="z-sum-lbl">{tr.netGexLabel}</span>
              <b style={{ color: data.gex.totalNetGex >= 0 ? "var(--green-dark)" : "var(--red-text)" }}>{gexUsd(data.gex.totalNetGex)}</b>
              <span className="z-sum-sub">{data.gex.regime === "positive" ? tr.netGexPos : tr.netGexNeg}</span>
            </div>
            <div>
              <span className="z-sum-lbl">{tr.regime}</span>
              <b>{data.gex.regime === "positive" ? tr.gPositive : tr.gNegative}</b>
              <span className="z-sum-sub">
                {data.gex.regime === "positive" ? tr.regimePosSub : tr.regimeNegSub}
              </span>
            </div>
            <div>
              <span className="z-sum-lbl">{tr.magnetLabel}</span>
              <b>{data.gex.kingStrike == null ? "—" : cv(data.gex.kingStrike)}</b>
              <span className="z-sum-sub">{tr.magnetSub}</span>
            </div>
            <div>
              <span className="z-sum-lbl">{tr.flipZone}</span>
              <b>{data.gex.flipStrike == null ? "—" : cv(data.gex.flipStrike).toFixed(2)}</b>
              <span className="z-sum-sub">
                {data.gex.flipStrike == null ? tr.flipNullSub : tr.flipSub}
              </span>
            </div>
          </div>
        </section>
      )}

      {data?.closing && isSpx && (
        <section className={`z-close z-close-${data.closing.phase === "live" ? data.closing.confidence : data.closing.phase}`}>
          <div className="z-close-top">
            <span className="z-close-tag">{tr.closeTag}</span>
            {data.closing.phase === "live" && (
              <>
                <span className={`z-close-conf z-close-conf-${data.closing.confidence}`}>{tr.confidence(CONFIDENCE[lang][data.closing.confidence] ?? data.closing.confidence)}</span>
                <span className="z-close-min z-close-min-right">{tr.minLeft(data.closing.minutesLeft.toFixed(0))}</span>
              </>
            )}
            {data.closing.phase === "pending" && (
              <span className="z-close-min">{tr.calcAt3}</span>
            )}
            {data.closing.phase === "final" && (
              <span className="z-close-min">{tr.fixedSession(data.closing.fromDate ?? "")}</span>
            )}
          </div>
          <div className="z-close-main">
            <div>
              <span className="z-sum-lbl">{data.ticker} {tr.mostLikelyClose}</span>
              <b className="z-close-strike">
                {data.closing.strike == null ? "—" : cv(data.closing.strike)}
                {data.closing.phase === "pending" && data.closing.strike != null && <span className="z-close-prov"> {tr.provisional}</span>}
              </b>
            </div>
            {data?.gex?.totalNetGex != null && (
              <div>
                <span className="z-sum-lbl">{tr.pinStrength}</span>
                <b className="z-close-netgex" style={{ color: data.gex.totalNetGex >= 0 ? "var(--green-dark)" : "var(--red-text)" }}>{gexUsd(data.gex.totalNetGex)}</b>
              </div>
            )}
            {data.closing.maxPain != null && (
              <div>
                <span className="z-sum-lbl">{tr.maxPain}</span>
                <b className="z-close-maxpain" style={{ color: data.closing.regime === "positive" && data.closing.magnet != null && Math.abs(data.closing.maxPain - data.closing.magnet) <= 5 ? "var(--green-dark)" : "var(--fg)" }}>{cv(data.closing.maxPain)}</b>
              </div>
            )}
          </div>

          {data.closing.phase === "pending" && (() => {
            const to3 = Math.max(0, data.closing.minutesLeft - 60);
            const h = Math.floor(to3 / 60), m = Math.round(to3 % 60);
            const label = h > 0 ? `${h}h ${m}m` : `${m}m`;
            const progress = Math.max(0, Math.min(100, ((390 - data.closing.minutesLeft) / 390) * 100));
            return (
              <div className="z-close-count">
                <div className="z-close-count-top">
                  <span>{tr.closeLockIn(label)}</span>
                  <span className="z-close-count-3">3:00pm</span>
                </div>
                <div className="z-close-bar"><i style={{ width: `${progress}%` }} /><span className="z-close-bar-mark" style={{ left: "84.6%" }} /></div>
                <div className="z-close-count-ends"><span>{tr.closeOpenLbl}</span><span>{tr.closeCloseLbl}</span></div>
              </div>
            );
          })()}

          {data.closing.phase === "live" && (() => {
            const lo = cv(data.closing.rangeLow), hi = cv(data.closing.rangeHigh), k = cv(data.closing.strike ?? 0);
            const pos = hi > lo ? Math.max(0, Math.min(100, ((k - lo) / (hi - lo)) * 100)) : 50;
            const col = data.closing.confidence === "alta" ? "var(--green-dark)" : data.closing.confidence === "media" ? "var(--amber-text)" : "var(--muted)";
            return (
              <div className="z-close-count">
                <div className="z-close-count-top"><span>{tr.likelyRange}</span><span><b>{tr.ptsMargin(data.closing.sigma.toFixed(1))}</b></span></div>
                <div className="z-close-rbar"><span className="z-close-rmark" style={{ left: `${pos}%`, background: col }} /></div>
                <div className="z-close-rends"><span>{lo}</span><span className="z-close-rmid" style={{ color: col }}>{k}</span><span>{hi}</span></div>
              </div>
            );
          })()}
          {despin && (
            <div className={`z-despin z-despin-c-${despin.dir} ${despin.weak ? "z-despin-weak" : ""}`}>
              <div className="z-despin-head">
                <span className="z-despin-t">{tr.despinTitle}</span>
                <span className={`z-despin-dir z-despin-${despin.dir}`}>{despin.dir === "down" ? "▼ " : "▲ "}{despin.dir === "down" ? tr.despinDown : tr.despinUp}</span>
              </div>
              <div className="z-despin-row">
                <div className="z-despin-tgt"><span className="z-sum-lbl">{tr.despinTarget}</span><b>{cv(despin.target)}{despin.anchored && <span className="z-despin-anchor"> {tr.despinAnchor}</span>}</b></div>
                <span className="z-despin-move">{tr.despinMove(despin.pts.toFixed(0), despin.dir === "up", despin.anchored)}</span>
                {despin.wall != null && !despin.anchored && <span className="z-despin-wall">{tr.despinWall(cv(despin.wall))}</span>}
              </div>
              <p className="z-despin-note">{despin.weak ? `${tr.despinWeak} ` : ""}{tr.despinNote}</p>
            </div>
          )}
          <p className="z-close-note">{data.closing.note}</p>
          {evalu?.closingCount != null && evalu.closingCount > 0 && (
            <p className="z-close-acc">
              {tr.closeHistory(evalu.closingCount, evalu.closingMeanAbsErrorPts?.toFixed(1) ?? "—")}
              {evalu.closingHitRate != null && tr.closeHitRate(evalu.closingHitRate.toFixed(0))}
            </p>
          )}
          <p className="z-outlook-caveat">{tr.closeCaveat}</p>
        </section>
      )}

      {data?.closing?.phase === "live" && data.dealerFlow && (() => {
        const c = data.closing;
        const gx = data.gex;
        const df = data.dealerFlow;
        const posReg = gx.regime === "positive";
        const chFlow = df.charmFlow ?? 0;
        const chDir: "up" | "down" | null = Math.abs(chFlow) < 1e-9 ? null : chFlow > 0 ? "up" : "down";
        const chPct = ((df.charmIntensity ?? 0) * 100).toFixed(0);
        // MOC manual (opcional): número + lado. Se convierte en 4ª señal direccional.
        const mocNum = parseFloat(mocVal.replace(/[^0-9.]/g, ""));
        const mocOk = Number.isFinite(mocNum) && mocNum > 0 && mocSide != null;
        const mocDir: "up" | "down" | null = !mocOk ? null : mocSide === "buy" ? "up" : "down";
        const mocStrong = mocOk && mocNum >= 1500;
        const mocFmt = mocOk ? (mocNum >= 1000 ? `$${(mocNum / 1000).toFixed(2)}B` : `$${mocNum.toFixed(0)}M`) : "";
        const mocBlock = (
          <div className="z-moc">
            <div className="z-moc-head"><span className="z-sum-lbl">{tr.mocLabel}</span><span className="z-moc-hint">{tr.mocHint}</span></div>
            <div className="z-moc-row">
              <input className="z-moc-in" value={mocVal} placeholder={tr.mocPlaceholder} inputMode="decimal" onChange={(e) => saveMoc(e.target.value, mocSide)} />
              <span className="z-moc-unit">MLN</span>
              <span className="z-moc-toggle">
                <button type="button" className={mocSide === "buy" ? "z-moc-buy" : ""} onClick={() => saveMoc(mocVal, "buy")}>{tr.mocBuy}</button>
                <button type="button" className={mocSide === "sell" ? "z-moc-sell" : ""} onClick={() => saveMoc(mocVal, "sell")}>{tr.mocSell}</button>
              </span>
              {mocOk && <span className="z-moc-tier">{mocStrong ? tr.mocTierStrong : tr.mocTierMod}</span>}
              {mocVal !== "" && <button type="button" className="z-moc-clear" onClick={() => saveMoc("", null)} aria-label="clear">×</button>}
            </div>
          </div>
        );
        return (
          <section className={`z-pinalt ${posReg ? "z-pinalt-pos" : "z-pinalt-neg"}`}>
            <div className="z-pinalt-top">
              <span className="z-pinalt-tag">{tr.pinAltName}</span>
              <span className="z-pinalt-alt">{tr.pinAltAlt}</span>
              {!posReg && <span className="z-pinalt-gtag">γ−</span>}
              <span className="z-close-min z-close-min-right">{tr.minLeft(c.minutesLeft.toFixed(0))}</span>
            </div>

            {mocBlock}

            {posReg ? (
              <>
                <div className="z-close-main">
                  <div><span className="z-sum-lbl">{tr.mostLikelyClose}</span><b className="z-close-strike">{c.strike == null ? "—" : cv(c.strike)}</b></div>
                  {c.maxPain != null && <div><span className="z-sum-lbl">{tr.maxPain}</span><b className="z-close-maxpain">{cv(c.maxPain)}</b></div>}
                </div>
                <div className={`z-pinalt-charm z-pinalt-charm-${chDir ?? "flat"}`}>
                  <div className="z-pinalt-charm-top">
                    <span className="z-pinalt-charm-w">{tr.charmClose} · {chDir === "up" ? tr.charmBuy : chDir === "down" ? tr.charmSell : tr.charmFlat}</span>
                    <span className="z-pinalt-chip">{tr.charmInt(chPct)}</span>
                  </div>
                  <div className="z-pinalt-bar"><i style={{ width: `${chPct}%`, background: chDir === "down" ? "var(--red)" : chDir === "up" ? "var(--green)" : "var(--faint)" }} /></div>
                  <p className="z-pinalt-note">{tr.charmNotePos(chDir === "down")}{mocOk ? ` ${tr.mocAbsorbed(mocFmt)}` : ""}</p>
                </div>
              </>
            ) : despin ? (() => {
              const flipDir: "up" | "down" | null = gx.flipStrike != null && spot != null ? (spot < gx.flipStrike ? "down" : "up") : null;
              const sigOn = [true, flipDir != null, chDir != null, mocDir != null];
              const sigAlign = [true, flipDir === despin.dir, chDir === despin.dir, mocDir === despin.dir];
              const present = sigOn.filter(Boolean).length;
              const aligned = sigOn.map((on, i) => on && sigAlign[i]).filter(Boolean).length;
              const down = despin.dir === "down";
              const mocConflict = mocOk && mocDir !== despin.dir;
              return (
                <>
                  <div className="z-close-main">
                    <div><span className="z-sum-lbl">{tr.pinAltDirClose}</span><b className="z-pinalt-dirclose" style={{ color: down ? "var(--red-text)" : "var(--green-dark)" }}>{down ? "▼ " : "▲ "}{cv(despin.target)}</b></div>
                    <div><span className="z-sum-lbl">{tr.spot}</span><b className="z-pinalt-base">{dec(cvN(spot ?? 0))}</b></div>
                    {c.maxPain != null && <div><span className="z-sum-lbl">{tr.maxPain}</span><b className="z-close-maxpain">{cv(c.maxPain)}</b></div>}
                  </div>
                  <div className={`z-pinalt-dir z-pinalt-dir-${despin.dir}`}>
                    <div className="z-pinalt-charm-top">
                      <span className="z-pinalt-dir-w" style={{ color: down ? "var(--red-text)" : "var(--green-dark)" }}>{down ? `▼ ${tr.despinDown}` : `▲ ${tr.despinUp}`}</span>
                      <span className="z-pinalt-chip">{tr.pinAltConv(aligned, present)}</span>
                    </div>
                    <div className="z-pinalt-sigs">
                      <span className="z-sig-on">{tr.sigFlow}</span>
                      <span className={flipDir === despin.dir ? "z-sig-on" : ""}>{tr.sigFlip(gx.flipStrike != null ? cv(gx.flipStrike) : "—")}</span>
                      <span className={chDir === despin.dir ? "z-sig-on" : ""}>{tr.sigCharm}</span>
                      {mocOk && <span className={mocDir === despin.dir ? "z-moc-sig-on" : "z-moc-sig-off"}>MOC {mocDir === "down" ? "▼" : "▲"} {mocFmt}</span>}
                    </div>
                    <p className="z-pinalt-note">{tr.pinAltNegNote(cv(despin.target), despin.pts.toFixed(0), despin.anchored)}{mocOk ? (mocConflict ? ` ${tr.mocConflict(mocFmt)}` : ` ${tr.mocConfirms(mocFmt)}`) : ""}</p>
                  </div>
                </>
              );
            })() : (
              <p className="z-pinalt-none">{tr.pinAltNoDir}</p>
            )}
            <p className="z-outlook-caveat">{tr.closeCaveat}</p>
          </section>
        );
      })()}

      {isUnpinFut && unpin.state !== "idle" && data && (() => {
        const fut = data.future!;
        const isEs = fut === "/ES";
        const up = unpin.dir === "up";
        const dirCol = up ? "var(--green-dark)" : "var(--red-text)";
        const sgn = up ? "+" : "−";
        const magnet = data.closing?.strike ?? data.gex?.kingStrike ?? null;
        const flowBullish = ttBull >= ttBear; // dirección del flujo agresivo clasificado (no signo del CVD)
        const armed = unpin.state === "armed", post = unpin.state === "post", waiting = unpin.state === "waiting";
        const dirLbl = up ? `▲ ${tr.unpinPop}` : `▼ ${tr.unpinDrop}`;
        return (
          <section className={`z-unpin ${isEs ? "" : "z-unpin-2"} ${waiting ? "z-unpin-wait" : ""}`}>
            <header className="z-unpin-top">
              <h2 className="z-unpin-tag">{tr.unpinName} <span className="z-live-sub">{tr.unpinSub(fut)}</span></h2>
              {unpin.dir && (armed || post
                ? <span className="z-live-hdir" style={{ color: dirCol }}>{dirLbl}</span>
                : <span className="z-live-hdir z-live-hdir-would" style={{ color: dirCol }}>{tr.wouldBe(dirLbl)}</span>)}
            </header>
            <div className="z-unpin-badges">
              {armed && <span className="z-live-waitbadge">● {tr.unpinArmed}</span>}
              {post && <span className="z-lean-chip" style={{ color: dirCol, background: up ? "var(--green-bg)" : "var(--red-bg)" }}>{up ? "▲ " : "▼ "}{tr.unpinPlaying}</span>}
              {waiting && <span className="z-live-waitbadge">● {tr.waitLabel}</span>}
              <span className="z-unpin-trade">{tr.unpinTradeOn(fut)}</span>
              {!isEs && <span className="z-unpin-2nd">{tr.unpinSecondary}</span>}
              {(armed || (waiting && unpin.hasPin)) && unpin.defendedFrom && (
                <span className="z-unpin-tell">{unpin.defendedFrom === "above" ? tr.unpinTellAbove : tr.unpinTellBelow}</span>
              )}
            </div>
            {armed && (
              <div className="z-close-main z-unpin-row">
                <div><span className="z-sum-lbl">{tr.unpinSnapbackLbl} {fut}</span><b className="z-close-netgex" style={{ color: dirCol }}>{sgn}{unpin.lo} {tr.aTo} {sgn}{unpin.hi} {tr.pts}</b></div>
                <div><span className="z-sum-lbl">{tr.unpinSpotMagnetLbl}</span><b>{dec(cvN(data.spot))} / {magnet != null ? cv(magnet) : "—"}</b></div>
                <div><span className="z-sum-lbl">{tr.unpinFlowLbl}</span><b style={{ color: flowBullish ? "var(--green-dark)" : "var(--red-text)" }}>{flowBullish ? tr.unpinBull : tr.unpinBear}</b></div>
                <div><span className="z-sum-lbl">{tr.unpinToCloseLbl}</span><b style={{ color: "var(--amber-text)" }}>{unpin.minToClose} min</b></div>
              </div>
            )}
            {post && (
              <div className="z-close-main z-unpin-row">
                <div><span className="z-sum-lbl">{fut} · {tr.unpinSinceLbl}</span><b className="z-close-netgex" style={{ color: dirCol }}>{unpin.move != null && unpin.move >= 0 ? "+" : ""}{unpin.move?.toFixed(0)} {tr.pts}</b></div>
                <div><span className="z-sum-lbl">{tr.unpinSnapbackLbl}</span><b>{sgn}{unpin.lo} {tr.aTo} {sgn}{unpin.hi} {tr.pts}</b></div>
              </div>
            )}
            {waiting && unpin.hasPin && (
              <div className="z-close-main z-unpin-row">
                <div><span className="z-sum-lbl">{tr.unpinSnapbackLbl} {fut}</span><b className="z-close-netgex" style={{ color: dirCol }}>{sgn}{unpin.lo} {tr.aTo} {sgn}{unpin.hi} {tr.pts}</b></div>
                <div><span className="z-sum-lbl">{tr.unpinSpotMagnetLbl}</span><b>{dec(cvN(data.spot))} / {magnet != null ? cv(magnet) : "—"}</b></div>
              </div>
            )}
            <p className="z-close-note">{waiting ? (unpin.hasPin ? tr.unpinWaitNote : tr.unpinNoPin) : tr.unpinOrigin(fut)}</p>
          </section>
        );
      })()}

      {data?.forecast && (
        <section className="z-fc">
          <header>
            <h2>{tr.scenariosClose}</h2>
            {data.forecast.calibShiftPct !== 0 && (
              <span className="z-calib-chip" title={tr.autoAdjustedTitle}>
                {tr.autoAdjusted(`${data.forecast.calibShiftPct > 0 ? "+" : ""}${data.forecast.calibShiftPct.toFixed(2)}`)}
              </span>
            )}
            <span>
              {tr.fcMeta(
                data.forecast.hoursToClose.toFixed(1),
                (data.forecast.iv * 100).toFixed(1),
                data.forecast.sigma.toFixed(1),
                data.forecast.sigmaPct.toFixed(2),
              )}
            </span>
          </header>

          {data.forecast.caveat && (
            <div className="z-fc-caveat">{data.forecast.caveat}</div>
          )}

          <div className="z-fc-grid">
            {data.forecast.scenarios.map((s) => (
              <div key={s.kind} className={`z-fc-card z-fc-${s.kind}`}>
                <span className="z-sum-lbl">
                  {s.kind === "bull" ? tr.bullish : s.kind === "bear" ? tr.bearish : tr.base}
                </span>
                <b>{cv(s.target).toFixed(2)}</b>
                <span className="z-fc-pct">
                  {s.changePct >= 0 ? "+" : ""}{s.changePct.toFixed(2)}%
                </span>
                <div className="z-fc-prob">
                  <i style={{ width: `${s.probTouch * 100}%` }} />
                  <span>{tr.pctTouch((s.probTouch * 100).toFixed(0))}</span>
                </div>
                <p>{s.reason}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {data && (
        <p className="z-caveat">{tr.aggrCaveat}</p>
      )}

      {data && (
        <section className="z-chart-card">
          <div className="z-chart-head">
            {tr.chartHead(data.analysisTicker)}
            {isFut && data.future && data.analysisTicker !== data.future && <span className="z-chart-sub">{tr.chartSubFut(data.future, `${basis >= 0 ? "+" : ""}${basis.toFixed(2)}`)}</span>}
          </div>
          <ZeroDteChart
            ticker={data.analysisTicker}
            reloadKey={data.asOf}
            basis={basis}
            lang={lang}
            maxCall={data.summary.maxCallStrike}
            maxPut={data.summary.maxPutStrike}
            magnet={data.gex.kingStrike}
            flip={data.gex.flipStrike}
            target={data.closing?.strike ?? null}
            spot={data.spot}
          />
          <p className="z-chart-legend">
            <b style={{ color: "#5b21b6" }}>{lang === "en" ? "Violet" : "Violeta"}</b> = {tr.chartLegend.violet} ·{" "}
            <b style={{ color: "#374151" }}>{lang === "en" ? "gray" : "gris"}</b> = {tr.chartLegend.gray} ·{" "}
            <b style={{ color: "#9a3412" }}>{lang === "en" ? "orange" : "naranja"}</b> = {tr.chartLegend.orange} ·{" "}
            <b style={{ color: "#92400e" }}>{lang === "en" ? "yellow" : "amarillo"}</b> = {tr.chartLegend.yellow} ·{" "}
            <b style={{ color: "#1d4ed8" }}>{lang === "en" ? "blue dashed" : "azul punteado"}</b> = {tr.chartLegend.blue}
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
                  ? tr.aggrNoteFuture
                  : flow?.error
                    ? tr.aggrNoteError(flow.error)
                    : flow
                      ? tr.aggrNoteOk(flow.cycles, flow.contracts)
                      : tr.aggrLoading}
              </th>
            </tr>
            <tr>
              <th>{tr.thAggressor}</th>
              <th className="z-vol">{tr.thVolume}</th>
              <th>OI</th>
              <th>Delta</th>
              <th className="z-mid">{tr.thStrike}</th>
              <th>Delta</th>
              <th>OI</th>
              <th className="z-vol">{tr.thVolume}</th>
              <th>{tr.thAggressor}</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line, i) => (
              <Fragment key={line.strike}>
                {i === spotAt && spot != null && (
                  <tr className="z-spotrow">
                    <td colSpan={9} className="z-spotband">
                      <span className="z-spot-flag">{tr.currentPrice}</span>
                      <b>{dec(cvN(spot))}</b>
                      <span className="z-spot-hint">{tr.spotHint}</span>
                    </td>
                  </tr>
                )}
                <Line
                  line={line}
                  cv={cv}
                  tr={tr}
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
            <h2>{tr.modelAccuracy}</h2>
            <span>
              {evalu.empty || !evalu.maturedCount
                ? tr.noSessions
                : tr.sessionsEvaluated(evalu.maturedCount)}
            </span>
          </header>
          {evalu.empty || !evalu.maturedCount ? (
            <p className="z-eval-wait">{tr.evalWait}</p>
          ) : (
            <div className="z-eval-grid">
              <div>
                <span className="z-sum-lbl">{tr.baseMeanError}</span>
                <b>{evalu.meanAbsErrorPct?.toFixed(2) ?? "—"}%</b>
              </div>
              <div>
                <span className="z-sum-lbl">{tr.bias}</span>
                <b>{evalu.biasPct == null ? "—" : `${evalu.biasPct >= 0 ? "+" : ""}${evalu.biasPct.toFixed(2)}%`}</b>
                <span className="z-sum-sub">
                  {evalu.biasPct == null ? "" : evalu.biasPct >= 0 ? tr.biasAboveSub : tr.biasBelowSub}
                </span>
              </div>
              <div>
                <span className="z-sum-lbl">{tr.bullTouched}</span>
                <b>{evalu.bullTouchRate?.toFixed(0) ?? "—"}%</b>
              </div>
              <div>
                <span className="z-sum-lbl">{tr.bearTouched}</span>
                <b>{evalu.bearTouchRate?.toFixed(0) ?? "—"}%</b>
              </div>
            </div>
          )}
        </section>
      )}

      {data && <StrategySuggestionsPanel suggestions={data.suggestions} tr={tr} cv={cv} />}

      <p className="z-foot">{tr.chainFoot.intro} {tr.chainFoot.wall} {tr.chainFoot.magnet}</p>
    </div>
  );
}

function Line({
  line,
  cv,
  tr,
  maxVol,
  spot,
  topCall,
  topPut,
  isMagnet,
  callAggr,
  putAggr,
}: {
  line: ChainLine;
  cv: (v: number) => number;
  tr: Dict;
  maxVol: number;
  spot: number | null;
  topCall: boolean;
  topPut: boolean;
  isMagnet: boolean;
  callAggr: AggressorRead | null;
  putAggr: AggressorRead | null;
}) {
  const { call, put, strike, from } = line;
  // ITM: call por debajo del spot, put por encima. Igual que una chain real.
  const callItm = spot != null && strike < spot;
  const putItm = spot != null && strike > spot;
  const rankedCall = from === "call" || from === "both";
  const rankedPut = from === "put" || from === "both";

  return (
    <tr className={`${topCall || topPut ? "z-toprow" : ""} ${isMagnet ? "z-magnetrow" : ""}`}>
      <Aggr read={callAggr} itm={callItm} tr={tr} />
      <td className={`z-vol ${callItm ? "z-itm" : ""} ${rankedCall ? "z-ranked" : ""} ${topCall ? "z-top z-top-call" : ""}`}>
        {topCall && <em className="z-tag">MAX CALL</em>}
        <span>{num(call?.volume)}</span>
        <i style={{ width: `${((call?.volume ?? 0) / maxVol) * 100}%` }} className="z-bar z-bar-call" />
      </td>
      <td className={callItm ? "z-itm" : ""}>{num(call?.openInterest)}</td>
      <td className={callItm ? "z-itm" : ""}>{dec(call?.greeks?.delta)}</td>

      <td className={`z-mid ${isMagnet ? "z-magnet" : ""}`}>
        {isMagnet && <em className="z-magnet-tag" title="imán del GEX">🧲</em>}
        {cv(strike)}
      </td>

      <td className={putItm ? "z-itm" : ""}>{dec(put?.greeks?.delta)}</td>
      <td className={putItm ? "z-itm" : ""}>{num(put?.openInterest)}</td>
      <td className={`z-vol ${putItm ? "z-itm" : ""} ${rankedPut ? "z-ranked" : ""} ${topPut ? "z-top z-top-put" : ""}`}>
        {topPut && <em className="z-tag">MAX PUT</em>}
        <span>{num(put?.volume)}</span>
        <i style={{ width: `${((put?.volume ?? 0) / maxVol) * 100}%` }} className="z-bar z-bar-put" />
      </td>
      <Aggr read={putAggr} itm={putItm} tr={tr} />
    </tr>
  );
}

/** Puntos de la opción → "$ por contrato" (×100), sin decimales. */
function optUsd(pts: number): string {
  return `$${Math.round(pts * 100).toLocaleString("en-US")}`;
}

/** Panel final: sugerencias de estrategia de riesgo definido (vertical, credit
 *  call, iron condor) sobre la misma cadena/GEX de arriba. Puramente
 *  informativo — mismo disclaimer que "GEX Trade". */
function StrategySuggestionsPanel({
  suggestions,
  tr,
  cv,
}: {
  suggestions: StrategySuggestions | null;
  tr: Dict;
  cv: (v: number) => number;
}) {
  const v = suggestions?.vertical ?? null;
  const cc = suggestions?.creditCall ?? null;
  const ic = suggestions?.ironCondor ?? null;
  const any = v || cc || ic;

  return (
    <section className="z-strat">
      <header className="z-strat-head">
        <h2>{tr.strategyHead}</h2>
        <span>{tr.strategySub}</span>
      </header>

      {!any && <p className="z-strat-empty">{tr.strategyNone}</p>}

      {any && (
        <div className="z-strat-grid">
          {v && (
            <div className="z-strat-card">
              <div className="z-strat-card-tag">{v.kind === "bull_call" ? tr.strategyVerticalBullCall : tr.strategyVerticalBearPut}</div>
              <div className="z-strat-card-legs">
                <span>{tr.strategyBuy} {cv(v.longStrike)}{v.kind === "bull_call" ? "C" : "P"}</span>
                <span>{tr.strategySell} {cv(v.shortStrike)}{v.kind === "bull_call" ? "C" : "P"}</span>
              </div>
              <div className="z-strat-card-num">
                <span className="z-strat-card-lbl">{tr.strategyDebit}</span>
                <b>{v.debit != null ? `${v.debit.toFixed(2)} (${optUsd(v.debit)})` : tr.strategyNoQuote}</b>
              </div>
              <p className="z-strat-card-reason">{v.reason}</p>
            </div>
          )}

          {cc && (
            <div className="z-strat-card">
              <div className="z-strat-card-tag">{tr.strategyCreditCall}</div>
              <div className="z-strat-card-legs">
                <span>{tr.strategySell} {cv(cc.shortStrike)}C</span>
                <span>{tr.strategyBuy} {cv(cc.longStrike)}C</span>
              </div>
              <div className="z-strat-card-num">
                <span className="z-strat-card-lbl">{tr.strategyCredit}</span>
                <b>{cc.credit != null ? `${cc.credit.toFixed(2)} (${optUsd(cc.credit)})` : tr.strategyNoQuote}</b>
              </div>
              <p className="z-strat-card-reason">{cc.reason}</p>
            </div>
          )}

          {ic && (
            <div className="z-strat-card">
              <div className="z-strat-card-tag">{tr.strategyIronCondor}</div>
              <div className="z-strat-card-legs">
                <span>{tr.strategySell} {cv(ic.shortPut)}P / {tr.strategyBuy} {cv(ic.longPut)}P</span>
                <span>{tr.strategySell} {cv(ic.shortCall)}C / {tr.strategyBuy} {cv(ic.longCall)}C</span>
              </div>
              <div className="z-strat-card-num">
                <span className="z-strat-card-lbl">{tr.strategyCredit}</span>
                <b>{ic.credit != null ? `${ic.credit.toFixed(2)} (${optUsd(ic.credit)})` : tr.strategyNoQuote}</b>
              </div>
              {ic.beLow != null && ic.beHigh != null && (
                <div className="z-strat-card-num">
                  <span className="z-strat-card-lbl">{tr.strategyBreakeven}</span>
                  <b>{cv(ic.beLow)} – {cv(ic.beHigh)}</b>
                </div>
              )}
              <p className="z-strat-card-reason">{ic.reason}</p>
            </div>
          )}
        </div>
      )}

      <p className="z-strat-disc">{tr.strategyDisclaimer}</p>
    </section>
  );
}

/** Celda de agresor. Vacía si no hubo muestra suficiente. */
function Aggr({ read, itm, tr }: { read: AggressorRead | null; itm: boolean; tr: Dict }) {
  if (!read) return <td className={`z-aggr ${itm ? "z-itm" : ""}`}>—</td>;
  const label =
    read.side === "compra" ? tr.aggrBuy :
    read.side === "venta" ? tr.aggrSell :
    read.side === "mid" ? tr.aggrMid : tr.aggrMixed;
  return (
    <td className={`z-aggr z-aggr-${read.side} ${itm ? "z-itm" : ""}`} title={read.meaning}>
      <b>{label}</b> {(read.pct * 100).toFixed(0)}%
      <small>{read.trades}</small>
    </td>
  );
}

const CSS = `
.z-wrap { max-width: 1440px; margin: 0 auto; padding: 28px 40px 90px; font-size: 15px; }
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
.z-controls button.z-theme { background: var(--panel); border-color: var(--border); color: var(--text); font-weight: 400; padding: 8px 11px; font-size: 15px; line-height: 1; }
.z-controls button.z-theme:hover { background: var(--panel-2); }

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
.z-side .z-put { color: var(--red-text); background: var(--red-bg); }

.z-mid { text-align: center !important; font-weight: 700; background: var(--panel-2);
  border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
.z-itm { background: rgba(47,107,255,.05); }
.z-vol { position: relative; font-weight: 600; }
.z-ranked span { color: var(--text); }
.z-vol span { position: relative; z-index: 1; }
/* Las barras crecen hacia AFUERA desde el centro de la tabla: las de call se
   anclan a la derecha de su celda y las de put a la izquierda. Asi las dos
   columnas de volumen se leen como un histograma espejado alrededor del strike. */
.z-bar { position: absolute; bottom: 0; height: 4px; display: block; border-radius: 2px; }
.z-bar-call { right: 0; background: var(--call); }
.z-bar-put { left: 0; background: var(--put); }

/* Marcador de precio actual: banda divisoria, no una fila de datos. */
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

/* Gráfica con niveles del agente. */
.z-chart-card { border: 1px solid var(--border); background: var(--panel);
  border-radius: 12px; padding: 14px 16px; margin: 0 0 16px; }
.z-chart-head { font-size: 14px; font-weight: 500; color: var(--text); margin-bottom: 8px; }
.z-chart-wrap { width: 100%; overflow-x: auto; }
.z-chart-legend { margin: 8px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
.z-chart-msg { padding: 28px 12px; text-align: center; color: var(--faint); font-size: 13px; }

/* Resumen: los dos strikes que mandan + ratio put/call. */
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
.z-sum-put b { color: var(--red-text); }

.z-caveat { background: var(--amber-bg); border: 1px solid var(--amber-border);
  color: var(--amber-text); padding: 10px 14px; border-radius: 8px;
  font-size: 12.5px; line-height: 1.5; margin: 0 0 16px; }

/* Pronóstico de cierre (3-4pm) — destacado. */
.z-close { border: 2px solid var(--accent); background: var(--accent-dim);
  border-radius: 12px; padding: 18px 20px; margin: 0 0 16px; }
.z-close-baja { border-color: var(--border); background: var(--panel-2); }
/* Fase pending (aún no calculado) y final (valor fijado): tono neutro. */
.z-close-pending { border-color: var(--border); border-style: dashed; background: var(--panel-2); }
.z-close-pending .z-close-strike { color: var(--faint); }
.z-close-final { border-color: var(--border); background: var(--panel-2); }
.z-close-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-close-tag { font-size: 26px; font-weight: 700; letter-spacing: -.3px; color: var(--text); }
.z-close-netgex { font-size: 24px; font-weight: 700; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
.z-close-maxpain { font-size: 24px; font-weight: 700; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
.z-close-prov { font-size: 13px; font-weight: 400; color: var(--faint); }
.z-unpin { border: 2px solid var(--accent); background: var(--accent-dim); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.z-unpin-2 { border: 1px solid var(--border); background: var(--panel); }
.z-unpin-top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.z-unpin-tag { margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -.3px; color: var(--text); }
.z-unpin-badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.z-unpin-trade { font-size: 12px; font-weight: 700; color: #fff; background: var(--accent); padding: 4px 10px; border-radius: 999px; }
.z-unpin-2nd { font-size: 12px; font-weight: 700; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); padding: 4px 10px; border-radius: 999px; }
.z-unpin-tell { font-size: 13px; color: var(--faint); }
.z-unpin-row { border-top: 1px solid var(--border); padding-top: 14px; gap: 28px; }
.z-unpin-wait { border-style: dashed; }
.z-close-min { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-close-main { display: flex; gap: 32px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 10px; }
.z-close-main > div { display: flex; flex-direction: column; gap: 2px; }
.z-close-strike { font-size: 34px; letter-spacing: -0.6px; color: var(--accent);
  font-variant-numeric: tabular-nums; line-height: 1.05; }
.z-close-range b { font-size: 18px; font-variant-numeric: tabular-nums; }
.z-close-note { margin: 0 0 6px; font-size: 15px; color: var(--text); line-height: 1.5; }
/* Despin: objetivo si rompe el pin (dentro de GEX Pinning). */
.z-despin { margin: 14px 0 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.z-despin-weak { opacity: .72; }
.z-despin-head { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
.z-despin-t { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.z-despin-dir { font-size: 12px; font-weight: 800; padding: 3px 10px; border-radius: 999px; }
.z-despin-down { color: var(--red-text); background: var(--red-bg); border: 1px solid var(--red-soft); }
.z-despin-up { color: var(--green-dark); background: var(--green-bg); border: 1px solid var(--green); }
.z-despin-row { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.z-despin-tgt { display: flex; flex-direction: column; gap: 2px; }
.z-despin-tgt b { font-size: 24px; font-weight: 800; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
.z-despin-c-down .z-despin-tgt b { color: var(--red-text); }
.z-despin-c-up .z-despin-tgt b { color: var(--green-dark); }
.z-despin-move { font-size: 12.5px; color: var(--muted); }
.z-despin-wall { font-size: 11px; color: var(--muted); background: var(--panel); border: 1px solid var(--border); padding: 3px 9px; border-radius: 6px; }
.z-despin-anchor { font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
.z-despin-note { margin: 9px 0 0; font-size: 11px; color: var(--faint); line-height: 1.5; }
/* GEX Pinning alterno (Charm) */
.z-pinalt { border: 2px solid var(--accent); background: var(--accent-dim); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.z-pinalt-neg { border-color: var(--border); background: var(--panel-2); }
.z-pinalt-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-pinalt-tag { font-size: 24px; font-weight: 700; letter-spacing: -.3px; color: var(--text); }
.z-pinalt-alt { font-size: 10px; font-weight: 700; letter-spacing: .5px; color: var(--bg); background: #b79bff; padding: 2px 7px; border-radius: 5px; }
.z-pinalt-gtag { font-size: 10px; font-weight: 700; color: var(--red-text); background: var(--red-bg); border: 1px solid var(--red-soft); padding: 2px 8px; border-radius: 999px; }
.z-pinalt-dirclose { font-size: 30px; font-weight: 700; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
.z-pinalt-base { font-size: 20px; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-pinalt-charm, .z-pinalt-dir { border-left: 3px solid var(--faint); background: var(--panel-2); border-radius: 0 8px 8px 0; padding: 10px 14px; margin-top: 12px; }
.z-pinalt-charm-up, .z-pinalt-dir-up { border-left-color: var(--green); background: var(--green-bg); }
.z-pinalt-charm-down, .z-pinalt-dir-down { border-left-color: var(--red); background: var(--red-bg); }
.z-pinalt-charm-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.z-pinalt-charm-w, .z-pinalt-dir-w { font-size: 13px; font-weight: 700; color: var(--text); }
.z-pinalt-chip { font-size: 11px; font-weight: 600; background: var(--panel); border: 1px solid var(--border); padding: 1px 8px; border-radius: 999px; color: var(--muted); }
.z-pinalt-bar { height: 7px; background: var(--panel); border-radius: 4px; overflow: hidden; margin: 9px 0 0; }
.z-pinalt-bar i { display: block; height: 100%; border-radius: 4px; }
.z-pinalt-sigs { display: flex; gap: 6px; flex-wrap: wrap; margin: 9px 0 0; }
.z-pinalt-sigs span { font-size: 11px; color: var(--faint); background: var(--panel); border: 1px solid var(--border); padding: 2px 8px; border-radius: 6px; }
.z-pinalt-sigs span.z-sig-on { color: var(--text); border-color: var(--border-strong, var(--muted)); font-weight: 600; }
.z-pinalt-note { margin: 8px 0 0; font-size: 12px; color: var(--text); line-height: 1.5; }
.z-pinalt-note b { font-weight: 700; }
.z-pinalt-none { margin: 4px 0; font-size: 13px; color: var(--faint); }
/* Campo MOC manual */
.z-moc { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
.z-moc-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.z-moc-hint { font-size: 11px; color: var(--faint); }
.z-moc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.z-moc-in { width: 96px; font-size: 15px; font-weight: 600; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-variant-numeric: tabular-nums; }
.z-moc-in:focus { outline: none; border-color: var(--accent); }
.z-moc-unit { font-size: 13px; color: var(--muted); }
.z-moc-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.z-moc-toggle button { font-size: 13px; font-weight: 600; color: var(--muted); background: var(--panel); border: none; padding: 7px 13px; cursor: pointer; }
.z-moc-toggle button.z-moc-buy { color: #fff; background: var(--green-dark); }
.z-moc-toggle button.z-moc-sell { color: #fff; background: #c23b46; }
.z-moc-tier { font-size: 11px; font-weight: 600; color: var(--amber-text); background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 3px 9px; border-radius: 999px; }
.z-moc-clear { font-size: 15px; line-height: 1; color: var(--faint); background: none; border: none; cursor: pointer; padding: 4px 6px; }
.z-moc-clear:hover { color: var(--text); }
.z-moc-sig-on { font-size: 11px; font-weight: 700; color: var(--bg); background: var(--red-text); padding: 2px 8px; border-radius: 6px; }
.z-pinalt-dir-up .z-moc-sig-on { background: var(--green-dark); }
.z-moc-sig-off { font-size: 11px; font-weight: 600; color: var(--amber-text); background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 2px 8px; border-radius: 6px; }
.z-close-acc { margin: 0 0 8px; font-size: 12px; color: var(--muted);
  padding: 6px 10px; background: var(--panel); border-radius: 6px; display: inline-block; }
.z-close-acc b { color: var(--text); }
.z-close-conf { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 3px 10px; border-radius: 999px; }
.z-close-conf-alta { color: var(--green-dark); background: var(--green-bg); }
.z-close-conf-media { color: var(--amber-text); background: var(--amber-bg); }
.z-close-conf-baja { color: var(--muted); background: var(--panel); border: 1px solid var(--border); }
.z-close-min-right { margin-left: auto; }
.z-close-alta .z-close-strike { color: var(--green-dark); }
.z-close-media .z-close-strike { color: var(--amber-text); }
.z-close-baja .z-close-strike { color: var(--muted); }
.z-close-count { margin: 2px 0 14px; }
.z-close-count-top { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.z-close-count-top b { color: var(--text); font-variant-numeric: tabular-nums; }
.z-close-count-3 { font-size: 11px; color: var(--faint); }
.z-close-bar { position: relative; height: 8px; background: var(--panel-2); border-radius: 5px; }
.z-close-bar i { display: block; height: 100%; background: var(--accent); border-radius: 5px; }
.z-close-bar-mark { position: absolute; top: -2px; width: 2px; height: 12px; background: var(--faint); }
.z-close-count-ends { display: flex; justify-content: space-between; margin-top: 4px; font-size: 10px; color: var(--faint); }
.z-close-rbar { position: relative; height: 10px; background: var(--panel-2); border-radius: 5px; }
.z-close-rmark { position: absolute; top: -3px; width: 3px; height: 16px; border-radius: 2px; transform: translateX(-50%); }
.z-close-rends { display: flex; justify-content: space-between; margin-top: 5px; font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums; }
.z-close-rmid { font-weight: 700; }

.z-calib-chip { font-size: 11px; font-weight: 700; background: var(--accent-dim);
  color: var(--accent); padding: 2px 9px; border-radius: 999px; }

/* Mejor trade ahora (en vivo). */
.z-live { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px;
  margin: 0 0 16px; background: var(--panel); }
.z-live-long { border-color: var(--green); background: var(--green-bg); }
.z-live-short { border-color: var(--red-soft); background: var(--red-bg); }
.z-live-none { border-color: var(--border); background: var(--panel-2); }
.z-live-idle { border-color: var(--border); background: var(--panel-2); }
.z-live-changed { box-shadow: 0 0 0 3px var(--amber-bg); }
.z-live-idlehead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.z-live-waitbadge { font-size: 17px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: var(--amber-text); background: var(--amber-bg); border: 1.5px solid var(--amber-border);
  padding: 5px 16px; border-radius: 9px; display: inline-flex; align-items: center; gap: 8px; }
.z-live-waitbadge::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--amber); }
.z-live-nopin { color: var(--red-text); background: var(--red-bg); border-color: var(--red-soft); }
.z-live-nopin::before { background: var(--red); }
.z-live-would { font-size: 13.5px; font-weight: 700; }
.z-live-hdir { font-size: 24px; font-weight: 700; }
.z-live-hdir-would { font-size: 22px; }
.z-live-idlereason { flex: 1; min-width: 220px; font-size: 13px; color: var(--text); line-height: 1.4; }
.z-alt-suffix { font-size: 11px; font-weight: 400; color: var(--muted); letter-spacing: 0; text-transform: none; }
.z-live-sub { font-size: 22px; font-weight: 400; color: var(--muted); letter-spacing: 0; text-transform: none; }
.z-live-momtag { font-size: 11px; font-weight: 700; letter-spacing: .03em; color: var(--amber-text);
  background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 2px 9px; border-radius: 999px; }
/* GEX Trade alterno: niveles de convicción + aviso de reversión */
.z-live-revwarn { font-size: 12px; font-weight: 700; color: var(--amber-text); background: var(--amber-bg); border: 1.5px solid var(--amber-border); padding: 3px 10px; border-radius: 999px; }
.z-live-soft { border-style: dashed; }
.z-live-tierrow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; }
.z-live-tier { font-size: 13px; font-weight: 700; padding: 4px 11px; border-radius: 999px; }
.z-live-tier-strong { color: var(--green-dark); background: var(--green-bg); }
.z-live-tier-soft { color: var(--amber-text); background: var(--amber-bg); border: 1px solid var(--amber-border); }
.z-live-tiernote { font-size: 13px; color: var(--faint); line-height: 1.4; }
.z-flow-tag-flow { color: #fff; background: var(--accent); }
.z-altcmp { border: 1px dashed var(--border); border-radius: 12px; padding: 12px 16px; margin: 0 0 16px; background: var(--panel-2); }
.z-altcmp h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.z-altcmp-line { margin: 0; font-size: 14px; color: var(--text); font-weight: 500; }
.z-altcmp-sub { margin: 4px 0 0; font-size: 12px; color: var(--muted); line-height: 1.45; }
.z-live-idlerow { align-items: flex-end; gap: 26px; }
.z-live header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-live h2 { margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -.3px; }
.z-live-alert { font-size: 11px; font-weight: 700; background: var(--amber-bg);
  color: var(--amber-text); border: 1px solid var(--amber-border); padding: 2px 8px; border-radius: 999px; }
.z-live-clock { margin-left: auto; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-live-row { display: flex; align-items: flex-end; gap: 22px; flex-wrap: wrap; margin-bottom: 8px; }
.z-live-row > div { display: flex; flex-direction: column; gap: 2px; }
.z-live-row b { font-size: 23px; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }
.z-live-dir { font-size: 18px; font-weight: 700; }
.z-dir-long { color: var(--green-dark); }
.z-dir-short { color: var(--red-text); }
.z-live-reason { margin: 0 0 6px; font-size: 12.5px; color: var(--text); line-height: 1.45; }
.z-live-msg { margin: 0 0 6px; font-size: 13px; color: var(--muted); line-height: 1.5; }

/* GEX Ticket: contrato sugerido (va arriba del GEX Trade). */
.z-ticket { border: 2px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; background: var(--panel); }
.z-ticket-long { border-color: var(--green); background: var(--green-bg); }
.z-ticket-short { border-color: var(--red-soft); background: var(--red-bg); }
.z-ticket-idle { border-color: var(--border); background: var(--panel-2); }
.z-ticket header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.z-ticket h2 { margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -.3px; }
.z-ticket-badge { margin-left: auto; font-size: 13px; font-weight: 800; letter-spacing: .06em; padding: 4px 12px; border-radius: 8px;
  color: var(--green-dark); background: var(--green-bg); border: 1px solid var(--green); }
.z-ticket-short .z-ticket-badge { color: var(--red-text); background: var(--red-bg); border-color: var(--red-soft); }
.z-ticket-thesis { margin: 0 0 12px; font-size: 12.5px; color: var(--muted); line-height: 1.4; }
.z-ticket-buy { display: flex; align-items: baseline; gap: 11px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.z-ticket-act { font-size: 12px; font-weight: 800; letter-spacing: .06em; padding: 3px 9px; border-radius: 6px;
  color: var(--green-dark); background: var(--green-bg); border: 1px solid var(--green); }
.z-ticket-short .z-ticket-act { color: var(--red-text); background: var(--red-bg); border-color: var(--red-soft); }
.z-ticket-ctr { font-size: 25px; font-weight: 800; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
.z-ticket-at { font-size: 13px; color: var(--muted); }
.z-ticket-price { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }
.z-ticket-quote { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.z-ticket-st { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 14px 0 4px; }
.z-ticket-box { display: flex; flex-direction: column; gap: 3px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.z-ticket-k { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.z-ticket-v { font-size: 21px; font-weight: 800; font-variant-numeric: tabular-nums; }
.z-ticket-tgt { color: var(--green-dark); }
.z-ticket-stp { color: var(--red-text); }
.z-ticket-idx { font-size: 11px; color: var(--faint); }
.z-ticket-up { color: var(--green-dark); }
.z-ticket-dn { color: var(--red-text); }
.z-ticket-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.z-ticket-chip { font-size: 11px; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); padding: 4px 9px; border-radius: 6px; font-variant-numeric: tabular-nums; }
.z-ticket-chip b { color: var(--text); }
.z-ticket-flow { color: var(--red-text); background: var(--red-bg); border-color: var(--red-soft); }
.z-ticket-long .z-ticket-flow { color: var(--green-dark); background: var(--green-bg); border-color: var(--green); }
.z-ticket-foot { margin: 14px 0 0; font-size: 11px; color: var(--faint); line-height: 1.5; border-top: 1px solid var(--border); padding-top: 10px; }
.z-ticket-none { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
@media (max-width: 640px) { .z-ticket-st { grid-template-columns: 1fr; } }

/* Simulador en papel. */
.z-sim { border: 1px solid var(--border); background: var(--panel);
  border-radius: 10px; padding: 16px; margin: 0 0 16px; }
.z-sim header { display: flex; justify-content: space-between; align-items: baseline;
  gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.z-sim h2 { margin: 0; font-size: 15px; }
.z-sim-flag { font-size: 11px; font-weight: 700; letter-spacing: .03em;
  background: var(--amber-bg); color: var(--amber-text);
  border: 1px solid var(--amber-border); padding: 2px 8px; border-radius: 999px; }
.z-sim-today { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  font-size: 13px; padding: 10px 12px; background: var(--panel-2);
  border-radius: 8px; margin-bottom: 12px; font-variant-numeric: tabular-nums; }
.z-sim-today b { color: var(--text); }
.z-sim-dir { font-weight: 700; font-size: 13px; }
.z-sim-long { color: var(--green-dark); }
.z-sim-short { color: var(--red-text); }
.z-sim-open { color: var(--muted); }
.z-sim-none { color: var(--muted); }
.z-sim-res { font-weight: 700; margin-left: auto; }
.z-sim-win { color: var(--green-dark); }
.z-sim-loss { color: var(--red-text); }
.z-sim-flat { color: var(--muted); }
.z-sim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-md); }
.z-sim-grid > div { display: flex; flex-direction: column; gap: 2px; }
.z-sim-grid b { font-size: 20px; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }
.z-sim-pos { color: var(--green-dark); }
.z-sim-neg { color: var(--red-text); }

/* Precisión del modelo (auto-evaluación). */
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

/* Agresor: compra vs venta, acumulado durante la sesión. */
.z-aggr { font-size: 11px; white-space: nowrap; color: var(--faint); }
.z-aggr b { font-size: 10.5px; letter-spacing: .03em; }
.z-aggr small { display: inline-block; margin-left: 4px; font-size: 9.5px;
  color: var(--faint); opacity: .8; }
.z-aggr-compra { color: var(--green-dark); }
.z-aggr-venta { color: var(--red-text); }
.z-aggr-mixto, .z-aggr-mid { color: var(--muted); }
.z-aggr-note { text-align: center !important; font-weight: 500 !important;
  text-transform: none !important; letter-spacing: 0 !important;
  font-size: 11px !important; color: var(--muted) !important;
  background: var(--panel) !important; padding: 6px !important; }

/* Barra de vencimientos. */
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

/* Banner de conversion a futuro (/ES, /NQ). */
.z-basis { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
  background: var(--blue-bg, #eff6ff); border: 1px solid var(--blue-soft, #bfdbfe);
  color: var(--text); padding: 10px 14px; border-radius: 8px; margin: 0 0 16px;
  font-size: 12.5px; line-height: 1.5; }
.z-basis-tag { font-weight: 700; color: #1d4ed8; letter-spacing: .3px; }
.z-basis-note { flex-basis: 100%; color: var(--muted); font-size: 12px; }
.z-chart-sub { color: var(--muted); font-weight: 400; font-size: 12px; }

/* Panorama a corto plazo — lo primero y mas visible. */
.z-outlook { border: 1px solid var(--border); border-left-width: 4px; background: var(--panel);
  border-radius: 12px; padding: 18px 20px; margin: 0 0 16px; }
.z-lean-alcista { border-left-color: var(--green); }
.z-lean-bajista { border-left-color: var(--red); }
.z-lean-lateral { border-left-color: var(--muted); }
.z-outlook-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.z-outlook-tag { font-size: 26px; text-transform: none; letter-spacing: -.3px;
  color: var(--text); font-weight: 700; }
.z-lean-chip { font-size: 18px; font-weight: 700; padding: 4px 12px; border-radius: 999px; }
.z-lean-chip-alcista { background: var(--green-bg); color: var(--green-dark); }
.z-lean-chip-bajista { background: var(--red-bg); color: var(--red-text); }
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
.z-flow-bar { display: inline-block; width: 70px; height: 5px; border-radius: 3px;
  background: var(--border); position: relative; overflow: hidden; }
.z-flow-bar i { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
.z-outlook-caveat { margin: 0; font-size: 11.5px; color: var(--faint); line-height: 1.45; }

/* Gamma del día. */
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
.z-gex-negative .z-gex-grid > div:first-child b { color: var(--red-text); }
.z-gex-grid .z-sum-sub { line-height: 1.45; }

/* Escenarios hasta el cierre. */
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
.z-fc-bear b, .z-fc-bear .z-fc-pct { color: var(--red-text); }
.z-fc-base { border-left: 3px solid var(--accent); }
.z-fc-base b, .z-fc-base .z-fc-pct { color: var(--accent); }
.z-fc-prob { position: relative; margin-top: 8px; height: 16px;
  background: var(--border-soft); border-radius: 4px; overflow: hidden; }
.z-fc-prob i { position: absolute; inset: 0 auto 0 0; background: var(--accent-dim); }
.z-fc-prob span { position: relative; z-index: 1; font-size: 10.5px; line-height: 16px;
  padding-left: 6px; color: var(--text); font-weight: 600; }

/* Marca del strike de mayor volumen de cada lado. */
/* Muros (MAX CALL / MAX PUT): amarillo mas marcado para identificarlos. */
.z-toprow td { background: var(--row-hot); }
/* Imán del GEX: strike en gris. Gana sobre el amarillo si coinciden. */
.z-magnet { background: var(--magnet-cell) !important; }
.z-magnetrow td:not(.z-magnet) { background: var(--row-magnet); }
.z-magnet-tag { font-style: normal; margin-right: 3px; font-size: 11px; }
.z-top { position: relative; }
.z-top span { font-weight: 800; font-size: 14px; }
.z-top-call span { color: var(--green-dark); }
.z-top-put span { color: var(--red-text); }
.z-tag { position: absolute; top: 50%; transform: translateY(-50%);
  font-size: 9px; font-style: normal; font-weight: 700; letter-spacing: .06em;
  padding: 2px 5px; border-radius: 4px; white-space: nowrap; }
/* Ambas etiquetas van a la IZQUIERDA de su celda: los números están alineados a
   la derecha, así que ahí es donde queda hueco. Con la etiqueta de put a la
   derecha se solapaba con su propia cifra. */
.z-top-call .z-tag { left: 8px; background: var(--green-bg); color: var(--green-dark); }
.z-top-put .z-tag { left: 8px; background: var(--red-bg); color: var(--red-text); }
.z-top-call span { padding-left: 4px; }
.z-toprow .z-bar { height: 5px; }

/* Volumen en vivo (velocidad + CVD). */
.z-vv { border: 1px solid var(--border); border-left-width: 4px; border-left-color: var(--accent);
  background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.z-vv-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.z-vv-tag { font-size: 26px; text-transform: none; letter-spacing: -.3px; color: var(--text); font-weight: 700; }
.z-vv-chip { font-size: 15px; font-weight: 700; padding: 4px 11px; border-radius: 999px; }
.z-vv-buy { background: var(--green-bg); color: var(--green-dark); }
.z-vv-sell { background: var(--red-bg); color: var(--red-text); }
.z-vv-clock { margin-left: auto; font-size: 15px; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-vv-wait { margin: 4px 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.z-vv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
.z-vv-big { font-size: 26px; font-weight: 700; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; line-height: 1.1; margin: 2px 0; }
.z-vv-sub { font-size: 12px; color: var(--faint); margin-bottom: 9px; line-height: 1.4; }
.z-vv-meter { position: relative; height: 11px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
.z-vv-meter i { position: absolute; inset: 0 auto 0 0; border-radius: 999px; }
.z-vv-ticks { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--faint); margin-top: 3px; font-variant-numeric: tabular-nums; }
.z-vv-div { position: relative; height: 13px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.z-vv-zero { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; background: var(--faint); transform: translateX(-50%); z-index: 2; }
.z-vv-fill { position: absolute; top: 0; bottom: 0; }
.z-vv-ends { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--faint); margin-top: 3px; }
.z-vv-spark { display: block; margin-top: 10px; height: 40px; width: 100%; }
.z-vv-live { margin-top: 12px; font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
.z-vv-live b { font-weight: 700; }
.z-vv-verdict { margin: 14px 0 0; padding: 10px 12px; background: var(--panel-2); border-radius: 8px; font-size: 13px; line-height: 1.5; color: var(--text); }
.z-vv-flow { border-left: 3px solid var(--faint); background: var(--panel-2); border-radius: 0 8px 8px 0; padding: 10px 14px; margin-top: 14px; }
.z-vv-flow-bull { border-left-color: var(--green); background: var(--green-bg); }
.z-vv-flow-bear { border-left-color: var(--red); background: var(--red-bg); }
.z-vv-flow-mixed { border-left-color: var(--amber); background: var(--amber-bg); }
.z-vv-flow-weak { opacity: .6; }
.z-vv-flow-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.z-vv-flow-word { font-size: 13px; font-weight: 700; color: var(--text); }
.z-vv-flow-bull .z-vv-flow-word { color: var(--green-dark); }
.z-vv-flow-bear .z-vv-flow-word { color: var(--red-text); }
.z-vv-flow-mixed .z-vv-flow-word { color: var(--amber-text); }
.z-vv-flow-chip { font-size: 11px; font-weight: 600; background: var(--panel); border: 1px solid var(--border); padding: 1px 8px; border-radius: 999px; color: var(--muted); }
.z-vv-flow-bar { display: flex; height: 7px; border-radius: 4px; overflow: hidden; margin-top: 9px; }
.z-vv-flow-bar i { display: block; }
.z-vv-flow-line { margin: 8px 0 0; font-size: 12.5px; color: var(--text); line-height: 1.5; }
.z-vv-flow-line b { font-weight: 700; }
.z-tt { border: 1px solid var(--border); border-left-width: 4px; border-left-color: var(--accent); background: var(--panel); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
.z-tt-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.z-tt-tag { font-size: 26px; font-weight: 700; color: var(--text); letter-spacing: -.3px; }
.z-tt-inst { font-size: 15px; font-weight: 700; background: var(--accent); color: #fff; padding: 3px 11px; border-radius: 999px; }
.z-tt-warn { font-size: 13px; color: var(--amber-text); background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 3px 10px; border-radius: 999px; }
.z-tt-takers { margin-left: auto; font-size: 15px; color: var(--amber-text); background: var(--amber-bg); border: 1px solid var(--amber-border); padding: 3px 11px; border-radius: 999px; }
.z-tt-takers b { color: var(--amber); }
.z-tt-net { display: flex; align-items: stretch; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.z-tt-net-val { flex: 1; min-width: 150px; border-radius: 8px; padding: 8px 13px; border: 1px solid var(--border); }
.z-tt-net-val.pos { background: var(--green-bg); border-color: var(--green-border, var(--border)); }
.z-tt-net-val.neg { background: var(--red-bg); border-color: var(--red-border, var(--border)); }
.z-tt-net-lbl { display: block; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-bottom: 1px; }
.z-tt-net-num { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.z-tt-net-num b { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.z-tt-net-val.pos .z-tt-net-num b { color: var(--green-dark); }
.z-tt-net-val.neg .z-tt-net-num b { color: var(--red-text); }
.z-tt-net-num span { font-size: 11px; color: var(--muted); }
.z-tt-net-read { flex: 1.3; min-width: 180px; display: flex; align-items: center; font-size: 11.5px; color: var(--text); line-height: 1.45; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 13px; }
.z-tt-score { font-variant-numeric: tabular-nums; font-weight: 600; color: inherit; opacity: .85; display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
.z-tt-swi { color: var(--amber); }
/* Fila entera por bull/bear. Especificidad 0,2,0 (row+clase) para ganar sobre
   sweep/new (0,1,0): el fondo/barra es verde/rojo también en los sweeps — el
   sweep se distingue solo por el rayo y el score alto (como el mock). */
.z-tt-row.z-tt-bull { color: var(--green); }
.z-tt-row.z-tt-bear { color: var(--red); }
.z-tt-disc { margin-top: 10px; display: flex; gap: 7px; align-items: flex-start; font-size: 11.5px; color: var(--faint); line-height: 1.5; border-top: 1px dashed var(--amber-border); padding-top: 9px; }
.z-tt-disc-ic { color: var(--faint); }
/* Resumen de texto (sesgo + quién domina) */
.z-tt-summary { border-left: 3px solid var(--faint); background: var(--panel-2); border-radius: 0 8px 8px 0; padding: 10px 14px; margin-bottom: 12px; }
.z-tt-sum-bull { border-left-color: var(--green); background: var(--green-bg); }
.z-tt-sum-bear { border-left-color: var(--red); background: var(--red-bg); }
.z-tt-sum-mixed { border-left-color: var(--amber); background: var(--amber-bg); }
.z-tt-sum-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.z-tt-sum-word { font-size: 13px; font-weight: 700; color: var(--text); }
.z-tt-sum-bull .z-tt-sum-word { color: var(--green-dark); }
.z-tt-sum-bear .z-tt-sum-word { color: var(--red-text); }
.z-tt-sum-mixed .z-tt-sum-word { color: var(--amber-text); }
.z-tt-sum-chip { font-size: 11px; font-weight: 600; background: var(--panel); border: 1px solid var(--border); padding: 1px 8px; border-radius: 999px; color: var(--muted); }
.z-tt-sum-line { margin: 6px 0 0; font-size: 12.5px; color: var(--text); line-height: 1.5; }
.z-tt-sum-line b { font-weight: 700; }
/* Encabezados de sección */
.z-tt-sech { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
.z-tt-sech-top { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.z-tt-newcnt { color: var(--amber-text); text-transform: none; letter-spacing: 0; font-weight: 600; }
/* Rollup por strike */
.z-tt-roll { display: flex; flex-direction: column; gap: 5px; }
.z-tt-rollrow { display: grid; grid-template-columns: 80px 1fr 120px; align-items: center; gap: 10px; }
.z-tt-roll-k { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.z-tt-roll-bar { height: 15px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
.z-tt-roll-bar i { display: block; height: 100%; border-radius: 4px; }
.z-tt-roll-v { text-align: right; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.z-tt-roll-v span { color: var(--muted); font-size: 11px; }
/* Feed (tape) */
.z-tt-table { font-size: 13px; overflow-x: auto; }
.z-tt-row { display: grid; grid-template-columns: 72px minmax(58px,1fr) 116px 44px 74px 84px; align-items: center; gap: 4px; padding: 7px 8px; border-bottom: 1px solid var(--border); border-radius: 6px; }
.z-tt-r { text-align: right; font-variant-numeric: tabular-nums; }
.z-tt-prem { font-weight: 700; }
.z-tt-time { color: inherit; opacity: .78; font-variant-numeric: tabular-nums; }
.z-tt-flags { display: flex; gap: 5px; justify-content: flex-end; align-items: center; }
.z-tt-open { color: var(--green-dark); font-size: 11px; }
.z-tt-cl { color: var(--faint); font-size: 11px; }
.z-tt-closed { opacity: .5; }
.z-tt-new { opacity: 1; }
.z-tt-badge { font-size: 9px; font-weight: 700; color: var(--amber-text); margin-left: 3px; letter-spacing: .04em; }
.z-tt-empty { padding: 16px 8px; color: var(--faint); font-size: 13px; text-align: center; }
.z-tt-foot { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--faint); line-height: 1.5; }
.z-vv-strikes { display: flex; gap: 6px 20px; flex-wrap: wrap; margin-top: 12px; font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.z-vv-strikes b { color: var(--text); }
@media (max-width: 560px) { .z-vv-grid { grid-template-columns: 1fr; } }
.z-strat { border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 16px 0 0; background: var(--panel); }
.z-strat-head { margin-bottom: 12px; }
.z-strat-head h2 { margin: 0 0 3px; font-size: 15px; font-weight: 700; color: var(--text); }
.z-strat-head span { font-size: 12.5px; color: var(--muted); }
.z-strat-empty { padding: 10px 4px; color: var(--faint); font-size: 13px; }
.z-strat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.z-strat-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--panel-2); }
.z-strat-card-tag { font-size: 12.5px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: .03em; margin-bottom: 8px; }
.z-strat-card-legs { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; margin-bottom: 8px; }
.z-strat-card-num { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.z-strat-card-lbl { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); min-width: 70px; }
.z-strat-card-num b { font-size: 13.5px; font-variant-numeric: tabular-nums; color: var(--text); }
.z-strat-card-reason { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--faint); }
.z-strat-disc { margin: 14px 0 0; padding-top: 10px; border-top: 1px dashed var(--border); font-size: 11.5px; color: var(--faint); line-height: 1.5; }
`;
