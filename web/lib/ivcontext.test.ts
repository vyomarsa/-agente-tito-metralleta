import { describe, expect, it } from "vitest";
import {
  ivContextScore,
  ivPoints,
  ivRankPoints,
  rankWithin,
  realizedVolSeries,
} from "./ivcontext";
import type { FlowRow } from "./flow";

function row(p: Partial<FlowRow>): FlowRow {
  return {
    id: 1, symbol: "TSLA260724C00347500", underlying: "TSLA", type: "call",
    strike: 347.5, expiration: "2026-07-24", dte: 0, price: 1, size: 1,
    side: "ask", aggression: "ask", assetPrice: 320, bid: 0.9, ask: 1.1,
    premium: 1000, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.1,
    thetaPctDaily: null, iv: 0.5, openInterest: 100, volume: 10, score: 50,
    sentiment: "neutral", timestamp: "2026-07-24T14:00:00Z",
    conditionCode: null, conditionName: null,
    flags: {} as FlowRow["flags"], scores: {} as FlowRow["scores"],
    unusual: false, interesting: false, expiryStatus: "vigente",
    ...p,
  } as FlowRow;
}

describe("ivPoints — tabla del documento", () => {
  it("respeta cada banda", () => {
    expect(ivPoints(120).points).toBe(6);
    expect(ivPoints(100).points).toBe(6);
    expect(ivPoints(99).points).toBe(5);
    expect(ivPoints(90).points).toBe(5);
    expect(ivPoints(89).points).toBe(8);
    expect(ivPoints(61).points).toBe(8);
    expect(ivPoints(60).points).toBe(10);
    expect(ivPoints(50).points).toBe(10);
    expect(ivPoints(40).points).toBe(10);
    expect(ivPoints(39).points).toBe(5);
    expect(ivPoints(30).points).toBe(5);
    expect(ivPoints(29).points).toBe(2);
  });

  it("el pico está en la IV moderada (40-60%), no en la alta", () => {
    expect(ivPoints(50).points).toBeGreaterThan(ivPoints(95).points);
    expect(ivPoints(50).points).toBeGreaterThan(ivPoints(120).points);
    expect(ivPoints(50).points).toBeGreaterThan(ivPoints(25).points);
  });

  it("castiga la volatilidad cara más que la moderada", () => {
    expect(ivPoints(95).points).toBeLessThan(ivPoints(75).points);
  });

  it("marca +100% como categoría especial", () => {
    expect(ivPoints(101).special).toBe(true);
    expect(ivPoints(99).special).toBeUndefined();
  });

  it("cubre el hueco entre 89 y 90 que deja el documento", () => {
    expect(ivPoints(89.5).points).toBe(8);
  });

  it("sin datos → 0", () => {
    expect(ivPoints(NaN).points).toBe(0);
    expect(ivPoints(-1).points).toBe(0);
  });
});

describe("ivRankPoints — tabla del documento", () => {
  it("respeta cada banda", () => {
    expect(ivRankPoints(0).points).toBe(2);
    expect(ivRankPoints(15).points).toBe(2);
    expect(ivRankPoints(16).points).toBe(10);
    expect(ivRankPoints(30).points).toBe(10);
    expect(ivRankPoints(31).points).toBe(8);
    expect(ivRankPoints(50).points).toBe(8);
    expect(ivRankPoints(51).points).toBe(5);
    expect(ivRankPoints(70).points).toBe(5);
    expect(ivRankPoints(71).points).toBe(1);
    expect(ivRankPoints(99).points).toBe(1);
    expect(ivRankPoints(100).points).toBe(0);
  });

  it("premia la compresión sobre la expansión", () => {
    expect(ivRankPoints(20).points).toBeGreaterThan(ivRankPoints(80).points);
  });

  it("0-15% es la acción dormida: puntúa bajo, no alto", () => {
    expect(ivRankPoints(10).points).toBe(2);
    expect(ivRankPoints(10).points).toBeLessThan(ivRankPoints(20).points);
    expect(ivRankPoints(10).points).toBeLessThan(ivRankPoints(40).points);
  });

  it("decrece de forma monótona a partir del pico en 16-30%", () => {
    const tramos = [16, 31, 51, 71, 100].map((r) => ivRankPoints(r).points);
    for (let i = 1; i < tramos.length; i++) {
      expect(tramos[i]).toBeLessThan(tramos[i - 1]);
    }
  });
});

describe("realizedVolSeries", () => {
  it("devuelve vacío si no hay barras suficientes", () => {
    expect(realizedVolSeries([1, 2, 3])).toEqual([]);
  });

  it("una acción plana tiene volatilidad ~0", () => {
    const s = realizedVolSeries(new Array(60).fill(100));
    expect(s.length).toBeGreaterThan(0);
    expect(s[s.length - 1]).toBeCloseTo(0, 6);
  });

  it("más zigzag → más volatilidad", () => {
    const calma = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 0.1 : -0.1));
    const loca = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 8 : -8));
    const a = realizedVolSeries(calma), b = realizedVolSeries(loca);
    expect(b[b.length - 1]).toBeGreaterThan(a[a.length - 1]);
  });
});

describe("rankWithin", () => {
  it("sitúa el valor dentro del rango en 0-100", () => {
    expect(rankWithin([10, 20, 30], 10)).toBe(0);
    expect(rankWithin([10, 20, 30], 30)).toBe(100);
    expect(rankWithin([10, 20, 30], 20)).toBe(50);
  });
  it("serie plana → null (no hay rango que medir)", () => {
    expect(rankWithin([5, 5, 5], 5)).toBeNull();
  });
  it("recorta fuera de rango", () => {
    expect(rankWithin([10, 30], 99)).toBe(100);
  });
});

describe("ivContextScore", () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 3) * 5);

  it("sin trades con IV devuelve el reporte vacío", () => {
    const s = ivContextScore({ rows: [row({ iv: 0 })], closes });
    expect(s.score).toBe(0);
    expect(s.regime).toBe("desconocido");
  });

  it("convierte la IV decimal de MarketSnack a porcentaje", () => {
    const s = ivContextScore({ rows: [row({ iv: 0.477 })], closes });
    expect(s.iv.current).toBeCloseTo(47.7, 1);
    expect(s.iv.points).toBe(10); // 40-60% — la zona buena
  });

  it("pondera por premium: el dinero grande manda sobre los tickets chicos", () => {
    const s = ivContextScore({
      rows: [
        row({ id: 1, iv: 0.90, premium: 1_000_000 }),
        row({ id: 2, iv: 0.30, premium: 1_000 }),
        row({ id: 3, iv: 0.30, premium: 1_000 }),
      ],
      closes,
    });
    expect(s.iv.current!).toBeGreaterThan(85);
    expect(s.iv.simpleAvg!).toBeLessThan(s.iv.current!);
  });

  it("agrupa el promedio de IV por vencimiento, ordenado por cercanía", () => {
    const s = ivContextScore({
      rows: [
        row({ id: 1, expiration: "2026-07-24", dte: 0, iv: 0.80 }),
        row({ id: 2, expiration: "2026-07-24", dte: 0, iv: 0.60 }),
        row({ id: 3, expiration: "2026-12-18", dte: 147, iv: 0.50 }),
      ],
      closes,
    });
    expect(s.byExpiration).toHaveLength(2);
    expect(s.byExpiration[0].expiration).toBe("2026-07-24");
    expect(s.byExpiration[0].avgIv).toBeCloseTo(70, 6);
    expect(s.byExpiration[0].trades).toBe(2);
    expect(s.byExpiration[0].maxIv).toBeCloseTo(80, 6);
  });

  it("detecta el skew del frente (evento inminente)", () => {
    const s = ivContextScore({
      rows: [
        row({ id: 1, expiration: "2026-07-24", dte: 0, iv: 0.90 }),
        row({ id: 2, expiration: "2026-09-18", dte: 56, iv: 0.45 }),
        row({ id: 3, expiration: "2026-12-18", dte: 147, iv: 0.45 }),
      ],
      closes,
    });
    expect(s.frontSkew).toBeCloseTo(45, 6);
  });

  it("lista los contratos de mayor IV primero", () => {
    const s = ivContextScore({
      rows: [row({ id: 1, iv: 0.40 }), row({ id: 2, iv: 0.95 }), row({ id: 3, iv: 0.60 })],
      closes,
    });
    expect(s.topContracts.map((c) => c.id)).toEqual([2, 3, 1]);
    expect(s.topContracts[0].iv).toBeCloseTo(95, 6);
  });

  it("usa el proxy de volatilidad realizada cuando no hay historia de IV", () => {
    const s = ivContextScore({ rows: [row({ iv: 0.5 })], closes });
    expect(s.rank.source).toBe("realized-proxy");
    expect(s.rank.value).not.toBeNull();
  });

  it("la historia propia de IV desplaza al proxy cuando alcanza 60 días", () => {
    const ivHistory = Array.from({ length: 60 }, (_, i) => ({
      date: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
      avgIv: 30 + i, // 30…89
    }));
    const s = ivContextScore({ rows: [row({ iv: 0.60 })], closes, ivHistory });
    expect(s.rank.source).toBe("iv-history");
    expect(s.rank.days).toBe(60);
    // 60 dentro de [30, 89] → ~50.8
    expect(s.rank.value!).toBeCloseTo(50.8, 1);
  });

  it("el IV Rank REAL de Tastytrade manda sobre el historial y el proxy", () => {
    // Hay 60 días de historia (que normalmente ganaría), pero Tastytrade la desplaza.
    const ivHistory = Array.from({ length: 60 }, (_, i) => ({ date: `d${i}`, avgIv: 30 + i }));
    const s = ivContextScore({ rows: [row({ iv: 0.60 })], closes, ivHistory, tastytradeIvRank: 22 });
    expect(s.rank.source).toBe("tastytrade");
    expect(s.rank.value).toBe(22);
    // 22 cae en la banda 16-30 (comprimida) → 10 pts.
    expect(s.rank.points).toBe(10);
    expect(s.regime).toBe("compresion");
  });

  it("Tastytrade se recorta a 0-100 y con null NO afecta (cae al proxy)", () => {
    const over = ivContextScore({ rows: [row({ iv: 0.5 })], closes, tastytradeIvRank: 150 });
    expect(over.rank.value).toBe(100);
    const nul = ivContextScore({ rows: [row({ iv: 0.5 })], closes, tastytradeIvRank: null });
    expect(nul.rank.source).toBe("realized-proxy");
  });

  it("con poca historia de IV se queda con el proxy", () => {
    const ivHistory = Array.from({ length: 10 }, (_, i) => ({ date: `d${i}`, avgIv: 40 + i }));
    const s = ivContextScore({ rows: [row({ iv: 0.5 })], closes, ivHistory });
    expect(s.rank.source).toBe("realized-proxy");
  });

  it("IV >100% marca régimen inflado", () => {
    const s = ivContextScore({ rows: [row({ iv: 1.4 })], closes });
    expect(s.iv.special).toBe(true);
    expect(s.regime).toBe("inflada");
    expect(s.note).toContain("IV crush");
  });

  it("el score es el promedio de los dos parámetros", () => {
    const ivHistory = Array.from({ length: 60 }, (_, i) => ({ date: `d${i}`, avgIv: 40 + i }));
    const s = ivContextScore({ rows: [row({ iv: 0.85 })], closes, ivHistory });
    expect(s.iv.points).toBe(8); // 85% → 61-89%
    expect(s.score).toBe(Math.round((s.iv.points + s.rank.points) / 2));
  });

  it("el score nunca se sale de 0-10", () => {
    for (const iv of [0.05, 0.35, 0.45, 0.65, 0.85, 1.5]) {
      const s = ivContextScore({ rows: [row({ iv })], closes });
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(10);
    }
  });

  describe("IV de la cadena completa (chainIv)", () => {
    const chainIv = {
      current: 47.0, // % — de TODA la cadena
      byExpiration: [
        { expiration: "2026-07-31", dte: 4, contracts: 120, avgIv: 46, maxIv: 88, premium: 5_000_000 },
        { expiration: "2026-08-21", dte: 25, contracts: 200, avgIv: 42, maxIv: 70, premium: 9_000_000 },
      ],
    };

    it("cuando viene chainIv, la IV actual y byExpiration salen de la cadena, no de los trades", () => {
      const s = ivContextScore({
        rows: [row({ iv: 0.90, premium: 5_000_000 })], // el trade diría 90%
        closes,
        chainIv,
      });
      expect(s.iv.source).toBe("chain");
      expect(s.iv.current).toBeCloseTo(47, 6); // manda la cadena, no el 90% del trade
      expect(s.iv.points).toBe(10); // 40-60% — la zona buena
      expect(s.byExpiration).toHaveLength(2);
      expect(s.byExpiration[0].expiration).toBe("2026-07-31");
      // los topContracts siguen siendo los trades reales
      expect(s.topContracts).toHaveLength(1);
      expect(s.topContracts[0].iv).toBeCloseTo(90, 6);
    });

    it("produce reporte aun sin trades, si hay IV de cadena", () => {
      const s = ivContextScore({ rows: [], closes, chainIv });
      expect(s.iv.source).toBe("chain");
      expect(s.iv.current).toBeCloseTo(47, 6);
      expect(s.iv.contracts).toBe(0); // no hubo trades
      expect(s.iv.simpleAvg).toBeNull();
      expect(s.topContracts).toEqual([]);
    });

    it("sin chainIv usable cae a los trades (comportamiento previo)", () => {
      const s = ivContextScore({
        rows: [row({ iv: 0.50 })],
        closes,
        chainIv: { current: null, byExpiration: [] },
      });
      expect(s.iv.source).toBe("trades");
      expect(s.iv.current).toBeCloseTo(50, 1);
    });
  });
});
