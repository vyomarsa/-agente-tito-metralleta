import { describe, expect, it } from "vitest";
import {
  MOMENTUM_SPAN_PCT,
  PULSE_WEIGHTS,
  VIX_GAUGE_MAX,
  buildPulseComponents,
  marketSentiment,
  momentumToGreed,
  putCallToGreed,
  sentimentBandOf,
  vixGaugePos,
  vixState,
  vixToGreed,
  type PulseComponent,
} from "./marketPulse";

describe("vixState — bandas de interpretación de nivel", () => {
  it("clasifica cada banda del cuadro", () => {
    expect(vixState(9.5).band).toBe("complacencia");
    expect(vixState(11.99).band).toBe("complacencia");
    expect(vixState(12).band).toBe("normal");
    expect(vixState(19.9).band).toBe("normal");
    expect(vixState(20).band).toBe("incertidumbre");
    expect(vixState(29.9).band).toBe("incertidumbre");
    expect(vixState(30).band).toBe("miedo");
    expect(vixState(39.9).band).toBe("miedo");
    expect(vixState(40).band).toBe("crisis");
    expect(vixState(80).band).toBe("crisis");
  });
});

describe("vixGaugePos", () => {
  it("sitúa el nivel dentro del arco y satura arriba y abajo", () => {
    expect(vixGaugePos(0)).toBe(0);
    expect(vixGaugePos(VIX_GAUGE_MAX / 2)).toBeCloseTo(0.5, 6);
    expect(vixGaugePos(VIX_GAUGE_MAX)).toBe(1);
    expect(vixGaugePos(120)).toBe(1); // no se sale del arco
  });
});

describe("vixToGreed — va invertido", () => {
  it("VIX bajo = codicia, VIX alto = miedo", () => {
    expect(vixToGreed(10)).toBe(100);
    expect(vixToGreed(55)).toBe(0);
    expect(vixToGreed(12)).toBeGreaterThan(vixToGreed(20));
    expect(vixToGreed(20)).toBeGreaterThan(vixToGreed(30));
    expect(vixToGreed(30)).toBeGreaterThan(vixToGreed(40));
  });

  it("satura fuera de la tabla en vez de extrapolar a lo loco", () => {
    expect(vixToGreed(5)).toBe(100);
    expect(vixToGreed(300)).toBe(0);
  });

  it("interpola dentro de un tramo", () => {
    // Entre 12 (88) y 20 (60): el punto medio 16 debe dar 74.
    expect(vixToGreed(16)).toBeCloseTo(74, 6);
  });

  it("concuerda con la banda del medidor del VIX: normal → zona templada", () => {
    const g = vixToGreed(16);
    expect(vixState(16).band).toBe("normal");
    expect(g).toBeGreaterThan(55);
    expect(g).toBeLessThan(90);
  });
});

describe("momentumToGreed", () => {
  it("en la media da 50", () => {
    expect(momentumToGreed(100, 100)).toBe(50);
  });

  it("un span completo por encima/debajo satura en 100 y 0", () => {
    expect(momentumToGreed(100 * (1 + MOMENTUM_SPAN_PCT / 100), 100)).toBe(100);
    expect(momentumToGreed(100 * (1 - MOMENTUM_SPAN_PCT / 100), 100)).toBe(0);
    expect(momentumToGreed(200, 100)).toBe(100); // no se pasa de 100
    expect(momentumToGreed(1, 100)).toBe(0);
  });

  it("devuelve null con datos inservibles", () => {
    expect(momentumToGreed(0, 100)).toBeNull();
    expect(momentumToGreed(100, 0)).toBeNull();
  });
});

describe("putCallToGreed", () => {
  it("mitad y mitad es neutral", () => {
    expect(putCallToGreed(1_000_000, 1_000_000)).toBe(50);
  });

  it("mucha prima en puts = miedo; mucha en calls = codicia", () => {
    expect(putCallToGreed(350, 650)).toBe(0);   // 65% en puts
    expect(putCallToGreed(650, 350)).toBe(100); // 35% en puts
    expect(putCallToGreed(450, 550)).toBeLessThan(50);
    expect(putCallToGreed(550, 450)).toBeGreaterThan(50);
  });

  it("sin prima no inventa un número", () => {
    expect(putCallToGreed(0, 0)).toBeNull();
  });
});

describe("sentimentBandOf — las bandas van en el orden correcto", () => {
  it("mapea cada tramo", () => {
    expect(sentimentBandOf(0).band).toBe("miedo_extremo");
    expect(sentimentBandOf(24).band).toBe("miedo_extremo");
    expect(sentimentBandOf(25).band).toBe("miedo");
    expect(sentimentBandOf(44).band).toBe("miedo");
    expect(sentimentBandOf(45).band).toBe("neutral");
    expect(sentimentBandOf(55).band).toBe("neutral");
    expect(sentimentBandOf(56).band).toBe("codicia");
    expect(sentimentBandOf(75).band).toBe("codicia");
    expect(sentimentBandOf(76).band).toBe("codicia_extrema");
    expect(sentimentBandOf(100).band).toBe("codicia_extrema");
  });

  it("el extremo bajo es 0-24, NO 45-55 (el gráfico que circula está descolocado)", () => {
    expect(sentimentBandOf(10).band).toBe("miedo_extremo");
    expect(sentimentBandOf(50).band).toBe("neutral");
  });
});

const comp = (key: PulseComponent["key"], score: number | null, weight: number): PulseComponent =>
  ({ key, label: key, score, detail: "", weight });

describe("marketSentiment", () => {
  it("promedia con los pesos declarados", () => {
    const s = marketSentiment([
      comp("volatilidad", 100, PULSE_WEIGHTS.volatilidad),
      comp("momento", 0, PULSE_WEIGHTS.momento),
      comp("putcall", 50, PULSE_WEIGHTS.putcall),
    ]);
    // 100·0.4 + 0·0.35 + 50·0.25 = 52.5 → 53
    expect(s.score).toBe(53);
    expect(s.available).toBe(3);
  });

  it("RENORMALIZA los pesos cuando falta un componente (no rellena con 50)", () => {
    const s = marketSentiment([
      comp("volatilidad", 80, PULSE_WEIGHTS.volatilidad),
      comp("momento", 20, PULSE_WEIGHTS.momento),
      comp("putcall", null, PULSE_WEIGHTS.putcall),
    ]);
    // (80·0.4 + 20·0.35) / 0.75 = 52
    expect(s.score).toBe(52);
    expect(s.available).toBe(2);
    // Si rellenara el hueco con 50 daría 80·0.4+20·0.35+50·0.25 = 51.5 → 52 también,
    // así que se comprueba con un caso donde SÍ se distinguen:
    const s2 = marketSentiment([
      comp("volatilidad", 100, PULSE_WEIGHTS.volatilidad),
      comp("momento", 100, PULSE_WEIGHTS.momento),
      comp("putcall", null, PULSE_WEIGHTS.putcall),
    ]);
    expect(s2.score).toBe(100); // renormalizado; con relleno de 50 habría dado 88
  });

  it("sin ningún componente devuelve null, no un 50 inventado", () => {
    const s = marketSentiment([
      comp("volatilidad", null, 0.4),
      comp("momento", null, 0.35),
      comp("putcall", null, 0.25),
    ]);
    expect(s.score).toBeNull();
    expect(s.band).toBeNull();
    expect(s.available).toBe(0);
  });
});

describe("buildPulseComponents", () => {
  it("arma los tres componentes con su detalle legible", () => {
    const cs = buildPulseComponents({
      vix: 16, spyPrice: 110, spySma125: 100,
      callPremium: 600, putPremium: 400,
    });
    expect(cs.map((c) => c.key)).toEqual(["volatilidad", "momento", "putcall"]);
    expect(cs[0].score).toBeCloseTo(74, 6);
    expect(cs[0].detail).toMatch(/VIX 16\.00 — condiciones normales/);
    expect(cs[1].score).toBe(100); // +10% sobre la media
    expect(cs[1].detail).toMatch(/\+10\.0% sobre su media/);
    expect(cs[2].detail).toMatch(/40% de la prima ejecutada hoy se fue a puts/);
  });

  it("marca los huecos en vez de inventarlos", () => {
    const cs = buildPulseComponents({
      vix: null, spyPrice: null, spySma125: null, callPremium: 0, putPremium: 0,
    });
    expect(cs.every((c) => c.score === null)).toBe(true);
    expect(cs[0].detail).toMatch(/sin dato del VIX/);
    expect(cs[1].detail).toMatch(/sin barras suficientes/);
    expect(cs[2].detail).toMatch(/sin flujo del mercado/);
    expect(marketSentiment(cs).score).toBeNull();
  });

  it("un mercado tranquilo y subiendo da codicia; uno nervioso y cayendo, miedo", () => {
    const calmo = marketSentiment(buildPulseComponents({
      vix: 11, spyPrice: 108, spySma125: 100, callPremium: 700, putPremium: 300,
    }));
    const nervioso = marketSentiment(buildPulseComponents({
      vix: 38, spyPrice: 92, spySma125: 100, callPremium: 300, putPremium: 700,
    }));
    expect(calmo.band!.band).toBe("codicia_extrema");
    expect(nervioso.band!.band).toBe("miedo_extremo");
  });
});
