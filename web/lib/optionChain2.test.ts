import { describe, it, expect } from "vitest";
import {
  normalizeChain2,
  normalizeChain2Contract,
  gexByStrike,
  totalGex,
  nearestExpirations,
  expirationsInDteWindow,
  realGreeksMap,
  chainIvSurface,
  type Chain2RawContract,
} from "./optionChain2";

// Subconjunto real del payload de MSFT (option_chain_extended, exp 2026-07-27).
const FIXTURE: Chain2RawContract[] = [
  {
    exercise_style: "american",
    expiration: "2026-07-27",
    greeks: { delta: 0.6216596, gamma: 0.26536152, theta: -1.5797957, vega: 0.0342133 },
    implied_volatility: 0.16796059,
    last_quote: { ask: 0.89, bid: 0.77, mid: 0.83 },
    open_interest: 2464,
    premium_traded: 4804617,
    price: 0.82,
    strike: 390.0,
    symbol: "MSFT260727C00390000",
    type: "call",
    volume: 19185,
  },
  {
    exercise_style: "american",
    expiration: "2026-07-27",
    greeks: { delta: -0.38051692, gamma: 0.26143341, theta: -1.5817031, vega: 0.0342155 },
    implied_volatility: 0.17075927,
    last_quote: { ask: 0.42, bid: 0.37, mid: 0.395 },
    open_interest: 332,
    premium_traded: 2646575,
    price: 0.37,
    strike: 390.0,
    symbol: "MSFT260727P00390000",
    type: "put",
    volume: 29364,
  },
  {
    // greeks vacío + IV null (deep OTM sin datos) → todo a null, pero sigue siendo contrato válido.
    exercise_style: "american",
    expiration: "2026-07-27",
    greeks: {},
    implied_volatility: null,
    last_quote: { ask: 5.8, bid: 4.9, mid: 5.35 },
    open_interest: 1949,
    premium_traded: 1115378,
    price: 5.55,
    strike: 385.0,
    symbol: "MSFT260727C00385000",
    type: "call",
    volume: 1605,
  },
];

describe("normalizeChain2Contract", () => {
  it("mapea nombres cortos y conserva el delta firmado", () => {
    const c = normalizeChain2Contract(FIXTURE[0]);
    expect(c.symbol).toBe("MSFT260727C00390000");
    expect(c.type).toBe("call");
    expect(c.strike).toBe(390);
    expect(c.mid).toBeCloseTo(0.83);
    expect(c.delta).toBeCloseTo(0.6216596);
    expect(c.iv).toBeCloseTo(0.16796059);
    expect(c.openInterest).toBe(2464);
  });

  it("mantiene el signo negativo del delta en puts", () => {
    const p = normalizeChain2Contract(FIXTURE[1]);
    expect(p.delta).toBeLessThan(0);
    expect(p.delta).toBeCloseTo(-0.38051692);
  });

  it("saneo a null cuando greeks es {} e IV es null", () => {
    const c = normalizeChain2Contract(FIXTURE[2]);
    expect(c.delta).toBeNull();
    expect(c.gamma).toBeNull();
    expect(c.iv).toBeNull();
    // pero los quotes y OI siguen presentes
    expect(c.mid).toBeCloseTo(5.35);
    expect(c.openInterest).toBe(1949);
  });
});

describe("normalizeChain2", () => {
  it("normaliza el array completo", () => {
    const out = normalizeChain2(FIXTURE);
    expect(out).toHaveLength(3);
  });

  it("es tolerante a entradas basura", () => {
    const dirty = [...FIXTURE, null, { symbol: "X" }, {}] as unknown as Chain2RawContract[];
    const out = normalizeChain2(dirty);
    expect(out).toHaveLength(3); // descarta las 3 basura (sin strike numérico)
  });
});

describe("gexByStrike", () => {
  const spot = 390.5;

  it("resta la gamma de puts y suma la de calls (GEX neto por strike)", () => {
    const contracts = normalizeChain2(FIXTURE);
    const strikes = gexByStrike(contracts, spot);
    // strike 390 tiene call + put; strike 385 tiene el call de greeks vacío (gamma null → ignorado)
    const s390 = strikes.find((s) => s.strike === 390);
    expect(s390).toBeDefined();
    const factor = 100 * spot * spot * 0.01;
    const expectedCall = 0.26536152 * 2464 * factor;
    const expectedPut = 0.26143341 * 332 * factor;
    expect(s390!.gex).toBeCloseTo(expectedCall - expectedPut, 0);
  });

  it("ignora contratos con gamma null u OI cero", () => {
    const contracts = normalizeChain2(FIXTURE);
    const strikes = gexByStrike(contracts, spot);
    // el strike 385 (greeks vacío → gamma null) no debe aparecer
    expect(strikes.find((s) => s.strike === 385)).toBeUndefined();
  });

  it("devuelve vacío si el spot no es válido", () => {
    expect(gexByStrike(normalizeChain2(FIXTURE), 0)).toEqual([]);
  });

  it("totalGex suma todos los strikes", () => {
    const strikes = gexByStrike(normalizeChain2(FIXTURE), spot);
    expect(totalGex(strikes)).toBeCloseTo(strikes.reduce((s, x) => s + x.gex, 0));
  });
});

describe("realGreeksMap", () => {
  it("indexa por strike|expiration|type con gamma e IV reales", () => {
    const map = realGreeksMap(normalizeChain2(FIXTURE));
    expect(map["390|2026-07-27|call"]).toEqual({ gamma: 0.26536152, iv: 0.16796059 });
    expect(map["390|2026-07-27|put"].gamma).toBeCloseTo(0.26143341);
    expect(map["390|2026-07-27|put"].iv).toBeCloseTo(0.17075927);
  });

  it("descarta contratos sin gamma ni IV (greeks vacío + IV null)", () => {
    const map = realGreeksMap(normalizeChain2(FIXTURE));
    // el strike 385 tiene greeks:{} e IV null → no entra al mapa
    expect(map["385|2026-07-27|call"]).toBeUndefined();
    expect(Object.keys(map)).toHaveLength(2);
  });
});

describe("chainIvSurface", () => {
  // now ANTES del vencimiento (DTE 7): el 0DTE se descarta a propósito, así que
  // la superficie necesita que el fixture (exp 2026-07-27) esté en el futuro.
  const now = new Date("2026-07-20T15:00:00Z");

  it("IV en % ponderada por prima abierta (OI × mid) sobre TODA la cadena", () => {
    const surface = chainIvSurface(normalizeChain2(FIXTURE), now);
    // solo los dos contratos con IV (el 385C tiene IV null → fuera).
    // pesos: 390C = 2464×0.83, 390P = 332×0.395; el call domina → cerca de 16.8%.
    expect(surface.current).not.toBeNull();
    expect(surface.current!).toBeGreaterThan(16.7);
    expect(surface.current!).toBeLessThan(17.1);
  });

  it("agrupa por vencimiento con IV en porcentaje y DTE calculado", () => {
    const surface = chainIvSurface(normalizeChain2(FIXTURE), now);
    expect(surface.byExpiration).toHaveLength(1);
    const exp = surface.byExpiration[0];
    expect(exp.expiration).toBe("2026-07-27");
    expect(exp.dte).toBe(7);
    expect(exp.contracts).toBe(2); // el 385C sin IV no cuenta
    expect(exp.avgIv).toBeCloseTo((16.796059 + 17.075927) / 2, 3);
  });

  it("cadena sin IV → superficie vacía", () => {
    const noIv = normalizeChain2([FIXTURE[2]]); // solo el 385C con IV null
    const surface = chainIvSurface(noIv, now);
    expect(surface.current).toBeNull();
    expect(surface.byExpiration).toEqual([]);
  });
});

describe("selección de vencimientos", () => {
  // Muestra real de /api/assets/MSFT/expirations.
  const DATES = [
    "2026-07-27", "2026-07-31", "2026-08-03", "2026-08-05", "2026-08-07",
    "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-18", "2026-12-18",
    "2027-01-15",
  ];
  const now = new Date("2026-07-27T15:00:00Z");

  it("nearestExpirations toma las N más cercanas no expiradas", () => {
    const out = nearestExpirations(DATES, 3, now);
    expect(out).toEqual(["2026-07-27", "2026-07-31", "2026-08-03"]);
  });

  it("nearestExpirations descarta fechas ya vencidas (DTE < 0)", () => {
    const past = new Date("2026-08-10T00:00:00Z");
    const out = nearestExpirations(DATES, 2, past);
    expect(out).toEqual(["2026-08-14", "2026-08-21"]);
  });

  it("expirationsInDteWindow filtra por ventana DTE inclusive (credit spreads 4-8)", () => {
    const out = expirationsInDteWindow(DATES, 4, 8, now);
    // desde 2026-07-27: +4=07-31, +7=08-03, +9=08-05(fuera). Ventana [4,8] → 07-31, 08-03
    expect(out).toEqual(["2026-07-31", "2026-08-03"]);
  });

  it("expirationsInDteWindow vacío si nada cae en la ventana", () => {
    expect(expirationsInDteWindow(DATES, 400, 500, now)).toEqual([]);
  });
});
