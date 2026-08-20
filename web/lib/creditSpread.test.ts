import { describe, expect, it } from "vitest";
import {
  mid,
  detectTrend,
  guardingLevel,
  eligibility,
  buildStructure,
  creditSpreadCandidates,
  type SpreadQuote,
  type SpreadLevel,
  type CreditSpreadInput,
  type EligibilityInput,
} from "./creditSpread";
import type { MacroEvent } from "./macroCalendar";

// ── Factories ────────────────────────────────────────────────────────────

function q(p: Partial<SpreadQuote> & { strike: number; type: "call" | "put" }): SpreadQuote {
  return {
    expiration: "2026-08-07",
    dte: 6,
    bid: 0.29,
    ask: 0.31,
    delta: p.type === "put" ? -0.15 : 0.15,
    iv: 0.3,
    openInterest: 6000,
    volume: 1500,
    ...p,
  };
}

// Cierres que producen tendencia clara para detectTrend (SMA20/50): una serie
// estrictamente creciente es siempre alcista; una decreciente, bajista; plana, lateral.
const UPTREND = Array.from({ length: 60 }, (_, i) => 70 + i); // 70..129
const DOWNTREND = Array.from({ length: 60 }, (_, i) => 130 - i); // 130..71
const FLAT = Array.from({ length: 60 }, () => 100);

// Niveles: soporte por encima del put corto (95) y resistencia por debajo del call corto (104).
const SUPPORTS: SpreadLevel[] = [{ price: 97, strength: 50 }];
const RESISTANCES: SpreadLevel[] = [{ price: 102, strength: 50 }];

// Chain de un put credit spread válido a spot 100, iv 0.30, dte 6.
// 1σ ≈ ±3.85% → lower1 ≈ 96.22. El put corto 95 queda fuera de 1σ.
// Delta -0.12 = objetivo de venta de prima (banda 0.10–0.15).
const SHORT_PUT = q({ strike: 95, type: "put", delta: -0.12, bid: 0.29, ask: 0.31 });
const LONG_PUT = q({ strike: 94, type: "put", delta: -0.03, bid: 0.14, ask: 0.16 });

const ELIGIBLE_BASE: Omit<CreditSpreadInput, "quotes"> = {
  ticker: "AAPL",
  sector: "Hardware",
  bias: "alcista",
  spot: 100,
  isEtf: false,
  marketCap: 50e9,
  avgVolume20d: 10e6,
  closes: UPTREND,
  supports: SUPPORTS,
  resistances: RESISTANCES,
  earnings: "fuera",
  macroEvents: [],
};

const ELIGIBILITY_OK: EligibilityInput = {
  isEtf: false,
  marketCap: 50e9,
  avgVolume20d: 10e6,
  spot: 100,
  hasWeeklies: true,
  chainOpenInterest: 12000,
  chainVolume: 3000,
  typicalSpreadPctAtDelta: 0.05,
};

// Helper para buildStructure con niveles + IV Rank por defecto.
function build(over: Partial<Parameters<typeof buildStructure>[0]> & {
  type: "put" | "call";
  short: SpreadQuote;
  chain: SpreadQuote[];
}) {
  return buildStructure({
    ticker: "AAPL",
    sector: "Hardware",
    spot: 100,
    chainIvFallback: 0.3,
    supports: SUPPORTS,
    resistances: RESISTANCES,
    ivRank: 45,
    ...over,
  });
}

// ── mid ────────────────────────────────────────────────────────────────

describe("mid", () => {
  it("promedia bid y ask", () => {
    expect(mid(0.28, 0.32)).toBeCloseTo(0.3);
  });
  it("null si falta un lado o el ask no supera al bid", () => {
    expect(mid(null, 0.3)).toBeNull();
    expect(mid(0.3, null)).toBeNull();
    expect(mid(0.4, 0.3)).toBeNull();
  });
});

// ── detectTrend ──────────────────────────────────────────────────────────

describe("detectTrend", () => {
  it("serie creciente → alcista", () => {
    expect(detectTrend(UPTREND)).toBe("alcista");
  });
  it("serie decreciente → bajista", () => {
    expect(detectTrend(DOWNTREND)).toBe("bajista");
  });
  it("serie plana → lateral", () => {
    expect(detectTrend(FLAT)).toBe("lateral");
  });
  it("sin historia suficiente → lateral", () => {
    expect(detectTrend([100, 101, 102])).toBe("lateral");
  });
});

// ── guardingLevel ────────────────────────────────────────────────────────

describe("guardingLevel", () => {
  it("put: soporte fuerte por encima del strike corto → lo respalda", () => {
    const g = guardingLevel("put", 95, [{ price: 97, strength: 50 }], []);
    expect(g?.price).toBe(97);
  });
  it("put: soporte por DEBAJO del strike no cuenta", () => {
    expect(guardingLevel("put", 95, [{ price: 93, strength: 50 }], [])).toBeNull();
  });
  it("put: soporte débil (< 35) no cuenta", () => {
    expect(guardingLevel("put", 95, [{ price: 97, strength: 20 }], [])).toBeNull();
  });
  it("call: resistencia fuerte por debajo del strike corto → lo respalda", () => {
    const g = guardingLevel("call", 104, [], [{ price: 102, strength: 50 }]);
    expect(g?.price).toBe(102);
  });
  it("elige el nivel más cercano al strike", () => {
    const g = guardingLevel("put", 95, [{ price: 99, strength: 50 }, { price: 96, strength: 50 }], []);
    expect(g?.price).toBe(96);
  });
});

// ── eligibility ──────────────────────────────────────────────────────────

describe("eligibility", () => {
  it("pasa cuando cumple todos los umbrales", () => {
    expect(eligibility(ELIGIBILITY_OK)).toEqual({ ok: true, fails: [] });
  });
  it("falla por cap < $10B (acción individual)", () => {
    const r = eligibility({ ...ELIGIBILITY_OK, marketCap: 5e9 });
    expect(r.ok).toBe(false);
    expect(r.fails.some((f) => /< \$10B/.test(f))).toBe(true);
  });
  it("un ETF NO gatea por market cap (SPY/QQQ/IWM son líquidos por construcción)", () => {
    // Venta de prima: los ETFs de índice amplio pasan aunque marketCap venga nulo.
    const r = eligibility({ ...ELIGIBILITY_OK, isEtf: true, marketCap: null });
    expect(r.ok).toBe(true);
  });
  it("ya NO gatea por volumen del subyacente (blue-chips de bajo float pasan)", () => {
    const r = eligibility({ ...ELIGIBILITY_OK, avgVolume20d: 1.2e6 });
    expect(r.ok).toBe(true);
  });
  it("ya NO gatea por OI total de cadena (un solo weekly rara vez llega a 10k)", () => {
    const r = eligibility({ ...ELIGIBILITY_OK, chainOpenInterest: 3000 });
    expect(r.ok).toBe(true);
  });
  it("falla por precio < $30", () => {
    const r = eligibility({ ...ELIGIBILITY_OK, spot: 20 });
    expect(r.fails.some((f) => /< \$30/.test(f))).toBe(true);
  });
  it("falla por bid-ask típico > 25% del mid", () => {
    const r = eligibility({ ...ELIGIBILITY_OK, typicalSpreadPctAtDelta: 0.30 });
    expect(r.fails.some((f) => /Bid-Ask/.test(f))).toBe(true);
  });
  it("falla si no puede medir el bid-ask (sin strikes en banda)", () => {
    const r = eligibility({ ...ELIGIBILITY_OK, typicalSpreadPctAtDelta: null });
    expect(r.fails.some((f) => /medir bid-ask/.test(f))).toBe(true);
  });
});

// ── buildStructure — camino feliz ────────────────────────────────────────

describe("buildStructure — camino feliz", () => {
  it("arma un put credit spread válido con toda la economía", () => {
    const c = build({ type: "put", short: SHORT_PUT, chain: [SHORT_PUT, LONG_PUT] });
    expect(c).not.toBeNull();
    expect(c!.type).toBe("put");
    expect(c!.shortLeg.strike).toBe(95);
    expect(c!.longLeg.strike).toBe(94);
    expect(c!.economics.width).toBeCloseTo(1);
    expect(c!.economics.credit).toBeCloseTo(0.15);
    expect(c!.economics.creditPct).toBeCloseTo(15);
    expect(c!.economics.maxRisk).toBeCloseTo(85); // (1 − 0.15) × 100
    expect(c!.economics.breakeven).toBeCloseTo(94.85);
    expect(c!.economics.shortOutside1Sigma).toBe(true);
    expect(c!.stats.breakevenHitRatePct).toBeCloseTo(85);
    expect(c!.stats.probOtmPct).toBeCloseTo(88); // (1 − 0.12) × 100
    expect(c!.stats.elevatedDelta).toBe(false); // 0.12 no supera 0.14
    expect(c!.longDeltaInBand).toBe(true);
    expect(c!.ivRank).toBe(45);
    expect(c!.ivRankLow).toBe(false); // 45 ≥ 40
    expect(c!.guard!.price).toBe(97); // soporte que respalda el corto
    expect(c!.management.takeProfitGain).toBeCloseTo(7.5); // 0.15 × 0.50 × 100
    expect(c!.management.stopLossLoss).toBeCloseTo(37.5); // 0.15 × 2.5 × 100
  });

  it("marca IV Rank bajo cuando queda por debajo de 40", () => {
    const c = build({ type: "put", short: SHORT_PUT, chain: [SHORT_PUT, LONG_PUT], ivRank: 25 });
    expect(c!.ivRank).toBe(25);
    expect(c!.ivRankLow).toBe(true);
  });
});

// ── buildStructure — banda de delta 0.10–0.15 (venta de prima) ────────────

describe("buildStructure — banda de delta 0.10–0.15 (venta de prima)", () => {
  it("acepta Δ 0.10 (límite inferior inclusivo)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.1, bid: 0.29, ask: 0.31 });
    const c = build({ type: "put", short, chain: [short, LONG_PUT] });
    expect(c).not.toBeNull();
    expect(c!.stats.elevatedDelta).toBe(false); // 0.10 no supera 0.14
  });
  it("acepta Δ 0.15 (límite superior inclusivo) y lo marca en el tope de la banda", () => {
    const short = q({ strike: 95, type: "put", delta: -0.15, bid: 0.29, ask: 0.31 });
    const c = build({ type: "put", short, chain: [short, LONG_PUT] });
    expect(c).not.toBeNull();
    expect(c!.stats.elevatedDelta).toBe(true); // 0.15 > 0.14 → ⚠ tope de la banda
  });
  it("descarta Δ 0.16 (por encima de la banda)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.16, bid: 0.29, ask: 0.31 });
    expect(build({ type: "put", short, chain: [short, LONG_PUT] })).toBeNull();
  });
  it("descarta Δ 0.09 (por debajo de la banda)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.09, bid: 0.29, ask: 0.31 });
    expect(build({ type: "put", short, chain: [short, LONG_PUT] })).toBeNull();
  });
});

// ── buildStructure — descartes de estructura ─────────────────────────────

describe("buildStructure — descartes de estructura", () => {
  it("descarta si NO hay soporte que respalde el put corto", () => {
    expect(
      build({ type: "put", short: SHORT_PUT, chain: [SHORT_PUT, LONG_PUT], supports: [] }),
    ).toBeNull();
  });

  it("descarta si el soporte queda por debajo del strike corto", () => {
    expect(
      build({
        type: "put", short: SHORT_PUT, chain: [SHORT_PUT, LONG_PUT],
        supports: [{ price: 93, strength: 50 }],
      }),
    ).toBeNull();
  });

  it("descarta si el crédito no es positivo (mid corto ≤ mid largo)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.15, bid: 0.14, ask: 0.16 }); // mid 0.15
    const long = q({ strike: 94, type: "put", delta: -0.03, bid: 0.19, ask: 0.21 }); // mid 0.20
    expect(build({ type: "put", short, chain: [short, long] })).toBeNull();
  });

  it("descarta si el strike corto queda DENTRO de 1σ", () => {
    // Put corto 97 > lower1 (≈96.22) → dentro de 1σ.
    const short = q({ strike: 97, type: "put", delta: -0.15, bid: 0.29, ask: 0.31 });
    const long = q({ strike: 96, type: "put", delta: -0.03, bid: 0.14, ask: 0.16 });
    expect(build({ type: "put", short, chain: [short, long] })).toBeNull();
  });

  it("descarta si el bid-ask de la CORTA consume > 30% del crédito", () => {
    // La corta pasa el tope por-pata (0.05/0.30 = 16.7% ≤ 20%) pero su bid-ask 0.05
    // supera el 30% del crédito (0.15 × 0.30 = 0.045), así que cae por el tope de
    // crédito. La pata larga ya NO entra en este tope (es protección barata).
    const short = q({ strike: 95, type: "put", delta: -0.12, bid: 0.275, ask: 0.325 });
    const long = q({ strike: 94, type: "put", delta: -0.03, bid: 0.14, ask: 0.16 });
    expect(build({ type: "put", short, chain: [short, long] })).toBeNull();
  });

  it("la pata LARGA ilíquida (OI bajo, bid-ask ancho) NO descarta — solo cotización válida", () => {
    // Venta de prima: la protección deep-OTM es naturalmente ilíquida. Mientras tenga
    // cotización válida, no bloquea el spread (la liquidez se juzga en la corta).
    const short = q({ strike: 95, type: "put", delta: -0.12, bid: 0.29, ask: 0.31, openInterest: 6000 });
    const illiquidLong = q({ strike: 94, type: "put", delta: -0.03, bid: 0.05, ask: 0.09, openInterest: 40, volume: 0 });
    const c = build({ type: "put", short, chain: [short, illiquidLong] });
    expect(c).not.toBeNull();
    expect(c!.longLeg.strike).toBe(94);
  });

  it("descarta si el bid de la pata corta es 0", () => {
    const short = q({ strike: 95, type: "put", delta: -0.15, bid: 0, ask: 0.31 });
    expect(build({ type: "put", short, chain: [short, LONG_PUT] })).toBeNull();
  });

  it("descarta si OI de la pata CORTA < 250", () => {
    const short = q({ strike: 95, type: "put", delta: -0.15, bid: 0.29, ask: 0.31, openInterest: 100 });
    expect(build({ type: "put", short, chain: [short, LONG_PUT] })).toBeNull();
  });

  it("descarta si no hay pata larga dentro del techo de ancho ($5)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.15 });
    const farLong = q({ strike: 88, type: "put", delta: -0.03 }); // ancho 7 > 5
    expect(build({ type: "put", short, chain: [short, farLong] })).toBeNull();
  });

  it("ancho adaptativo: admite un spread de $2.50 cuando el grid no ofrece $1", () => {
    // Grid de $2.50 (típico de subyacentes caros): la pata OTM más cercana está a
    // $2.50 del corto. El ancho $1–$2 rígido lo descartaba; el adaptativo lo arma.
    const short = q({ strike: 95, type: "put", delta: -0.15, bid: 0.60, ask: 0.62 });
    const long = q({ strike: 92.5, type: "put", delta: -0.04, bid: 0.20, ask: 0.22 });
    const c = build({ type: "put", short, chain: [short, long] });
    expect(c).not.toBeNull();
    expect(c!.economics.width).toBeCloseTo(2.5);
  });

  it("ancho adaptativo: elige el spread MÁS ESTRECHO disponible", () => {
    // Con patas a $1 y a $2.50 del corto, prefiere la de $1 (riesgo definido mínimo).
    const short = q({ strike: 95, type: "put", delta: -0.15 });
    const near = q({ strike: 94, type: "put", delta: -0.05, bid: 0.14, ask: 0.16 });
    const far = q({ strike: 92.5, type: "put", delta: -0.03, bid: 0.10, ask: 0.12 });
    const c = build({ type: "put", short, chain: [short, far, near] });
    expect(c).not.toBeNull();
    expect(c!.longLeg.strike).toBe(94);
    expect(c!.economics.width).toBeCloseTo(1);
  });
});

// ── creditSpreadCandidates — filtros en orden ────────────────────────────

describe("creditSpreadCandidates — filtros eliminatorios", () => {
  it("Filtro 0: un ETF de índice YA NO se descarta (venta de prima lo permite)", () => {
    // SPY/QQQ/IWM son el vehículo estándar: pasan aunque marketCap venga nulo.
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, isEtf: true, marketCap: null, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("candidato");
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("Filtro 1: no elegible por cap baja (acción individual, no ETF)", () => {
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, marketCap: 5e9, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("no_elegible");
    expect(r.reason).toMatch(/\$10B/);
  });

  it("Filtro 2: descarta por earnings dentro de la ventana", () => {
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, earnings: "dentro", quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("descartado");
    expect(r.reason).toMatch(/[Ee]arnings/);
  });

  it("Filtro 3: descarta por evento macro en la ventana", () => {
    const macro: MacroEvent[] = [{ kind: "FOMC", date: "2026-08-05", label: "Comunicado FOMC" }];
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, macroEvents: macro, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("descartado");
    expect(r.reason).toMatch(/macro.*FOMC/);
  });

  it("Filtro 3: el NFP NO descarta — produce candidato con el aviso adjunto", () => {
    const macro: MacroEvent[] = [{ kind: "NFP", date: "2026-08-01", label: "Reporte de empleo" }];
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, macroEvents: macro, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("candidato");
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r.candidates[0].softMacroEvents).toHaveLength(1);
    expect(r.candidates[0].softMacroEvents[0].kind).toBe("NFP");
  });

  it("Filtro 3: un evento DURO junto a un NFP igual descarta", () => {
    const macro: MacroEvent[] = [
      { kind: "NFP", date: "2026-08-01", label: "Reporte de empleo" },
      { kind: "CPI", date: "2026-08-04", label: "IPC" },
    ];
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, macroEvents: macro, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("descartado");
    expect(r.reason).toMatch(/macro.*CPI/);
    expect(r.reason).not.toMatch(/NFP/);
  });

  it("camino feliz: devuelve candidato válido y reporta la tendencia", () => {
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("candidato");
    expect(r.trend).toBe("alcista");
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r.candidates[0].type).toBe("put");
    expect(r.candidates[0].shortLeg.strike).toBe(95);
    expect(r.candidates[0].guard!.price).toBe(97);
  });

  it("realIvRank de Tastytrade MANDA sobre el proxy para la etiqueta ivRankLow", () => {
    // IV Rank real alto (80) → NO se etiqueta ivRankLow y el candidato reporta 80.
    const hi = creditSpreadCandidates({ ...ELIGIBLE_BASE, realIvRank: 80, quotes: [SHORT_PUT, LONG_PUT] });
    expect(hi.candidates[0].ivRank).toBe(80);
    expect(hi.candidates[0].ivRankLow).toBe(false);
    // IV Rank real bajo (10) → SÍ se etiqueta ivRankLow.
    const lo = creditSpreadCandidates({ ...ELIGIBLE_BASE, realIvRank: 10, quotes: [SHORT_PUT, LONG_PUT] });
    expect(lo.candidates[0].ivRank).toBe(10);
    expect(lo.candidates[0].ivRankLow).toBe(true);
  });

  it("mandato completo: un put spread que cumple TODOS los filtros nuevos a la vez", () => {
    // Camino feliz integral: tendencia alcista que CONFIRMA el sesgo alcista,
    // delta corto en banda 0.10–0.15, corto fuera de 1σ, soporte guardián por
    // encima del strike, IV Rank como etiqueta (no descarta), economía y liquidez.
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("candidato");
    expect(r.trend).toBe("alcista"); // la tendencia auto-detectada concuerda con el sesgo
    expect(r.candidates).toHaveLength(1);

    const c = r.candidates[0];
    // Patas y tipo
    expect(c.type).toBe("put");
    expect(c.shortLeg.strike).toBe(95);
    expect(c.longLeg.strike).toBe(94);
    // Banda de delta corta 0.10–0.15 (inclusiva)
    expect(Math.abs(c.shortLeg.delta)).toBeGreaterThanOrEqual(0.10);
    expect(Math.abs(c.shortLeg.delta)).toBeLessThanOrEqual(0.15);
    // 1σ: el corto queda FUERA del movimiento esperado
    expect(c.economics.shortOutside1Sigma).toBe(true);
    // Guardián DURO: soporte fuerte (≥35) por ENCIMA del put corto
    expect(c.guard!.price).toBe(97);
    expect(c.guard!.strength).toBe(50);
    expect(c.guard!.price).toBeGreaterThan(c.shortLeg.strike);
    // IV Rank es SOLO etiqueta: existe y ivRankLow es coherente con el umbral 40
    expect(c.ivRank).not.toBeNull();
    expect(c.ivRankLow).toBe((c.ivRank as number) < 40);
    // Economía: crédito real sobre el MID, ancho $1, riesgo y breakeven derivados
    expect(c.economics.width).toBeCloseTo(1);
    expect(c.economics.credit).toBeCloseTo(0.15);
    expect(c.economics.creditPct).toBeCloseTo(15);
    expect(c.economics.maxRisk).toBeCloseTo(85);
    expect(c.economics.breakeven).toBeCloseTo(94.85);
    // Liquidez de contrato presente en ambas patas
    expect(c.shortLeg.openInterest).toBeGreaterThanOrEqual(500);
    expect(c.longLeg.openInterest).toBeGreaterThanOrEqual(500);
    expect(c.shortLeg.volume).toBeGreaterThan(0);
  });

  it("sin candidatos: elegible pero ningún strike cumple (todos dentro de 1σ)", () => {
    const near1 = q({ strike: 99, type: "put", delta: -0.15, bid: 0.29, ask: 0.31 });
    const near2 = q({ strike: 98, type: "put", delta: -0.16, bid: 0.24, ask: 0.26 });
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [near1, near2] });
    expect(r.status).toBe("sin_candidatos");
  });

  it("respeta el sesgo + tendencia: bias bajista y tendencia bajista → call credit spreads", () => {
    // Call corto 104 (> upper1 ≈103.92) fuera de 1σ, largo 105. Resistencia 102 lo respalda.
    const shortCall = q({ strike: 104, type: "call", delta: 0.15, bid: 0.29, ask: 0.31 });
    const longCall = q({ strike: 105, type: "call", delta: 0.03, bid: 0.14, ask: 0.16 });
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, bias: "bajista", closes: DOWNTREND, quotes: [shortCall, longCall],
    });
    expect(r.status).toBe("candidato");
    expect(r.trend).toBe("bajista");
    expect(r.candidates.every((c) => c.type === "call")).toBe(true);
    expect(r.candidates[0].shortLeg.strike).toBe(104);
    expect(r.candidates[0].guard!.price).toBe(102);
    expect(r.candidates[0].economics.breakeven).toBeCloseTo(104.15);
  });
});

// ── creditSpreadCandidates — tendencia clara (Filtro 4) ──────────────────

describe("creditSpreadCandidates — tendencia clara", () => {
  it("descarta si el precio es lateral (sin tendencia clara)", () => {
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, closes: FLAT, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("descartado");
    expect(r.reason).toMatch(/tendencia clara/i);
    expect(r.trend).toBe("lateral");
  });

  it("descarta si la tendencia no concuerda con el sesgo (alcista pide put, pero baja)", () => {
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, closes: DOWNTREND, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("descartado");
    expect(r.reason).toMatch(/no concuerda/i);
    expect(r.trend).toBe("bajista");
  });

  it("sesgo neutral + tendencia alcista → solo put credit spreads", () => {
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, bias: "neutral", closes: UPTREND, quotes: [SHORT_PUT, LONG_PUT],
    });
    expect(r.status).toBe("candidato");
    expect(r.candidates.every((c) => c.type === "put")).toBe(true);
  });
});

// ── ventana: weekly del frente en [4,7] DTE, el más cercano ──────────────

describe("creditSpreadCandidates — selección del vencimiento (banda 4–7 DTE)", () => {
  it("acepta un weekly a 4 DTE (límite inferior de la banda)", () => {
    // Un lunes, el viernes más cercano cae a 4 DTE. 1σ(dte 4) ≈ ±3.14% →
    // lower1 ≈ 96.86, así que el put corto 95 sigue fuera de 1σ.
    const short = q({ strike: 95, type: "put", delta: -0.15, bid: 0.29, ask: 0.31, dte: 4, expiration: "2026-07-31" });
    const long = q({ strike: 94, type: "put", delta: -0.03, bid: 0.14, ask: 0.16, dte: 4, expiration: "2026-07-31" });
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [short, long] });
    expect(r.status).toBe("candidato");
    expect(r.candidates[0].dte).toBe(4);
  });

  it("rechaza si el único vencimiento cae a 2 DTE (zona gamma, fuera de la banda)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.15, dte: 2, expiration: "2026-07-29" });
    const long = q({ strike: 94, type: "put", delta: -0.03, dte: 2, expiration: "2026-07-29" });
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [short, long] });
    expect(r.status).toBe("no_elegible");
    expect(r.reason).toMatch(/4–7 DTE/);
  });

  it("rechaza si el único vencimiento cae a 11 DTE (fuera de la banda)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.15, dte: 11, expiration: "2026-08-07" });
    const long = q({ strike: 94, type: "put", delta: -0.03, dte: 11, expiration: "2026-08-07" });
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [short, long] });
    expect(r.status).toBe("no_elegible");
    expect(r.reason).toMatch(/4–7 DTE/);
  });

  it("con weeklies a 4 y 6 DTE, toma el MÁS CERCANO (4)", () => {
    const s4 = q({ strike: 95, type: "put", delta: -0.12, bid: 0.29, ask: 0.31, dte: 4, expiration: "2026-07-31" });
    const l4 = q({ strike: 94, type: "put", delta: -0.03, bid: 0.14, ask: 0.16, dte: 4, expiration: "2026-07-31" });
    const s6 = q({ strike: 95, type: "put", delta: -0.12, bid: 0.29, ask: 0.31, dte: 6, expiration: "2026-08-02" });
    const l6 = q({ strike: 94, type: "put", delta: -0.03, bid: 0.14, ask: 0.16, dte: 6, expiration: "2026-08-02" });
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [s6, l6, s4, l4] });
    expect(r.status).toBe("candidato");
    expect(r.candidates.every((c) => c.dte === 4)).toBe(true);
  });

  it("ignora un weekly lejano VÁLIDO si el más cercano no da estructura", () => {
    const near1 = q({ strike: 99, type: "put", delta: -0.12, bid: 0.29, ask: 0.31, dte: 4, expiration: "2026-07-31" });
    const near2 = q({ strike: 98, type: "put", delta: -0.13, bid: 0.24, ask: 0.26, dte: 4, expiration: "2026-07-31" });
    const farShort = q({ strike: 95, type: "put", delta: -0.12, bid: 0.29, ask: 0.31, dte: 6, expiration: "2026-08-02" });
    const farLong = q({ strike: 94, type: "put", delta: -0.03, bid: 0.14, ask: 0.16, dte: 6, expiration: "2026-08-02" });
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [near1, near2, farShort, farLong] });
    expect(r.status).toBe("sin_candidatos");
  });
});

// ── MODO EXPERTO — degrada filtros de CONTEXTO a avisos ──────────────────
// Petición del operador: que el escáner MUESTRE candidatos con la bandera de
// riesgo en vez de bloquearlos. Degrada macro, tendencia, nivel guardián Y el 1σ
// estricto. Deja intactas la banda 4–7 DTE, la delta 0.10–0.15 y toda la
// validación de liquidez/estructura (esos son seguridad, no contexto).

describe("creditSpreadCandidates — modo experto", () => {
  it("en modo normal, el candidato trae warnings vacío", () => {
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("candidato");
    expect(r.candidates[0].warnings).toEqual([]);
  });

  it("macro DURO: en modo experto NO descarta — candidato con aviso macro", () => {
    const macro: MacroEvent[] = [{ kind: "CPI", date: "2026-08-04", label: "IPC" }];
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, expert: true, macroEvents: macro, quotes: [SHORT_PUT, LONG_PUT],
    });
    expect(r.status).toBe("candidato");
    expect(r.candidates[0].warnings.some((w) => /macro.*CPI/i.test(w))).toBe(true);
  });

  it("sin modo experto, el mismo macro DURO sigue descartando", () => {
    const macro: MacroEvent[] = [{ kind: "CPI", date: "2026-08-04", label: "IPC" }];
    const r = creditSpreadCandidates({ ...ELIGIBLE_BASE, macroEvents: macro, quotes: [SHORT_PUT, LONG_PUT] });
    expect(r.status).toBe("descartado");
  });

  it("tendencia lateral: en modo experto cae al sesgo manual con aviso de tendencia", () => {
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, expert: true, closes: FLAT, quotes: [SHORT_PUT, LONG_PUT],
    });
    expect(r.status).toBe("candidato");
    expect(r.candidates[0].type).toBe("put"); // sesgo alcista → put credit spread
    expect(r.candidates[0].warnings.some((w) => /tendencia clara/i.test(w))).toBe(true);
  });

  it("tendencia contraria al sesgo: en modo experto muestra con aviso", () => {
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, expert: true, closes: DOWNTREND, quotes: [SHORT_PUT, LONG_PUT],
    });
    expect(r.status).toBe("candidato");
    expect(r.candidates[0].warnings.some((w) => /no concuerda/i.test(w))).toBe(true);
  });

  it("sin nivel guardián: en modo experto muestra con guard=null y aviso", () => {
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, expert: true, supports: [], quotes: [SHORT_PUT, LONG_PUT],
    });
    expect(r.status).toBe("candidato");
    expect(r.candidates[0].guard).toBeNull();
    expect(r.candidates[0].warnings.some((w) => /soporte/i.test(w))).toBe(true);
  });

  it("modo experto NO relaja la delta 0.10–0.15 (0.20 sigue descartando)", () => {
    const short = q({ strike: 95, type: "put", delta: -0.2, bid: 0.29, ask: 0.31 });
    // Relleno en Δ 0.10–0.19 para pasar la elegibilidad (bid-ask típico). Es delta
    // en banda (0.12) pero SIN pata larga más OTM disponible, así que no arma
    // estructura — y el short 0.20 queda fuera de la banda venta de prima.
    const eligFiller = q({ strike: 93, type: "put", delta: -0.12, bid: 0.10, ask: 0.11 });
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, expert: true, supports: [], closes: FLAT,
      macroEvents: [{ kind: "CPI", date: "2026-08-04", label: "IPC" }],
      quotes: [short, LONG_PUT, eligFiller],
    });
    // Aunque macro/tendencia/guardián/1σ estén degradados, el delta fuera de banda
    // deja el ticker sin ninguna estructura válida.
    expect(r.status).toBe("sin_candidatos");
  });

  it("modo experto SÍ degrada el 1σ: corto dentro de 1σ → candidato con aviso", () => {
    // Put corto 97 con Δ 0.12 (en banda) pero DENTRO de 1σ (lower1 ≈ 96.22). En modo
    // seguro se descartaría; en experto se muestra con el aviso de 1σ.
    const short = q({ strike: 97, type: "put", delta: -0.12, bid: 0.29, ask: 0.31 });
    const long = q({ strike: 96, type: "put", delta: -0.03, bid: 0.14, ask: 0.16 });
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, expert: true, supports: [], quotes: [short, long],
    });
    expect(r.status).toBe("candidato");
    expect(r.candidates[0].economics.shortOutside1Sigma).toBe(false);
    expect(r.candidates[0].warnings.some((w) => /1σ/.test(w))).toBe(true);
  });

  it("macro + tendencia + guardián todos degradados → candidato con 3 avisos", () => {
    const r = creditSpreadCandidates({
      ...ELIGIBLE_BASE, expert: true, closes: FLAT, supports: [],
      macroEvents: [{ kind: "FOMC", date: "2026-08-05", label: "Comunicado FOMC" }],
      quotes: [SHORT_PUT, LONG_PUT],
    });
    expect(r.status).toBe("candidato");
    const w = r.candidates[0].warnings;
    expect(w.some((x) => /macro/i.test(x))).toBe(true);
    expect(w.some((x) => /tendencia/i.test(x))).toBe(true);
    expect(w.some((x) => /soporte/i.test(x))).toBe(true);
  });
});
