// Diccionario de la página del Agente 0DTE (inglés / español).
// Los textos de PROSA del agente (panorama, escenarios, mejor trade, cierre)
// vienen ya traducidos del API según ?lang=; aquí van las ETIQUETAS de la UI.

import type { Lang } from "@/lib/pdf/odteStandalone/i18n";

// Días de la semana para la barra de vencimientos (índice 0 = domingo).
export const WEEKDAYS: Record<Lang, string[]> = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  es: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
};

// Confianza que devuelve el backend ("baja"|"media"|"alta") -> palabra mostrada.
export const CONFIDENCE: Record<Lang, Record<string, string>> = {
  en: { baja: "low", media: "medium", alta: "high" },
  es: { baja: "baja", media: "media", alta: "alta" },
};

export interface Dict {
  // header
  brand: string;
  subToday: string;
  subFuture: string;
  subStrikes: (n: number | string) => string;
  optES: string;
  optNQ: string;
  loading: string;
  refresh: string;
  langLabel: string;
  themeLabel: string;
  // day bar
  expiration: string;
  today: string;
  // meta
  spot: string;
  expires: string;
  contractsInChain: (n: string) => string;
  realtimeTitle: string;
  realtimeStrikes: (n: number, age: string) => string;
  delayedChain: string;
  // basis banner
  convertedTo: (fut: string) => string;
  analysisOn: string;
  liveBasis: string;
  pts: string;
  aTo: string;
  basisNote: (fut: string, idx: string) => string;
  ndxWarn: string;
  // future-date note
  futureNote: (exp: string) => string;
  // best trade
  bestTradeNow: string;
  bestTradeSub: string;
  ticketName: string;
  ticketSub: string;
  ticketBuy: string;
  ticketMid: string;
  ticketTarget: string;
  ticketRB: string;
  ticketIndexAt: string;
  ticketRBvsIndex: (rr: string) => string;
  ticketCost: string;
  ticketRisk: string;
  ticketThesis: (dir: string, tgt: string | number, stop: string | number) => string;
  ticketThesisMom: (dir: string, tgt: string | number, stop: string | number) => string;
  ticketFlow: (n: number) => string;
  ticketTheta: string;
  ticketNone: string;
  ticketWait: string;
  ticketClosed: string;
  despinTitle: string;
  despinUp: string;
  despinDown: string;
  despinTarget: string;
  despinMove: (pts: string, up: boolean, anchored: boolean) => string;
  despinWall: (w: string | number) => string;
  despinAnchor: string;
  despinNote: string;
  despinWeak: string;
  pinAltName: string;
  pinAltAlt: string;
  charmClose: string;
  charmBuy: string;
  charmSell: string;
  charmFlat: string;
  charmInt: (p: string) => string;
  charmNotePos: (down: boolean) => string;
  pinAltDirClose: string;
  pinAltConv: (a: number, t: number) => string;
  sigFlow: string;
  sigFlip: (k: string | number) => string;
  sigCharm: string;
  pinAltNegNote: (tgt: string | number, pts: string, anchored: boolean) => string;
  pinAltNoDir: string;
  mocLabel: string;
  mocHint: string;
  mocPlaceholder: string;
  mocBuy: string;
  mocSell: string;
  mocTierMod: string;
  mocTierStrong: string;
  mocAbsorbed: (x: string) => string;
  mocConfirms: (x: string) => string;
  mocConflict: (x: string) => string;
  setupChanged: string;
  liveClock: (clock: string) => string;
  marketClosed: string;
  offSession: string;
  offSessionFut: string;
  long: string;
  short: string;
  entryNow: string;
  targetMagnet: string;
  stop: string;
  riskReward: string;
  noSetupPrefix: string;
  waitLabel: string;
  waitPrefix: string;
  wouldBe: (dir: string) => string;
  noPinLabel: string;
  distance: string;
  toActivate: string;
  priceNow: string;
  wouldBeLbl: string;
  liveCaveat: string;
  altSuffix: string;
  flowTag: string;
  momentumTag: string;
  standAside: string;
  targetWall: string;
  altRevWarn: string;
  altTierStrong: string;
  altTierSoft: string;
  altTierStrongNote: string;
  altTierSoftNote: string;
  altRevNote: string;
  altCmpTitle: string;
  altCmpLine: (o: string, a: string, n: number) => string;
  altCmpDiff: (d: number, w: number) => string;
  momentumBuilding: (n: number, required: number) => string;
  altCmpWait: string;
  tradeCmpTitle: string;
  tradeCmpLine: (o: string, a: string, n: number) => string;
  tradeCmpDiff: (d: number, w: number) => string;
  tradeCmpWait: string;
  // outlook
  nextMin: (h: number) => string;
  gexBiasName: string;
  biasBull: string;
  biasBear: string;
  biasSide: string;
  confidence: (c: string) => string;
  outlookCaveat: string;
  disclaimer: string;
  // live volume
  volTitleName: string;
  volTitleSub: string;
  volBuyLean: string;
  volSellLean: string;
  volCollecting: string;
  volVelocity: string;
  volVsAvg: string;
  volCvd: string;
  volBuyDom: string;
  volSellDom: string;
  volFlowCalls: string;
  volFlowPuts: string;
  volTypeSplit: (c: number, p: number) => string;
  volMagToward: (m: string, pts: string) => string;
  volMagAway: (m: string) => string;
  volMagMixed: string;
  volMagNeg: (m: string) => string;
  volSell: string;
  volBuy: string;
  volClosedNote: string;
  volClosedNoteFut: string;
  // Panel "contratos entrantes" (0DTE Live).
  ttTagName: string;
  ttTagSub: string;
  ttSub: string;
  ttNetLabel: string;
  ttBiasLabel: string;
  ttNewLabel: string;
  ttColTime: string;
  ttColContract: string;
  ttColSide: string;
  ttColVol: string;
  ttColPrem: string;
  ttColDist: string;
  ttBuyAsk: string;
  ttSellBid: string;
  ttMid: string;
  ttBull: string;
  ttBear: string;
  ttNew: string;
  ttEmpty: string;
  ttLegendCall: string;
  ttLegendPut: string;
  ttFootNote: string;
  ttSlPending: string;
  ttSlPendingShort: string;
  magnetShort: string;
  ttBiasBull: string;
  ttBiasBear: string;
  ttBiasMixed: string;
  ttBiasNone: string;
  ttCallsDom: string;
  ttPutsDom: string;
  ttSummary: (bull: string, bear: string, pile: string | null, magnet: string | null, sweeps: number) => string;
  ttRollHead: string;
  ttBlocks: (n: number) => string;
  ttFeedHead: string;
  ttOpen: string;
  ttClose: string;
  ttFootNote2: string;
  ttTakersOnly: string;
  ttImpact: string;
  ttNetShortPos: string;
  ttNetShortNeg: string;
  ttNetReadPos: (magnet: string | null) => string;
  ttNetReadNeg: string;
  ttDiscarded: (mid: number, close: number) => string;
  volMostSold: string;
  volMostBought: string;
  volLive: (total: string, min: string) => string;
  volDayOnly: (total: string) => string;
  // summary
  highestCall: string;
  highestPut: string;
  contracts: (n: string) => string;
  putCallRatio: string;
  putsCalls: (p: string, c: string) => string;
  // gex
  todayGamma: string;
  gexSub: (n: number, pct: string) => string;
  regime: string;
  gPositive: string;
  gNegative: string;
  regimePosSub: string;
  netGexLabel: string;
  netGexPos: string;
  netGexNeg: string;
  regimeNegSub: string;
  magnetLabel: string;
  magnetSub: string;
  flipZone: string;
  flipNullSub: string;
  flipSub: string;
  // closing
  closeTag: string;
  pinStrength: string;
  maxPain: string;
  provisional: string;
  minLeft: (n: string) => string;
  calcAt3: string;
  fixedSession: (d: string) => string;
  mostLikelyClose: string;
  likelyRange: string;
  ptsMargin: (s: string) => string;
  closeLockIn: (t: string) => string;
  closeOpenLbl: string;
  closeCloseLbl: string;
  closeHistory: (n: number, e: string) => string;
  closeHitRate: (r: string) => string;
  // GEX Unpin (/ES, /NQ)
  unpinName: string;
  unpinSub: (fut: string) => string;
  unpinArmed: string;
  unpinPop: string;
  unpinDrop: string;
  unpinTradeOn: (fut: string) => string;
  unpinSecondary: string;
  unpinTellAbove: string;
  unpinTellBelow: string;
  unpinSnapbackLbl: string;
  unpinSpotMagnetLbl: string;
  unpinFlowLbl: string;
  unpinToCloseLbl: string;
  unpinBull: string;
  unpinBear: string;
  unpinOrigin: (fut: string) => string;
  unpinPlaying: string;
  unpinSinceLbl: string;
  unpinWaitNote: string;
  unpinNoPin: string;
  closeCaveat: string;
  // forecast
  scenariosClose: string;
  autoAdjusted: (pct: string) => string;
  autoAdjustedTitle: string;
  fcMeta: (h: string, iv: string, sig: string, sigPct: string) => string;
  bullish: string;
  bearish: string;
  base: string;
  pctTouch: (p: string) => string;
  // chart
  chartHead: (idx: string) => string;
  chartSubFut: (fut: string, basis: string) => string;
  chartLegend: JSXLegend;
  // chain
  aggrNoteFuture: string;
  aggrNoteError: (e: string) => string;
  aggrNoteOk: (cycles: number, contracts: number) => string;
  aggrLoading: string;
  thAggressor: string;
  thVolume: string;
  thStrike: string;
  currentPrice: string;
  spotHint: string;
  chainFoot: JSXFoot;
  aggrBuy: string;
  aggrSell: string;
  aggrMid: string;
  aggrMixed: string;
  // model accuracy
  modelAccuracy: string;
  noSessions: string;
  sessionsEvaluated: (n: number) => string;
  evalWait: string;
  baseMeanError: string;
  bias: string;
  biasAboveSub: string;
  biasBelowSub: string;
  bullTouched: string;
  bearTouched: string;
  // aggressor caveat
  aggrCaveat: string;
  // strategy suggestions
  strategyHead: string;
  strategySub: string;
  strategyDisclaimer: string;
  strategyNone: string;
  strategyVertical: string;
  strategyVerticalBullCall: string;
  strategyVerticalBearPut: string;
  strategyDebit: string;
  strategyCreditCall: string;
  strategyIronCondor: string;
  strategyCredit: string;
  strategyBreakeven: string;
  strategyNoQuote: string;
  strategyBuy: string;
  strategySell: string;
  // errors
  unknownError: string;
}

// Los legos con marcado (colores) se guardan como texto plano; la página los
// pinta. Para no acoplar JSX aquí, se exponen como cadenas por segmento.
type JSXLegend = { violet: string; gray: string; orange: string; yellow: string; blue: string };
type JSXFoot = { intro: string; wall: string; magnet: string };

export const DICT: Record<Lang, Dict> = {
  en: {
    brand: "0DTE Agent",
    subToday: "Today's expiration",
    subFuture: "Future expiration",
    subStrikes: (n) => `· the ${n} highest-volume strikes (top 10 calls + top 10 puts)`,
    optES: "/ES (E-mini S&P 500 future)",
    optNQ: "/NQ (E-mini Nasdaq-100 future)",
    loading: "Loading…",
    refresh: "Refresh",
    langLabel: "Language",
    themeLabel: "Toggle light / dark",
    expiration: "Expiration",
    today: "Today",
    spot: "Spot",
    expires: "Expires",
    contractsInChain: (n) => `${n} contracts in the chain`,
    realtimeTitle: "Gamma/OI/volume from Tastytrade on the active strikes; the rest is Schwab (15 min)",
    realtimeStrikes: (n, age) => `⚡ ${n} strikes realtime${age}`,
    delayedChain: "Schwab chain (~15 min delay)",
    convertedTo: (fut) => `▶ converted to ${fut}`,
    analysisOn: "analysis on",
    liveBasis: "live basis",
    pts: "pts",
    aTo: "to",
    basisNote: (fut, idx) =>
      `Everything is shown in ${fut} —spot, magnet, flip, scenarios, close, best trade, the options chain and the chart— by adding the basis at the 0.25 tick. The analysis runs on ${idx} (its real options source) and is shifted by the basis, which is recomputed on every load.`,
    ndxWarn: "⚠ NDX 0DTE is illiquid: flow/aggressor may be scarce; use the levels with caution.",
    futureNote: (exp) =>
      `Future chain view (expires ${exp}). The volume ranking and GEX for that expiration are shown. The 5-min outlook, the scenarios into the close and the aggressor only apply to today's 0DTE.`,
    bestTradeNow: "GEX Trade",
    bestTradeSub: "— back to the magnet",
    ticketName: "GEX Ticket",
    ticketSub: "— suggested contract",
    ticketBuy: "BUY",
    ticketMid: "mid",
    ticketTarget: "Target",
    ticketRB: "R:B (option)",
    ticketIndexAt: "index",
    ticketRBvsIndex: (rr) => `gamma lifts the ${rr} index R:B`,
    ticketCost: "cost",
    ticketRisk: "risk",
    ticketThesis: (dir, tgt, stop) => `Thesis: ${dir} to the magnet ${tgt} · stop ${stop} (from the GEX Trade)`,
    ticketThesisMom: (dir, tgt, stop) => `Thesis: ${dir} momentum to the wall ${tgt} · stop ${stop} (γ− alternate GEX Trade)`,
    ticketFlow: (n) => `✓ ${n} sweep${n === 1 ? "" : "s"} buying this contract today`,
    ticketTheta: "⏱ Theta: 0DTE decay eats the target if the move is slow — hit it in the window or exit. Mechanical estimate from positioning, not advice.",
    ticketNone: "No contract passes the filters (delta 0.40–0.60, spread ≤8%, vol/OI, risk).",
    ticketWait: "Waiting for a ready setup from the GEX Trade.",
    ticketClosed: "Market closed — no live contract to suggest.",
    despinTitle: "If it breaks the pin",
    despinUp: "BULLISH",
    despinDown: "BEARISH",
    despinTarget: "estimated target",
    despinMove: (pts, up, anchored) => anchored
      ? `${up ? "+" : "−"}${pts} pts to the gamma wall`
      : `${up ? "+" : "−"}1σ (~${pts} pts) from spot`,
    despinWall: (w) => `next wall ${w}`,
    despinAnchor: "· wall",
    despinNote: "Only if price breaks the pin with the flow behind it. Direction from the aggressive flow; target is the gamma wall in reach, or a σ-measured move if none. Not a guaranteed target.",
    despinWeak: "Strong pin (γ+): breakout unlikely.",
    pinAltName: "GEX Pinning · Charm",
    pinAltAlt: "ALT",
    charmClose: "Charm into close",
    charmBuy: "▲ buying",
    charmSell: "▼ selling",
    charmFlat: "= flat",
    charmInt: (p) => `intensity ${p}%`,
    charmNotePos: (down) => down
      ? "OTM calls losing delta → dealers sell → bearish lean building into 4pm. Directional only (magnitude not calibrated)."
      : "OTM puts losing delta → dealers buy back → bullish lean building into 4pm. Directional only (magnitude not calibrated).",
    pinAltDirClose: "Est. close · directional",
    pinAltConv: (a, t) => `conviction ${a}/${t}`,
    sigFlow: "flow",
    sigFlip: (k) => `vs flip ${k}`,
    sigCharm: "charm",
    pinAltNegNote: (tgt, pts, anchored) => `No pin (γ−): close predicted by DIRECTION → ${anchored ? `gamma wall ${tgt}` : `~${pts} pts (σ)`}. A breakout can extend it further.`,
    pinAltNoDir: "Flow has no clear direction — no directional close.",
    mocLabel: "MOC · closing imbalance",
    mocHint: "paste from 3:50pm tweet",
    mocPlaceholder: "e.g. 1288.8",
    mocBuy: "BUY",
    mocSell: "SELL",
    mocTierMod: "moderate · <$1.5B",
    mocTierStrong: "strong · ≥$1.5B",
    mocAbsorbed: (x) => `MOC ${x} — usually absorbed against the walls in γ+.`,
    mocConfirms: (x) => `MOC ${x} confirms the direction (last 10 min).`,
    mocConflict: (x) => `⚠ MOC ${x} is AGAINST this direction — lowers conviction.`,
    setupChanged: "⚡ setup changed",
    liveClock: (clock) => `live · ${clock} ET`,
    marketClosed: "market closed",
    offSession: "Off session (9:30-16:00 ET). While the market is open, the agent looks for the best trade live and updates it every minute.",
    offSessionFut: "Futures session break (daily maintenance 17:00-18:00 ET, and weekends Fri 17:00 → Sun 18:00 ET). Otherwise the agent runs on live native futures flow ~23h a day.",
    long: "▲ LONG",
    short: "▼ SHORT",
    entryNow: "Entry (now)",
    targetMagnet: "Target (magnet)",
    stop: "Stop",
    riskReward: "Risk / Reward",
    noSetupPrefix: "No setup now — ",
    waitLabel: "WAITING",
    waitPrefix: "Wait — ",
    wouldBe: (dir) => `would be ${dir}`,
    noPinLabel: "NO PIN",
    distance: "Distance",
    toActivate: "To activate",
    priceNow: "Price",
    wouldBeLbl: "Would be",
    liveCaveat: "Recomputed every minute with the live GEX. The agent computes and shows; you decide and execute. Not an order or advice.",
    altSuffix: "· alternate",
    flowTag: "FLOW",
    momentumTag: "MOMENTUM · γ−",
    standAside: "STAND ASIDE",
    targetWall: "Target (next wall)",
    altRevWarn: "⚠ possible reversal",
    altTierStrong: "● GREEN · strong",
    altTierSoft: "◐ SOFT · drift",
    altTierStrongNote: "flow (CVD + bursts) confirms the direction",
    altTierSoftNote: "quiet flow — pin gravity, low conviction (slower)",
    altRevNote: "flow is starting to turn against — caution / consider exiting",
    momentumBuilding: (n, required) => `γ− momentum building: ${n}/${required} confirming reads — not a trade yet, avoids acting on a 1-minute flicker.`,
    altCmpTitle: "Alternate vs original · next 5 min (today)",
    altCmpLine: (o, a, n) => `Directional hit — original ${o}% · alternate ${a}% · over ${n} calls`,
    altCmpDiff: (d, w) => `The alternate differed ${d}× (flow moved the read); it won ${w} of those.`,
    altCmpWait: "Collecting… each call is graded 5 min later. Keep the page open during the session.",
    tradeCmpTitle: "GEX Trade alt vs original · today",
    tradeCmpLine: (o, a, n) => `Win rate — original ${o}% · alternate ${a}% · over ${n} trade${n === 1 ? "" : "s"}`,
    tradeCmpDiff: (d, w) => `The alternate took ${d} γ− momentum trade${d === 1 ? "" : "s"} the original passed; it won ${w}.`,
    tradeCmpWait: "Measuring live — fills in as trades hit their target or stop.",
    nextMin: (h) => `— next ${h} min`,
    gexBiasName: "GEX Bias",
    biasBull: "▲ bullish bias",
    biasBear: "▼ bearish bias",
    biasSide: "▬ sideways",
    confidence: (c) => `confidence ${c}`,
    outlookCaveat: "Probabilistic estimate from options positioning — the range is ~68% (±1σ). Not a certainty or investment advice.",
    disclaimer: "Reminder: this is informational only, NOT investment advice.",
    volTitleName: "Live volume",
    volTitleSub: "· velocity + CVD",
    volBuyLean: "▲ buy pressure",
    volSellLean: "▼ sell pressure",
    volCollecting: "Collecting… the live series builds over the next few minutes (one sample per refresh). Keep the page open.",
    volVelocity: "Volume velocity",
    volVsAvg: "last minute vs the window average",
    volCvd: "Net aggressor (CVD)",
    volBuyDom: "buying dominates",
    volSellDom: "selling dominates",
    volFlowCalls: "Aggression in CALLS",
    volFlowPuts: "Aggression in PUTS",
    volTypeSplit: (c, p) => `calls ${c}% · puts ${p}%`,
    volMagToward: (m, pts) => `Pushing toward magnet ${m} · ${pts} pts away.`,
    volMagAway: (m) => `Moving away from magnet ${m}.`,
    volMagMixed: "No clear flow direction.",
    volMagNeg: (m) => `γ−: no reliable pin; magnet ${m} for reference only.`,
    volSell: "sell",
    volBuy: "buy",
    volClosedNote: "Out of session — no live flow (index options only trade 9:30-16:00 ET). Showing the net aggressor from the last close.",
    volClosedNoteFut: "Futures maintenance/weekend break — flow paused. Showing the net aggressor accumulated from the last active session.",
    ttTagName: "0DTE Live",
    ttTagSub: "· top 10 incoming",
    ttSub: "|Δ| .45–.80 · vol >500 · premium >$500K · single-leg · expiring today. New ones enter at top; 10 are kept.",
    ttNetLabel: "Net premium (10)",
    ttBiasLabel: "Tape bias (10)",
    ttNewLabel: "New this cycle",
    ttColTime: "Time",
    ttColContract: "Contract",
    ttColSide: "Side",
    ttColVol: "Vol",
    ttColPrem: "Premium",
    ttColDist: "Dist. spot",
    ttBuyAsk: "buy ask",
    ttSellBid: "sell bid",
    ttMid: "mid",
    ttBull: "bullish",
    ttBear: "bearish",
    ttNew: "new",
    ttEmpty: "Waiting for blocks that meet the filters…",
    ttLegendCall: "green = call",
    ttLegendPut: "red = put",
    ttFootNote: "the gold bar marks what came in this cycle",
    ttSlPending: "The single-leg field (spreadLeg) isn't populated on this feed yet, so multileg trades may be included. Pending live verification.",
    ttSlPendingShort: "single-leg unverified",
    magnetShort: "magnet",
    ttBiasBull: "Bullish bias",
    ttBiasBear: "Bearish bias",
    ttBiasMixed: "Mixed / no edge",
    ttBiasNone: "No signal yet",
    ttCallsDom: "calls dominate",
    ttPutsDom: "puts dominate",
    ttSummary: (bull, bear, pile, magnet, sweeps) =>
      `${bull} aggressive bullish vs ${bear} bearish.${pile ? ` Takers hitting ${pile}` : ""}${magnet ? `, pushing toward the ${magnet} magnet` : ""}.${sweeps ? ` ${sweeps} sweep${sweeps === 1 ? "" : "s"} (⚡).` : ""}`,
    ttRollHead: "Where it hits · impact (premium × gamma)",
    ttBlocks: (n) => `${n} blk`,
    ttFeedHead: "The tape · takers only",
    ttOpen: "opening (volume > OI): new positioning",
    ttClose: "closing / covered (volume ≤ OI)",
    ttFootNote2: "⚡ sweep (pinned to top) · impact = premium × gamma (0–100) · only ▲ buy ask / ▼ sell bid · delta 0.30–0.65 · mid and closing discarded",
    ttTakersOnly: "takers only",
    ttImpact: "impact",
    ttNetShortPos: "positive · stabilizes",
    ttNetShortNeg: "negative · amplifies",
    ttNetReadPos: (magnet) => `Dealers long gamma: price is magnetized${magnet ? ` to ${magnet}` : ""}. Aggressive flow fights the pin.`,
    ttNetReadNeg: "Dealers short gamma: no pin, aggressive flow runs unchecked.",
    ttDiscarded: (mid, close) => `Discarded: ${mid} mid block${mid === 1 ? "" : "s"}${close ? ` and ${close} closing` : ""} — big but passive, they don't move price.`,
    volMostSold: "Most sold",
    volMostBought: "Most bought",
    volLive: (total, min) => `${total} contracts today · +${min} last min`,
    volDayOnly: (total) => `${total} contracts today`,
    highestCall: "Highest-volume call",
    highestPut: "Highest-volume put",
    contracts: (n) => `${n} contracts`,
    putCallRatio: "Put / Call ratio",
    putsCalls: (p, c) => `${p} puts · ${c} calls`,
    todayGamma: "Today's gamma (GEX)",
    gexSub: (n, pct) => `${n} strikes · real gamma on ${pct}% of contracts`,
    regime: "Regime",
    gPositive: "GEX positive",
    gNegative: "GEX negative",
    regimePosSub: "dealers trade AGAINST the move → price tends to revert to the magnet",
    netGexLabel: "Net GEX ($ per 1% move)",
    netGexPos: "positive → dealers stabilize (mean-reverting)",
    netGexNeg: "negative → dealers amplify (trending)",
    regimeNegSub: "dealers trade WITH it → moves amplify",
    magnetLabel: "Magnet (highest gamma)",
    magnetSub: "strike that anchors price the most",
    flipZone: "Flip zone",
    flipNullSub: "the GEX doesn't change sign in the window",
    flipSub: "crossing it flips the regime",
    closeTag: "GEX Pinning",
    pinStrength: "Net GEX · pin strength",
    maxPain: "Max Pain · OI",
    provisional: "provisional",
    minLeft: (n) => `${n} min left`,
    calcAt3: "calculated at 3:00pm ET",
    fixedSession: (d) => `fixed · session ${d}`,
    mostLikelyClose: "Most likely closing strike",
    likelyRange: "Likely range",
    ptsMargin: (s) => `±${s} pts margin`,
    closeLockIn: (t) => `${t} to 3:00pm ET — then the forecast locks in`,
    closeOpenLbl: "9:30 open",
    closeCloseLbl: "4:00 close",
    closeHistory: (n, e) => `History: over ${n} close${n === 1 ? "" : "s"} measured, mean error ${e} pts`,
    closeHitRate: (r) => ` · hit rate (±5 pts) ${r}%`,
    unpinName: "GEX Unpin",
    unpinSub: (fut) => `· ${fut} 4:00–5:00pm`,
    unpinArmed: "ARMED",
    unpinPop: "likely POP",
    unpinDrop: "likely DROP",
    unpinTradeOn: (fut) => `trade: ${fut}`,
    unpinSecondary: "2nd · weaker pin",
    unpinTellAbove: "pin defended from above — suppressed buying",
    unpinTellBelow: "pin defended from below — suppressed selling",
    unpinSnapbackLbl: "Snapback",
    unpinSpotMagnetLbl: "Spot vs magnet",
    unpinFlowLbl: "Flow at close",
    unpinToCloseLbl: "To close",
    unpinBull: "↑ bullish",
    unpinBear: "↓ bearish",
    unpinOrigin: (fut) => `${fut === "/NQ" ? "NDX/NQ" : "SPX"} 0DTE pin releases at 4pm. Not guaranteed; post-4pm headlines override.`,
    unpinPlaying: "playing out",
    unpinSinceLbl: "since 4pm pin",
    unpinWaitNote: "arms at 3:00pm ET · plays out 4:00–5:00pm",
    unpinNoPin: "negative gamma — no pin forming, no unpin expected",
    closeCaveat: "Estimate of the dealers' anchoring effect, not a certainty. News or a regime change can break it. You decide.",
    scenariosClose: "Scenarios into the close",
    autoAdjusted: (pct) => `🧠 auto-adjusted ${pct}%`,
    autoAdjustedTitle: "The base target is corrected by the historical bias measured in 'Model accuracy'",
    fcMeta: (h, iv, sig, sigPct) => `${h} h left · IV ${iv}% · 1σ = ±${sig} pts (${sigPct}%)`,
    bullish: "Bullish",
    bearish: "Bearish",
    base: "Base",
    pctTouch: (p) => `${p}% chance to touch`,
    chartHead: (idx) => `${idx} chart with agent levels`,
    chartSubFut: (fut, basis) => ` · converted to ${fut} (basis ${basis})`,
    chartLegend: { violet: "highest-volume strike (call/put)", gray: "GEX magnet", orange: "gamma flip (anchor ↔ acceleration)", yellow: "close target", blue: "current price" },
    aggrNoteFuture: "Aggressor only available in today's 0DTE",
    aggrNoteError: (e) => `Aggressor unavailable: ${e}`,
    aggrNoteOk: (cycles, contracts) => `Aggressor accumulated over ${cycles} cycle${cycles === 1 ? "" : "s"} · ${contracts} contracts sampled`,
    aggrLoading: "Loading aggressor…",
    thAggressor: "Aggressor",
    thVolume: "Volume",
    thStrike: "Strike",
    currentPrice: "Current price",
    spotHint: "falls between strikes — not a contract, so no volume or OI",
    chainFoot: { intro: "Auto-updates every minute. Shaded background = ITM contract. The bar under the volume is relative to the table's max.", wall: "Yellow row = highest-volume wall (MAX CALL/PUT);", magnet: "🧲 gray = GEX magnet." },
    aggrBuy: "BUY",
    aggrSell: "SELL",
    aggrMid: "MID",
    aggrMixed: "mixed",
    modelAccuracy: "Model accuracy",
    noSessions: "no closed sessions to measure yet",
    sessionsEvaluated: (n) => `${n} session${n === 1 ? "" : "s"} evaluated`,
    evalWait: "The model saves today's forecast and checks it against the real close. The first measurement shows up tomorrow; reliability grows with the days.",
    baseMeanError: "Base mean error",
    bias: "Bias",
    biasAboveSub: "price closes above the base",
    biasBelowSub: "below the base",
    bullTouched: "Bull touched",
    bearTouched: "Bear touched",
    aggrCaveat: "Volume says WHERE the activity is; the aggressor says which side. SELLING calls is resistance and SELLING puts is support; BUYING is directional. The small number is how many trades back the percentage — distrust the ones with few. The aggressor accumulates since the agent started, so it gains reliability as the session goes on.",
    strategyHead: "Strategy suggestions",
    strategySub: "Defined-risk alternatives built on the same GEX/walls the agent already computes above.",
    strategyDisclaimer: "The agent computes and shows; you decide and execute. Not an order or advice.",
    strategyNone: "No strategy setup right now — no directional entry and/or no clean wall to sell against.",
    strategyVertical: "Vertical (debit)",
    strategyVerticalBullCall: "Bull Call",
    strategyVerticalBearPut: "Bear Put",
    strategyDebit: "Debit",
    strategyCreditCall: "Credit Call",
    strategyIronCondor: "Iron Condor",
    strategyCredit: "Credit",
    strategyBreakeven: "Breakeven range",
    strategyNoQuote: "no real quote for this leg right now",
    strategyBuy: "Buy",
    strategySell: "Sell",
    unknownError: "Unknown error",
  },
  es: {
    brand: "Agente 0DTE",
    subToday: "Vencimiento de hoy",
    subFuture: "Vencimiento futuro",
    subStrikes: (n) => `· los ${n} strikes de mayor volumen (top 10 de calls + top 10 de puts)`,
    optES: "/ES (futuro E-mini S&P 500)",
    optNQ: "/NQ (futuro E-mini Nasdaq-100)",
    loading: "Cargando…",
    refresh: "Actualizar",
    langLabel: "Idioma",
    themeLabel: "Alternar claro / oscuro",
    expiration: "Vencimiento",
    today: "Hoy",
    spot: "Spot",
    expires: "Vence",
    contractsInChain: (n) => `${n} contratos en la cadena`,
    realtimeTitle: "Gamma/OI/volumen de Tastytrade sobre los strikes activos; el resto es Schwab (15 min)",
    realtimeStrikes: (n, age) => `⚡ ${n} strikes en tiempo real${age}`,
    delayedChain: "cadena Schwab (retraso ~15 min)",
    convertedTo: (fut) => `▶ convertido a ${fut}`,
    analysisOn: "análisis sobre",
    liveBasis: "basis en vivo",
    pts: "pts",
    aTo: "a",
    basisNote: (fut, idx) =>
      `Todo se muestra en ${fut} —spot, imán, flip, escenarios, cierre, el mejor trade, la cadena de opciones y la gráfica— sumando el basis al tick de 0.25. El análisis se calcula sobre ${idx} (su fuente real de opciones) y se desplaza por el basis, que se recalcula en cada carga.`,
    ndxWarn: "⚠ El 0DTE de NDX es poco líquido: el flujo/agresor puede ser escaso; usa los niveles con cautela.",
    futureNote: (exp) =>
      `Vista de cadena a futuro (vence ${exp}). Se muestran el ranking por volumen y el GEX de ese vencimiento. El panorama de 5 min, los escenarios hasta el cierre y el agresor solo aplican al 0DTE de hoy.`,
    bestTradeNow: "GEX Trade",
    bestTradeSub: "— de vuelta al imán",
    ticketName: "GEX Ticket",
    ticketSub: "— contrato sugerido",
    ticketBuy: "COMPRAR",
    ticketMid: "mid",
    ticketTarget: "Target",
    ticketRB: "R:B (opción)",
    ticketIndexAt: "índice",
    ticketRBvsIndex: (rr) => `la gamma mejora el ${rr} del índice`,
    ticketCost: "costo",
    ticketRisk: "riesgo",
    ticketThesis: (dir, tgt, stop) => `Tesis: ${dir} al imán ${tgt} · stop ${stop} (del GEX Trade)`,
    ticketThesisMom: (dir, tgt, stop) => `Tesis: ${dir} momentum al muro ${tgt} · stop ${stop} (GEX Trade alterno γ−)`,
    ticketFlow: (n) => `✓ ${n} sweep${n === 1 ? "" : "s"} comprando este contrato hoy`,
    ticketTheta: "⏱ Theta: el decay 0DTE se come el target si el movimiento es lento — tócalo en la ventana o sal. Estimación mecánica del posicionamiento, no consejo.",
    ticketNone: "Ningún contrato pasa los filtros (delta 0.40–0.60, spread ≤8%, vol/OI, riesgo).",
    ticketWait: "Esperando un setup listo del GEX Trade.",
    ticketClosed: "Mercado cerrado — sin contrato en vivo que sugerir.",
    despinTitle: "Si se despina (rompe el pin)",
    despinUp: "ALCISTA",
    despinDown: "BAJISTA",
    despinTarget: "objetivo estimado",
    despinMove: (pts, up, anchored) => anchored
      ? `${up ? "+" : "−"}${pts} pts al muro de gamma`
      : `${up ? "+" : "−"}1σ (~${pts} pts) desde el spot`,
    despinWall: (w) => `próximo muro ${w}`,
    despinAnchor: "· muro",
    despinNote: "Solo si el precio rompe el pin con el flujo detrás. Dirección del flujo agresivo; el objetivo es el muro de gamma si está a alcance, o un movimiento de σ si no. No es un objetivo garantizado.",
    despinWeak: "Pin fuerte (γ+): despin poco probable.",
    pinAltName: "GEX Pinning · Charm",
    pinAltAlt: "ALT",
    charmClose: "Charm al cierre",
    charmBuy: "▲ comprador",
    charmSell: "▼ vendedor",
    charmFlat: "= neutral",
    charmInt: (p) => `intensidad ${p}%`,
    charmNotePos: (down) => down
      ? "Calls OTM perdiendo delta → dealers venden → sesgo vendedor que sube hacia las 4pm. Solo dirección (magnitud sin calibrar)."
      : "Puts OTM perdiendo delta → dealers recompran → sesgo comprador que sube hacia las 4pm. Solo dirección (magnitud sin calibrar).",
    pinAltDirClose: "Cierre est. · direccional",
    pinAltConv: (a, t) => `convicción ${a}/${t}`,
    sigFlow: "flujo",
    sigFlip: (k) => `vs flip ${k}`,
    sigCharm: "charm",
    pinAltNegNote: (tgt, pts, anchored) => `Sin pin (γ−): el cierre se predice por DIRECCIÓN → ${anchored ? `muro de gamma ${tgt}` : `~${pts} pts (σ)`}. Un rompimiento puede extenderlo más.`,
    pinAltNoDir: "Flujo sin dirección clara — sin cierre direccional.",
    mocLabel: "MOC · imbalance de cierre",
    mocHint: "pega del tweet 3:50pm",
    mocPlaceholder: "ej. 1288.8",
    mocBuy: "BUY",
    mocSell: "SELL",
    mocTierMod: "moderado · <$1.5B",
    mocTierStrong: "fuerte · ≥$1.5B",
    mocAbsorbed: (x) => `MOC ${x} — en γ+ suele absorberse contra los walls.`,
    mocConfirms: (x) => `MOC ${x} confirma la dirección (últimos 10 min).`,
    mocConflict: (x) => `⚠ MOC ${x} va EN CONTRA — baja la convicción.`,
    setupChanged: "⚡ el setup cambió",
    liveClock: (clock) => `en vivo · ${clock} ET`,
    marketClosed: "mercado cerrado",
    offSession: "Fuera de sesión (9:30-16:00 ET). Durante el mercado abierto, el agente busca el mejor trade en vivo y lo actualiza cada minuto.",
    offSessionFut: "Corte de la sesión de futuros (mantenimiento diario 17:00-18:00 ET, y fin de semana vie 17:00 → dom 18:00 ET). El resto del tiempo el agente corre con el flujo nativo de futuros en vivo ~23h al día.",
    long: "▲ LONG",
    short: "▼ SHORT",
    entryNow: "Entrada (ahora)",
    targetMagnet: "Objetivo (imán)",
    stop: "Stop",
    riskReward: "Riesgo / Beneficio",
    noSetupPrefix: "Sin setup ahora — ",
    waitLabel: "ESPERANDO",
    waitPrefix: "Esperar — ",
    wouldBe: (dir) => `sería ${dir}`,
    noPinLabel: "SIN PIN",
    distance: "Distancia",
    toActivate: "Para activar",
    priceNow: "Precio",
    wouldBeLbl: "Sería",
    liveCaveat: "Se recalcula cada minuto con el GEX en vivo. El agente calcula y muestra; tú decides y ejecutas. No es una orden ni un consejo.",
    altSuffix: "· alterna",
    flowTag: "FLOW",
    momentumTag: "MOMENTUM · γ−",
    standAside: "AL MARGEN",
    targetWall: "Objetivo (muro)",
    altRevWarn: "⚠ posible reversión",
    altTierStrong: "● LUZ VERDE · fuerte",
    altTierSoft: "◐ SUAVE · drift",
    altTierStrongNote: "el flujo (CVD + bursts) confirma la dirección",
    altTierSoftNote: "flujo callado — gravedad del pin, baja convicción (más lento)",
    altRevNote: "el flujo empieza a girar en contra — cuidado / considera salir",
    momentumBuilding: (n, required) => `Momentum γ− confirmando: ${n}/${required} lecturas seguidas — todavía no es un trade, evita operar un parpadeo de 1 minuto.`,
    altCmpTitle: "Alterna vs original · next 5 min (hoy)",
    altCmpLine: (o, a, n) => `Acierto direccional — original ${o}% · alterna ${a}% · sobre ${n} llamadas`,
    altCmpDiff: (d, w) => `La alterna difirió ${d}× (el flujo cambió la lectura); ganó ${w} de esas.`,
    altCmpWait: "Recopilando… cada llamada se evalúa 5 min después. Mantén la página abierta en la sesión.",
    tradeCmpTitle: "GEX Trade alt vs original · hoy",
    tradeCmpLine: (o, a, n) => `Aciertos — original ${o}% · alterna ${a}% · sobre ${n} trade${n === 1 ? "" : "s"}`,
    tradeCmpDiff: (d, w) => `La alterna tomó ${d} trade${d === 1 ? "" : "s"} de momentum γ− que la original dejó pasar; ganó ${w}.`,
    tradeCmpWait: "Midiendo en vivo — se llena cuando los trades tocan su target o stop.",
    nextMin: (h) => `— próx. ${h} min`,
    gexBiasName: "Sesgo GEX",
    biasBull: "▲ sesgo alcista",
    biasBear: "▼ sesgo bajista",
    biasSide: "▬ lateral",
    confidence: (c) => `confianza ${c}`,
    outlookCaveat: "Estimación probabilística a partir del posicionamiento de opciones — el rango es ~68% (±1σ). No es una certeza ni un consejo de inversión.",
    disclaimer: "Recordatorio: esto es solo informativo, NO es consejo de inversión.",
    volTitleName: "Volumen en vivo",
    volTitleSub: "· velocidad + CVD",
    volBuyLean: "▲ presión de compra",
    volSellLean: "▼ presión de venta",
    volCollecting: "Recopilando… la serie se arma en los próximos minutos (una muestra por refresco). Deja la página abierta.",
    volVelocity: "Velocidad de volumen",
    volVsAvg: "el último minuto vs el promedio de la ventana",
    volCvd: "Agresor neto (CVD)",
    volBuyDom: "compra domina",
    volSellDom: "venta domina",
    volFlowCalls: "Agresión en CALLS",
    volFlowPuts: "Agresión en PUTS",
    volTypeSplit: (c, p) => `calls ${c}% · puts ${p}%`,
    volMagToward: (m, pts) => `Empuja hacia el imán ${m} · faltan ${pts} pts.`,
    volMagAway: (m) => `Se aleja del imán ${m}.`,
    volMagMixed: "Sin dirección clara del flujo.",
    volMagNeg: (m) => `γ−: sin pin fiable; imán ${m} solo de referencia.`,
    volSell: "venta",
    volBuy: "compra",
    volClosedNote: "Fuera de sesión — sin flujo en vivo (las opciones de índice solo operan 9:30-16:00 ET). Muestra el agresor neto del último cierre.",
    volClosedNoteFut: "Corte de mantenimiento/fin de semana de futuros — flujo en pausa. Muestra el agresor neto acumulado de la última sesión activa.",
    ttTagName: "0DTE Live",
    ttTagSub: "· top 10 entrantes",
    ttSub: "|Δ| .45–.80 · vol >500 · premium >$500K · single-leg · vencen hoy. Los nuevos entran arriba; se mantienen 10.",
    ttNetLabel: "Premium neto (10)",
    ttBiasLabel: "Sesgo del tape (10)",
    ttNewLabel: "Nuevos este ciclo",
    ttColTime: "Hora",
    ttColContract: "Contrato",
    ttColSide: "Lado",
    ttColVol: "Vol",
    ttColPrem: "Premium",
    ttColDist: "Dist. spot",
    ttBuyAsk: "compra ask",
    ttSellBid: "venta bid",
    ttMid: "mid",
    ttBull: "alcista",
    ttBear: "bajista",
    ttNew: "nuevo",
    ttEmpty: "Esperando bloques que cumplan los filtros…",
    ttLegendCall: "verde = call",
    ttLegendPut: "rojo = put",
    ttFootNote: "la barra dorada marca lo entrado en este ciclo",
    ttSlPending: "El campo single-leg (spreadLeg) aún no viene poblado en este feed, así que pueden colarse trades multileg. Pendiente de verificar en vivo.",
    ttSlPendingShort: "single-leg sin verificar",
    magnetShort: "imán",
    ttBiasBull: "Sesgo alcista",
    ttBiasBear: "Sesgo bajista",
    ttBiasMixed: "Mixto / sin ventaja",
    ttBiasNone: "Sin señal aún",
    ttCallsDom: "calls dominan",
    ttPutsDom: "puts dominan",
    ttSummary: (bull, bear, pile, magnet, sweeps) =>
      `${bull} agresivo alcista vs ${bear} bajista.${pile ? ` Los takers pegan en ${pile}` : ""}${magnet ? `, empujando al imán ${magnet}` : ""}.${sweeps ? ` ${sweeps} sweep${sweeps === 1 ? "" : "s"} (⚡).` : ""}`,
    ttRollHead: "Dónde pega · impacto (premium × gamma)",
    ttBlocks: (n) => `${n} bloq`,
    ttFeedHead: "El tape · solo takers",
    ttOpen: "apertura (volumen > OI): posicionamiento nuevo",
    ttClose: "cierre / cubierto (volumen ≤ OI)",
    ttFootNote2: "⚡ sweep (sube al tope) · impacto = premium × gamma (0–100) · solo ▲ compra ask / ▼ vende bid · delta 0.30–0.65 · mid y cierres se descartan",
    ttTakersOnly: "solo takers",
    ttImpact: "impacto",
    ttNetShortPos: "positivo · estabiliza",
    ttNetShortNeg: "negativo · amplifica",
    ttNetReadPos: (magnet) => `Dealers largos gamma: el precio se imanta${magnet ? ` a ${magnet}` : ""}. El flujo agresivo pelea contra el pin.`,
    ttNetReadNeg: "Dealers cortos gamma: sin pin, el flujo agresivo corre sin freno.",
    ttDiscarded: (mid, close) => `Descartado: ${mid} bloque${mid === 1 ? "" : "s"} al mid${close ? ` y ${close} de cierre` : ""} — grandes pero pasivos, no mueven el precio.`,
    volMostSold: "Más vendido",
    volMostBought: "Más comprado",
    volLive: (total, min) => `${total} contratos hoy · +${min} último min`,
    volDayOnly: (total) => `${total} contratos hoy`,
    highestCall: "Call de mayor volumen",
    highestPut: "Put de mayor volumen",
    contracts: (n) => `${n} contratos`,
    putCallRatio: "Ratio Put / Call",
    putsCalls: (p, c) => `${p} puts · ${c} calls`,
    todayGamma: "Gamma del día (GEX)",
    gexSub: (n, pct) => `${n} strikes · gamma real en ${pct}% de los contratos`,
    regime: "Régimen",
    gPositive: "GEX positivo",
    gNegative: "GEX negativo",
    regimePosSub: "los dealers operan CONTRA el movimiento → el precio tiende a revertir hacia el imán",
    netGexPos: "positivo → los dealers estabilizan (reversión a la media)",
    netGexNeg: "negativo → los dealers amplifican (tendencia)",
    netGexLabel: "Net GEX ($ por 1% de movimiento)",
    regimeNegSub: "los dealers operan A FAVOR → los movimientos se amplifican",
    magnetLabel: "Imán (mayor gamma)",
    magnetSub: "strike que más ancla al precio",
    flipZone: "Zona de inversión",
    flipNullSub: "el GEX no cambia de signo en la ventana",
    flipSub: "cruzarlo cambia el régimen",
    closeTag: "GEX Pinning",
    pinStrength: "Net GEX · fuerza del pin",
    maxPain: "Max Pain · OI",
    provisional: "provisional",
    minLeft: (n) => `faltan ${n} min`,
    calcAt3: "se calcula a las 3:00pm ET",
    fixedSession: (d) => `fijado · sesión ${d}`,
    mostLikelyClose: "Strike de cierre más probable",
    likelyRange: "Rango probable",
    ptsMargin: (s) => `±${s} pts de margen`,
    closeLockIn: (t) => `${t} para las 3:00pm ET — ahí se fija el pronóstico`,
    closeOpenLbl: "9:30 apertura",
    closeCloseLbl: "4:00 cierre",
    closeHistory: (n, e) => `Historial: en ${n} cierre${n === 1 ? "" : "s"} medido${n === 1 ? "" : "s"}, error medio ${e} pts`,
    closeHitRate: (r) => ` · acierto (±5 pts) ${r}%`,
    unpinName: "GEX Unpin",
    unpinSub: (fut) => `· ${fut} 4:00–5:00pm`,
    unpinArmed: "ARMADA",
    unpinPop: "probable POP",
    unpinDrop: "probable DROP",
    unpinTradeOn: (fut) => `opera: ${fut}`,
    unpinSecondary: "2ª · pin más débil",
    unpinTellAbove: "pin defendido desde arriba — compra reprimida",
    unpinTellBelow: "pin defendido desde abajo — venta reprimida",
    unpinSnapbackLbl: "Snapback",
    unpinSpotMagnetLbl: "Spot vs imán",
    unpinFlowLbl: "Flujo al cierre",
    unpinToCloseLbl: "A cierre",
    unpinBull: "↑ alcista",
    unpinBear: "↓ bajista",
    unpinOrigin: (fut) => `El pin 0DTE del ${fut === "/NQ" ? "NDX/NQ" : "SPX"} se suelta a las 4pm. No garantizado; headlines post-4pm anulan.`,
    unpinPlaying: "jugándose",
    unpinSinceLbl: "desde el pin de 4pm",
    unpinWaitNote: "se arma a las 3:00pm ET · se juega 4:00–5:00pm",
    unpinNoPin: "gamma negativa — sin pin, no se espera unpin",
    closeCaveat: "Estimación del efecto de anclaje de los dealers, no certeza. Una noticia o un cambio de régimen puede romperlo. Tú decides.",
    scenariosClose: "Escenarios hasta el cierre",
    autoAdjusted: (pct) => `🧠 auto-ajustado ${pct}%`,
    autoAdjustedTitle: "El objetivo base se corrige según el sesgo histórico medido en 'Precisión del modelo'",
    fcMeta: (h, iv, sig, sigPct) => `${h} h restantes · IV ${iv}% · 1σ = ±${sig} pts (${sigPct}%)`,
    bullish: "Alcista",
    bearish: "Bajista",
    base: "Base",
    pctTouch: (p) => `${p}% de tocarlo`,
    chartHead: (idx) => `Gráfica de ${idx} con niveles del agente`,
    chartSubFut: (fut, basis) => ` · convertida a ${fut} (basis ${basis})`,
    chartLegend: { violet: "strike de mayor volumen (call/put)", gray: "imán del GEX", orange: "flip gamma (anclaje ↔ aceleración)", yellow: "target de cierre", blue: "precio actual" },
    aggrNoteFuture: "Agresor solo disponible en el 0DTE de hoy",
    aggrNoteError: (e) => `Agresor no disponible: ${e}`,
    aggrNoteOk: (cycles, contracts) => `Agresor acumulado en ${cycles} ciclo${cycles === 1 ? "" : "s"} · ${contracts} contratos con muestra`,
    aggrLoading: "Cargando agresor…",
    thAggressor: "Agresor",
    thVolume: "Volumen",
    thStrike: "Strike",
    currentPrice: "Precio actual",
    spotHint: "cae entre strikes — no es un contrato, por eso no tiene volumen ni OI",
    chainFoot: { intro: "Se actualiza sola cada minuto. Fondo sombreado = contrato ITM. La barra bajo el volumen es relativa al mayor de la tabla.", wall: "Fila amarilla = muro de mayor volumen (MAX CALL/PUT);", magnet: "🧲 gris = imán del GEX." },
    aggrBuy: "COMPRA",
    aggrSell: "VENTA",
    aggrMid: "MID",
    aggrMixed: "mixto",
    modelAccuracy: "Precisión del modelo",
    noSessions: "aún sin sesiones cerradas para medir",
    sessionsEvaluated: (n) => `${n} sesión${n === 1 ? "" : "es"} evaluada${n === 1 ? "" : "s"}`,
    evalWait: "El modelo guarda su pronóstico de hoy y lo contrasta contra el cierre real. La primera medición aparece mañana; la fiabilidad crece con los días.",
    baseMeanError: "Error medio del base",
    bias: "Sesgo",
    biasAboveSub: "el precio cierra por encima del base",
    biasBelowSub: "por debajo del base",
    bullTouched: "Alcista tocado",
    bearTouched: "Bajista tocado",
    aggrCaveat: "El volumen dice dónde hay actividad; el agresor dice de qué lado. VENTA de calls es resistencia y VENTA de puts es soporte; COMPRA es direccional. El número pequeño es cuántos trades sustentan el porcentaje — desconfía de los que tengan pocos. El agresor se acumula desde que arrancó el agente, así que gana fiabilidad conforme avanza la sesión.",
    strategyHead: "Opciones de recomendación",
    strategySub: "Alternativas de riesgo definido, armadas sobre el mismo GEX/muros que el agente ya calcula arriba.",
    strategyDisclaimer: "El agente calcula y muestra; vos decidís y ejecutás. No es una orden ni un consejo.",
    strategyNone: "No hay setup de estrategia ahora mismo — sin entrada direccional y/o sin un muro limpio para vender.",
    strategyVertical: "Vertical (débito)",
    strategyVerticalBullCall: "Bull Call",
    strategyVerticalBearPut: "Bear Put",
    strategyDebit: "Débito",
    strategyCreditCall: "Credit Call",
    strategyIronCondor: "Iron Condor",
    strategyCredit: "Crédito",
    strategyBreakeven: "Rango de breakeven",
    strategyNoQuote: "sin quote real de esta pata ahora mismo",
    strategyBuy: "Comprá",
    strategySell: "Vendé",
    unknownError: "Error desconocido",
  },
};
