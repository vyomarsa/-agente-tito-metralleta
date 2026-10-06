import { describe, expect, it } from "vitest";
import type { ZeroDteAnalysis, ZeroDteLeg, ZeroDteStrike } from "./zerodte";
import {
  CLOSING_WINDOW_MIN, closeForecast, dealerCharm, maxPainStrike, strikeStep,
} from "./zerodteClose";

// ---------------------------------------------------------------------------
// Fixturas: cadena mínima alrededor de un spot de 100.
// ---------------------------------------------------------------------------

function leg(openInterest: number): ZeroDteLeg | null {
  if (openInterest <= 0) return null;
  return {
    optionSymbol: "TEST", volume: 100, openInterest, price: 1.2,
    bid: 1.15, ask: 1.25, delta: 0.4, gamma: 0.05, iv: 0.2,
    openPremium: 0, notional: 0, premiumTraded: 0,
  };
}

/** Strike con el Open Interest que interesa a cada test. */
function oi(k: number, callOi: number, putOi: number): ZeroDteStrike {
  return {
    strike: k,
    call: leg(callOi),
    put: leg(putOi),
    callVolume: 0, putVolume: 0, totalVolume: 0,
    netGex: 0, itm: null,
  };
}

function analysis(over: Partial<ZeroDteAnalysis> = {}): ZeroDteAnalysis {
  return {
    spot: 100,
    iv: 0.2,
    chainIv: 0.25,
    ivSource: "realizada",
    strikes: [oi(98, 500, 500), oi(99, 500, 500), oi(100, 500, 500), oi(101, 500, 500), oi(102, 500, 500)],
    maxVolume: 100,
    magnet: 101,
    flipStrike: 99.5,
    regime: "positive",
    totalGex: 5e8,
    maxCall: null, maxPut: null, topVolumeCall: null, topVolumePut: null,
    putCall: { ratio: 1, puts: 0, calls: 0 },
    gammaCoverage: { strikes: 5, contracts: 10, withGamma: 10, pct: 100 },
    lean: "lateral", confidence: 40, leanScore: 0, callPct: 50,
    scenarios: {
      bear: { kind: "bear", target: 98, changePct: -2, driver: "", touchProb: 0.5, attractionStrike: 98, attractionContracts: 0 },
      base: { kind: "base", target: 101, changePct: 1, driver: "", touchProb: 0.6, attractionStrike: 101, attractionContracts: 0 },
      bull: { kind: "bull", target: 102, changePct: 2, driver: "", touchProb: 0.4, attractionStrike: 102, attractionContracts: 0 },
    },
    expectedRange: { low: 98.5, high: 101.5, sigmaPct: 1.5 },
    horizonDays: 0.15,
    horizonDaysUsed: 0.15,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("strikeStep", () => {
  it("saca la mediana del salto entre strikes", () => {
    expect(strikeStep([oi(95, 1, 1), oi(100, 1, 1), oi(105, 1, 1)])).toBe(5);
    expect(strikeStep([oi(98, 1, 1), oi(99, 1, 1), oi(100, 1, 1)])).toBe(1);
  });

  it("aguanta un hueco suelto sin dejarse arrastrar (mediana, no media)", () => {
    // 1, 1, 1, 8: la media sería 2,75; la mediana se queda en el salto real.
    expect(strikeStep([oi(98, 1, 1), oi(99, 1, 1), oi(100, 1, 1), oi(101, 1, 1), oi(109, 1, 1)])).toBe(1);
  });

  it("cae a 1 sin strikes suficientes", () => {
    expect(strikeStep([])).toBe(1);
    expect(strikeStep([oi(100, 1, 1)])).toBe(1);
  });
});

describe("maxPainStrike", () => {
  it("elige el strike de menor valor intrínseco para los compradores", () => {
    // Todo el OI en 100: ahí el intrínseco total es exactamente 0.
    const strikes = [oi(98, 0, 0), oi(99, 0, 0), oi(100, 5000, 5000), oi(101, 0, 0), oi(102, 0, 0)];
    expect(maxPainStrike(strikes, 100)).toBe(100);
  });

  it("gravita hacia el lado con más Open Interest", () => {
    // 3000 calls en 99 contra 1000 puts en 101: cerrar en 99 duele menos.
    //   P=99  → puts (101−99)·1000 = 2000
    //   P=100 → calls 3000 + puts 1000 = 4000
    //   P=101 → calls (101−99)·3000 = 6000
    const strikes = [oi(99, 3000, 0), oi(100, 0, 0), oi(101, 0, 1000)];
    expect(maxPainStrike(strikes, 100)).toBe(99);
  });

  it("ignora los muros lejanos: solo cuenta la ventana cercana al spot", () => {
    // El muro de 50.000 calls está a −10%: fuera de ±3%, no puede fijar el cierre.
    const strikes = [oi(90, 50_000, 0), oi(99, 0, 1000), oi(100, 0, 0), oi(101, 1000, 0)];
    expect(maxPainStrike(strikes, 100)).not.toBe(90);
  });

  it("devuelve null sin OI o sin spot", () => {
    expect(maxPainStrike([oi(100, 0, 0)], 100)).toBeNull();
    expect(maxPainStrike([], 100)).toBeNull();
    expect(maxPainStrike([oi(100, 500, 500)], 0)).toBeNull();
  });
});

describe("dealerCharm", () => {
  // A 30 min del cierre y con IV 25%, σ ≈ 0,19 pts sobre un spot de 100: los
  // strikes que aún tienen delta vivo son los de décimas, no los de puntos.
  it("con el OI DEBAJO del spot el dealer recompra: deriva alcista", () => {
    // Puts OTM que se desvanecen → el dealer deshace el corto → compra.
    const c = dealerCharm([oi(99.8, 2000, 2000)], 100, 0.25, 30);
    expect(c).not.toBeNull();
    expect(c!.flow).toBeGreaterThan(0);
    expect(c!.dir).toBe("up");
  });

  it("con el OI ENCIMA del spot el dealer vende: deriva bajista", () => {
    const c = dealerCharm([oi(100.2, 2000, 2000)], 100, 0.25, 30);
    expect(c!.flow).toBeLessThan(0);
    expect(c!.dir).toBe("down");
  });

  it("un strike ya fuera de alcance no aporta cobertura", () => {
    // 102 con 30 min por delante son ~10σ: ese delta ya está en cero, no decae.
    expect(dealerCharm([oi(102, 5000, 5000)], 100, 0.25, 30)!.dir).toBeNull();
  });

  it("la intensidad crece hacia el cierre (charm ~ 1/T)", () => {
    const abierto = dealerCharm([oi(98, 1000, 1000)], 100, 0.25, 390)!;
    const media = dealerCharm([oi(98, 1000, 1000)], 100, 0.25, 195)!;
    const cierre = dealerCharm([oi(98, 1000, 1000)], 100, 0.25, 5)!;
    expect(abierto.intensity).toBeCloseTo(0, 5);
    expect(media.intensity).toBeCloseTo(0.5, 5);
    expect(cierre.intensity).toBeGreaterThan(0.98);
  });

  it("no explota en el último minuto (suelo de T)", () => {
    const c = dealerCharm([oi(100, 1000, 1000)], 100, 0.25, 0.01)!;
    expect(Number.isFinite(c.flow)).toBe(true);
    expect(c.intensity).toBeLessThanOrEqual(1);
  });

  it("devuelve null si no hay tiempo, IV o strikes con OI", () => {
    expect(dealerCharm([oi(98, 1000, 1000)], 100, 0.25, 0)).toBeNull();
    expect(dealerCharm([oi(98, 1000, 1000)], 100, 0, 30)).toBeNull();
    expect(dealerCharm([oi(98, 0, 0)], 100, 0.25, 30)).toBeNull();
  });
});

describe("closeForecast", () => {
  it("antes de las 15:00 no publica strike, pero ya calcula Max Pain y charm", () => {
    const f = closeForecast({ a: analysis(), minutesLeft: 120, isToday: true })!;
    expect(f.phase).toBe("pending");
    expect(f.maxPain).not.toBeNull();
    expect(f.charm).not.toBeNull();
    expect(f.confidence).toBe("baja");
  });

  it("dentro de la ventana el estimado se va al imán y el rango se redondea al grid", () => {
    const f = closeForecast({ a: analysis(), minutesLeft: CLOSING_WINDOW_MIN, isToday: true })!;
    expect(f.phase).toBe("live");
    expect(f.estimate).toBe(101); // imán 101, alcanzable dentro de 2σ = 3 pts
    expect(f.step).toBe(1);
    expect(f.confidence).toBe("media");
  });

  it("converge: con menos σ el estimado no puede saltar hasta el imán", () => {
    const lejos = analysis({ expectedRange: { low: 99.9, high: 100.1, sigmaPct: 0.1 } });
    const f = closeForecast({ a: lejos, minutesLeft: 10, isToday: true })!;
    // 2σ = 0,2 pts: el imán de 101 queda fuera de alcance, se acota.
    expect(f.estimate).toBeCloseTo(100.2, 6);
    expect(f.confidence).toBe("alta");
  });

  it("en γ− no hay pin: el estimado es el precio actual y la confianza baja", () => {
    const f = closeForecast({
      a: analysis({ regime: "negative", totalGex: -5e8 }),
      minutesLeft: 10,
      isToday: true,
    })!;
    expect(f.estimate).toBe(100);
    expect(f.confidence).toBe("baja");
    expect(f.confluence).toBe(false);
  });

  it("marca confluencia cuando Max Pain y el imán coinciden a ±1 strike en γ+", () => {
    const a = analysis({
      magnet: 100,
      strikes: [oi(98, 0, 0), oi(99, 0, 0), oi(100, 5000, 5000), oi(101, 0, 0), oi(102, 0, 0)],
    });
    const f = closeForecast({ a, minutesLeft: 30, isToday: true })!;
    expect(f.maxPain).toBe(100);
    expect(f.confluence).toBe(true);
    expect(f.note).toContain("confluencia");
  });

  it("no marca confluencia en γ− aunque Max Pain coincida con el imán", () => {
    const a = analysis({
      regime: "negative",
      magnet: 100,
      strikes: [oi(100, 5000, 5000)],
    });
    expect(closeForecast({ a, minutesLeft: 30, isToday: true })!.confluence).toBe(false);
  });

  it("usa el MISMO cono que los escenarios, para no contradecirlos", () => {
    const a = analysis();
    const f = closeForecast({ a, minutesLeft: 30, isToday: true })!;
    expect(f.sigma).toBeCloseTo(1.5, 6); // spot 100 × sigmaPct 1,5%
    expect(f.rangeLow).toBe(a.expectedRange.low);
    expect(f.rangeHigh).toBe(a.expectedRange.high);
  });

  it("no redondea el rango al grid: con σ menor que el salto lo desplazaría entero", () => {
    // Caso real de SPY al filo del cierre: σ = 0,52 pts y strikes de $1 en $1.
    // Redondeando, 769,53–770,57 se enseñaba como 770–771 — toda la banda subida.
    const a = analysis({
      spot: 770.05,
      expectedRange: { low: 769.53, high: 770.57, sigmaPct: 0.0675 },
      strikes: [oi(769, 500, 500), oi(770, 500, 500), oi(771, 500, 500)],
    });
    const f = closeForecast({ a, minutesLeft: 20, isToday: true })!;
    expect(f.step).toBe(1);
    expect(f.rangeLow).toBeCloseTo(769.53, 6);
    expect(f.rangeHigh).toBeCloseTo(770.57, 6);
    expect(f.rangeLow).toBeLessThan(a.spot);
    expect(f.rangeHigh).toBeGreaterThan(a.spot);
  });

  it("no aplica a un vencimiento que no es el de hoy", () => {
    expect(closeForecast({ a: analysis(), minutesLeft: 30, isToday: false })).toBeNull();
  });

  it("con la sesión cerrada pasa a final, sin charm y sin hablar de tiempo restante", () => {
    const f = closeForecast({ a: analysis(), minutesLeft: 0, isToday: true })!;
    expect(f.phase).toBe("final");
    expect(f.charm).toBeNull();
    // "Quedan 0 min y el margen es ±0,52 pts" se leería como un pronóstico vivo.
    expect(f.note).not.toContain("Quedan");
    expect(f.note).toContain("Sesión cerrada");
    expect(f.maxPain).not.toBeNull(); // el Max Pain del día sigue siendo la foto útil
  });

  it("en pending la nota dice cuándo entra en vigor", () => {
    const f = closeForecast({ a: analysis(), minutesLeft: 120, isToday: true })!;
    expect(f.note).toContain("15:00 ET");
  });
});
