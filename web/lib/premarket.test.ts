import { describe, expect, it } from "vitest";
import {
  bigMoney, headlineBias, maAnalysis, notionalSummary, premarketText, tickerVerdict,
  type PremarketReport, type TickerInput,
} from "./premarket";

/** n cierres que suben linealmente de `from` en pasos de `step`. */
function serie(n: number, from: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i * step);
}

describe("maAnalysis", () => {
  it("tendencia alcista: precio > MA55 > MA200 y pendientes positivas", () => {
    const closes = serie(260, 100, 0.5);
    const m = maAnalysis(closes, closes[closes.length - 1] + 1);
    expect(m.trend).toBe("alcista");
    expect(m.stack).toBe("55>200");
    expect(m.ma55!).toBeGreaterThan(m.ma200!);
    expect(m.slope55!).toBeGreaterThan(0);
    expect(m.dist200!).toBeGreaterThan(m.dist55!);
  });

  it("tendencia bajista: precio < MA55 < MA200", () => {
    const closes = serie(260, 300, -0.5);
    const m = maAnalysis(closes, closes[closes.length - 1] - 1);
    expect(m.trend).toBe("bajista");
    expect(m.stack).toBe("55<200");
  });

  it("retroceso: bajo la MA55 pero sobre la MA200 es mixta, no bajista", () => {
    const closes = serie(260, 100, 0.5);
    const m = maAnalysis(closes, m55Minus(closes));
    expect(m.trend).toBe("mixta");
    expect(m.reading).toMatch(/retroceso/);
  });

  it("sin 200 velas no inventa la MA200", () => {
    const m = maAnalysis(serie(120, 100, 1), 250);
    expect(m.ma200).toBeNull();
    expect(m.ma55).not.toBeNull();
    expect(m.trend).toBe("mixta");
  });

  it("marca un cruce dorado reciente", () => {
    // 200 velas bajando y luego un rebote fuerte que lleva la 55 sobre la 200.
    const closes = [...serie(230, 200, -0.3), ...serie(40, 140, 3)];
    const m = maAnalysis(closes, closes[closes.length - 1]);
    // Recorre hasta encontrar la vela del cruce y comprueba que se detecta justo después.
    let visto = false;
    for (let n = 210; n <= closes.length; n++) {
      if (maAnalysis(closes.slice(0, n), closes[n - 1]).freshCross === "dorado") visto = true;
    }
    expect(visto).toBe(true);
    expect(m.stack).toBe("55>200");
  });
});

function m55Minus(closes: number[]): number {
  const ma55 = closes.slice(-55).reduce((a, b) => a + b, 0) / 55;
  return ma55 - 1;
}

describe("notionalSummary", () => {
  it("nocional = OI × 100 × precio, y muros a cada lado del precio", () => {
    const s = notionalSummary(
      [
        { strike: 105, type: "call", openInterest: 1000, delta: 0.3 },
        { strike: 107, type: "call", openInterest: 5000, delta: 0.1 },
        { strike: 130, type: "call", openInterest: 50000, delta: 0.01 }, // cola lejana: no es muro
        { strike: 90, type: "call", openInterest: 9000, delta: 0.9 }, // ITM: no es muro
        { strike: 95, type: "put", openInterest: 4000, delta: -0.3 },
        { strike: 94, type: "put", openInterest: 2000, delta: -0.05 },
        { strike: 70, type: "put", openInterest: 90000, delta: -0.01 }, // cobertura de cola
      ],
      100,
    );
    expect(s.callNotional).toBe((1000 + 5000 + 50000 + 9000) * 100 * 100);
    expect(s.putNotional).toBe((4000 + 2000 + 90000) * 100 * 100);
    expect(s.callWall?.strike).toBe(107);
    expect(s.putWall?.strike).toBe(95);
    expect(s.putCallRatio).toBeCloseTo(96000 / 65000);
    // Neto Δ = Σ OI·100·S·Δ
    expect(s.netDeltaNotional).toBeCloseTo(
      100 * 100 * (1000 * 0.3 + 5000 * 0.1 + 50000 * 0.01 + 9000 * 0.9 - 4000 * 0.3 - 2000 * 0.05 - 90000 * 0.01),
    );
  });

  it("ignora OI negativo o no numérico", () => {
    const s = notionalSummary([{ strike: 110, type: "call", openInterest: NaN, delta: 0.3 }], 100);
    expect(s.callNotional).toBe(0);
    expect(s.putCallRatio).toBeNull();
  });
});

describe("tickerVerdict", () => {
  const base: TickerInput = {
    ticker: "AAPL", price: 100, prevClose: 99, ma: null, notional: null,
    newsBias: null, earningsDate: null, headlines: [], errors: [],
  };

  it("una sola fuente no basta para dar sesgo", () => {
    expect(tickerVerdict({ ...base, newsBias: "alcista" }).bias).toBe("neutral");
  });

  it("dos votos alcistas dan sesgo alcista", () => {
    const closes = serie(260, 100, 0.5);
    const ma = maAnalysis(closes, closes[closes.length - 1] + 1);
    expect(tickerVerdict({ ...base, ma, newsBias: "alcista" }).bias).toBe("alcista");
  });

  it("votos opuestos se anulan", () => {
    const closes = serie(260, 100, 0.5);
    const ma = maAnalysis(closes, closes[closes.length - 1] + 1);
    expect(tickerVerdict({ ...base, ma, newsBias: "bajista" }).bias).toBe("neutral");
  });
});

describe("headlineBias", () => {
  it("null sin sentimiento", () => expect(headlineBias([{ sentiment: null }])).toBeNull());
  it("exige al menos dos titulares en el mismo sentido", () => {
    expect(headlineBias([{ sentiment: "positive" }])).toBe("neutral");
    expect(headlineBias([{ sentiment: "positive" }, { sentiment: "positive" }])).toBe("alcista");
    expect(headlineBias([{ sentiment: "negative" }, { sentiment: "negative" }, { sentiment: "positive" }])).toBe("bajista");
  });
});

describe("bigMoney", () => {
  it("abrevia", () => {
    expect(bigMoney(1.5e12)).toBe("$1.50T");
    expect(bigMoney(2.34e9)).toBe("$2.3B");
    expect(bigMoney(-45e6)).toBe("−$45M");
  });
});

describe("premarketText", () => {
  it("separa índices y 7 magníficas y escapa HTML", () => {
    const r: PremarketReport = {
      date: "2026-10-05",
      vix: 15.2,
      macroToday: [{ date: "2026-10-05", label: "CPI <agosto>" }],
      macroSoon: [],
      headlines: [{ title: "Fed & mercados", publisher: "CNBC" }],
      tickers: [
        { ticker: "SPY", price: 770, prevClose: 768, ma: null, notional: null, newsBias: null, earningsDate: null, headlines: [], errors: [] },
        { ticker: "NVDA", price: 200, prevClose: 201, ma: null, notional: null, newsBias: null, earningsDate: "2026-10-08", headlines: [], errors: ["velas: timeout"] },
      ],
    };
    const t = premarketText(r);
    expect(t).toContain("PRE-MARKET 2026-10-05");
    expect(t.indexOf("Índices")).toBeLessThan(t.indexOf("<b>SPY</b>"));
    expect(t.indexOf("7 Magníficas")).toBeLessThan(t.indexOf("<b>NVDA</b>"));
    expect(t).toContain("CPI &lt;agosto&gt;");
    expect(t).toContain("Fed &amp; mercados");
    expect(t).toContain("Earnings cerca: NVDA 2026-10-08");
    expect(t).toContain("⚠️ velas: timeout");
    expect(t).toContain("gap +0.26%");
  });
});

describe("voto del nocional por delta neto", () => {
  it("un índice cargado de puts de cobertura lejanos NO sale bajista", () => {
    // P/C alto, pero las puts son de cola (delta pequeño): el neto apenas se mueve.
    const n = notionalSummary(
      [
        { strike: 101, type: "call", openInterest: 10000, delta: 0.45 },
        { strike: 80, type: "put", openInterest: 30000, delta: -0.03 },
        { strike: 99, type: "put", openInterest: 5000, delta: -0.45 },
      ],
      100,
    );
    expect(n.putCallRatio!).toBeGreaterThan(3);
    const v = tickerVerdict({
      ticker: "SPY", price: 100, prevClose: 100, ma: null, notional: n,
      newsBias: null, earningsDate: null, headlines: [], errors: [],
    });
    expect(v.reasons.join()).not.toMatch(/corto/);
  });
});
