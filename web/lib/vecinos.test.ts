import { describe, expect, it } from "vitest";
import {
  BREAKOUT_DISCOUNT,
  MAX_BREAKOUT_TARGETS,
  MAX_TOWARD_TARGETS,
  NEGATIVE_GAMMA_DISCOUNT,
  PROB_MAX,
  PROB_MIN,
  SIBLING_BOOST,
  SIBLING_PENALTY,
  buildVecinos,
  netPremiumByStrike,
  percentile,
  type StrikeNetPremium,
} from "./vecinos";
import type { Chain2Contract } from "./optionChain2";
import type { FlowRow } from "./flow";

// ---------------------------------------------------------------------------
// Ayudas para armar cadenas y flujo de laboratorio
// ---------------------------------------------------------------------------

const EXP = "2026-08-17";

function contract(
  type: "call" | "put",
  strike: number,
  gamma: number,
  openInterest: number,
  extra: Partial<Chain2Contract> = {},
): Chain2Contract {
  return {
    symbol: `T${EXP}${type}${strike}`,
    type,
    strike,
    expiration: EXP,
    bid: 1, ask: 1.1, mid: 1.05,
    delta: type === "call" ? 0.4 : -0.4,
    gamma,
    theta: -0.5,
    vega: 0.1,
    iv: 0.16,
    openInterest,
    volume: 100,
    premiumTraded: 0,
    lastPrice: 1.05,
    ...extra,
  };
}

/**
 * Cadena simétrica de strikes 90..110 (paso 1) con gamma/OI planos, y un pico de
 * gamma×OI en `magnetStrike` para que el imán caiga ahí de forma inequívoca.
 */
function chain(magnetStrike: number, magnetSide: "call" | "put" = "call"): Chain2Contract[] {
  const out: Chain2Contract[] = [];
  for (let k = 90; k <= 110; k++) {
    const isMagnet = k === magnetStrike;
    out.push(contract("call", k, 0.01, isMagnet && magnetSide === "call" ? 100_000 : 100));
    out.push(contract("put", k, 0.01, isMagnet && magnetSide === "put" ? 100_000 : 100));
  }
  return out;
}

function flowOf(entries: Record<number, Partial<StrikeNetPremium>>): Map<number, StrikeNetPremium> {
  const m = new Map<number, StrikeNetPremium>();
  for (const [k, v] of Object.entries(entries)) {
    m.set(Number(k), { call: v.call ?? 0, put: v.put ?? 0, trades: v.trades ?? 1 });
  }
  return m;
}

// IV/horizonte holgados a propósito: con una σ diminuta TODAS las probabilidades
// caerían en el recorte de PROB_MIN y las pruebas de los multiplicadores no
// medirían nada. Los casos de recorte se prueban aparte.
const BASE = { spot: 100, iv: 0.6, horizonDays: 1 };

/** Recorte de dos lados del Paso 5, para escribir las expectativas sin repetirlo. */
const clamp = (p: number) => Math.min(PROB_MAX, Math.max(PROB_MIN, p));

function row(over: Partial<FlowRow>): FlowRow {
  return {
    id: 1, symbol: "X", underlying: "X", type: "call", strike: 100, expiration: EXP,
    dte: 0, price: 1, size: 10, side: "ASKSIDE", aggression: "ask", assetPrice: 100,
    bid: 0.9, ask: 1.1, premium: 10_000, delta: 0.5, gamma: 0.01, theta: -1, vega: 0.1,
    thetaPctDaily: 1, iv: 0.2, openInterest: 100, volume: 10, score: 0, sentiment: "",
    timestamp: "2026-08-17T14:00:00Z", conditionCode: null, conditionName: null,
    flags: {
      big: false, convDelta: false, aboveAsk: false, belowBid: false, mid: false,
      leap: false, repeated: false, multileg: false, simultaneous: false, exceededOI: false,
    },
    scores: { volume: 0, timing: 0, repetition: 0, total: 0 },
    unusual: false, interesting: false, expiryStatus: "expira_hoy",
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("percentile", () => {
  it("interpola el percentil 70 de una serie conocida", () => {
    // 0..10 → p70 = 7
    expect(percentile([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.7)).toBeCloseTo(7, 6);
  });

  it("devuelve 0 con la lista vacía y el único valor con un elemento", () => {
    expect(percentile([], 0.7)).toBe(0);
    expect(percentile([42], 0.7)).toBe(42);
  });
});

describe("netPremiumByStrike", () => {
  it("suma el ASK en positivo y el BID en negativo por strike y tipo", () => {
    const m = netPremiumByStrike(
      [
        row({ type: "call", strike: 105, aggression: "ask", premium: 50_000 }),
        row({ type: "call", strike: 105, aggression: "bid", premium: 20_000 }),
        row({ type: "put", strike: 95, aggression: "bid", premium: 30_000 }),
      ],
      EXP,
    );
    expect(m.get(105)).toEqual({ call: 30_000, put: 0, trades: 2 });
    expect(m.get(95)).toEqual({ call: 0, put: -30_000, trades: 1 });
  });

  it("ignora los MID y los agresores desconocidos", () => {
    const m = netPremiumByStrike(
      [
        row({ strike: 100, aggression: "mid", premium: 99_000 }),
        row({ strike: 100, aggression: "unknown", premium: 99_000 }),
      ],
      EXP,
    );
    expect(m.size).toBe(0);
  });

  it("ignora los trades de OTRO vencimiento", () => {
    const m = netPremiumByStrike([row({ strike: 100, expiration: "2026-09-18" })], EXP);
    expect(m.size).toBe(0);
  });
});

describe("Paso 1 — la dirección la fija el imán del GEX", () => {
  it("imán ARRIBA del spot → sesgo CALL", () => {
    const s = buildVecinos({ ...BASE, contracts: chain(105), flow: flowOf({}) });
    expect(s.magnet).toBe(105);
    expect(s.direction).toBe("call");
  });

  it("imán ABAJO del spot → sesgo PUT", () => {
    const s = buildVecinos({ ...BASE, contracts: chain(95, "put"), flow: flowOf({}) });
    expect(s.magnet).toBe(95);
    expect(s.direction).toBe("put");
  });

  it("imán en el MISMO strike de la grilla que el spot → LATERAL, sin targets", () => {
    const s = buildVecinos({ ...BASE, contracts: chain(100), flow: flowOf({ 105: { call: 1e6 } }) });
    expect(s.spotStrike).toBe(100);
    expect(s.direction).toBe("lateral");
    expect(s.decision).toBe("lateral");
    expect(s.towardTargets).toHaveLength(0);
    expect(s.breakoutTargets).toHaveLength(0);
  });

  it("compara contra la GRILLA REAL: un spot entre strikes se ancla al más cercano", () => {
    // Grilla de paso 1; spot 100.3 → strike de referencia 100, imán en 100 → lateral.
    const s = buildVecinos({ ...BASE, spot: 100.3, contracts: chain(100), flow: flowOf({}) });
    expect(s.spotStrike).toBe(100);
    expect(s.direction).toBe("lateral");
  });

  it("sin gamma real utilizable no hay imán y avisa", () => {
    const flat = [contract("call", 100, 0, 0), contract("put", 100, 0, 0)];
    const s = buildVecinos({ ...BASE, contracts: flat, flow: flowOf({}) });
    expect(s.magnet).toBeNull();
    expect(s.direction).toBe("lateral");
    expect(s.warnings.join(" ")).toMatch(/no se puede fijar un imán/i);
  });
});

describe("Paso 2 — clasificación del vecindario con net premium real", () => {
  it("fusiona las cuatro lecturas en un netBias único", () => {
    const s = buildVecinos({
      ...BASE,
      contracts: chain(105),
      flow: flowOf({
        101: { call: 40_000 },   // compra de calls → alcista
        102: { put: -30_000 },   // venta de puts → soporte (alcista)
        103: { put: 50_000 },    // compra de puts → bajista
        104: { call: -20_000 },  // venta de calls → resistencia (bajista)
      }),
    });
    const by = new Map(s.neighbors.map((n) => [n.strike, n]));
    expect(by.get(101)!.netBias).toBe(40_000);
    expect(by.get(102)!.netBias).toBe(30_000);
    expect(by.get(103)!.netBias).toBe(-50_000);
    expect(by.get(104)!.netBias).toBe(-20_000);
    expect(by.get(101)!.source).toBe("flujo");
  });

  it("un strike con compra de calls Y compra de puts se cancela hacia el lado dominante", () => {
    const s = buildVecinos({
      ...BASE, contracts: chain(105), flow: flowOf({ 101: { call: 30_000, put: 50_000 } }),
    });
    const n = s.neighbors.find((x) => x.strike === 101)!;
    expect(n.bullForce).toBe(30_000);
    expect(n.bearForce).toBe(50_000);
    expect(n.netBias).toBe(-20_000);
  });

  it("toma 10 strikes por lado del spot", () => {
    const s = buildVecinos({ ...BASE, contracts: chain(105), flow: flowOf({}) });
    expect(s.neighbors.filter((n) => n.strike <= 100)).toHaveLength(10);
    expect(s.neighbors.filter((n) => n.strike > 100)).toHaveLength(10);
  });
});

describe("Paso 2b — respaldo estructural (OI × gamma real)", () => {
  /**
   * Cadena con paredes de posicionamiento y SIN flujo, para forzar el 2b. El OI de
   * fondo es ASIMÉTRICO a propósito (120 calls vs 100 puts) para que el ruido tenga
   * posicionamiento neto ≠ 0 y el piso del TOP 30% tenga algo real que filtrar.
   */
  function structural(): Chain2Contract[] {
    const out: Chain2Contract[] = [];
    for (let k = 90; k <= 110; k++) {
      // Pared de calls arriba (106) y de puts abajo (94); el resto, ruido de OI bajo.
      out.push(contract("call", k, 0.01, k === 106 ? 80_000 : 120));
      out.push(contract("put", k, 0.01, k === 94 ? 60_000 : 100));
    }
    // Imán claro arriba para dar dirección CALL.
    out.push(contract("call", 105, 0.05, 200_000));
    return out;
  }

  it("clasifica por la DOMINANCIA call/put del propio strike", () => {
    const s = buildVecinos({ ...BASE, contracts: structural(), flow: flowOf({}) });
    const by = new Map(s.neighbors.map((n) => [n.strike, n]));
    expect(by.get(106)!.source).toBe("estructura");
    expect(by.get(106)!.netBias).toBeLessThan(0); // predominan calls = resistencia
    expect(by.get(94)!.source).toBe("estructura");
    expect(by.get(94)!.netBias).toBeGreaterThan(0); // predominan puts = soporte
  });

  it("el piso del TOP 30% impide que el OI de ruido confirme nada", () => {
    const s = buildVecinos({ ...BASE, contracts: structural(), flow: flowOf({}) });
    const noise = s.neighbors.filter((n) => ![106, 94, 105].includes(n.strike));
    // El ruido tiene posicionamiento neto ≠ 0 (−0.2) y aun así queda descartado.
    expect(noise.every((n) => n.netGammaOi !== 0)).toBe(true);
    expect(noise.every((n) => n.source === "ninguna")).toBe(true);
  });

  it("un strike con MUCHO OI en calls Y en puts se cancela: no tiene lado", () => {
    const out = structural();
    out.push(contract("call", 102, 0.01, 100_000));
    out.push(contract("put", 102, 0.01, 100_000));
    const s = buildVecinos({ ...BASE, contracts: out, flow: flowOf({}) });
    const n = s.neighbors.find((x) => x.strike === 102)!;
    expect(n.callGammaOi).toBeGreaterThan(900);
    expect(n.putGammaOi).toBeGreaterThan(900);
    expect(Math.abs(n.netGammaOi)).toBeLessThan(1); // se anulan
    expect(n.source).toBe("ninguna");
  });

  it("el flujo real SIEMPRE manda: con netBias ≠ 0 no se pisa con estructura", () => {
    // 106 tiene la pared de calls (bajista por estructura) pero hay compra real de calls.
    const s = buildVecinos({
      ...BASE, contracts: structural(), flow: flowOf({ 106: { call: 75_000 } }),
    });
    const n = s.neighbors.find((x) => x.strike === 106)!;
    expect(n.source).toBe("flujo");
    expect(n.netBias).toBe(75_000);
  });

  it("avisa cuando no hubo nada de net premium real en el vecindario", () => {
    const s = buildVecinos({ ...BASE, contracts: structural(), flow: flowOf({}) });
    expect(s.hasRealFlow).toBe(false);
    expect(s.warnings.join(" ")).toMatch(/Sin net premium real/i);
  });
});

describe("Paso 2b simétrico — el posicionamiento TAMBIÉN puede confirmar", () => {
  /**
   * Imán de calls arriba (106) → dirección CALL, y camino al imán un strike (103)
   * dominado por PUTS. Con la regla por posición respecto al spot ese strike sería
   * "resistencia" por estar arriba; con la regla por dominancia es SOPORTE y confirma.
   */
  function putWallAbove(): Chain2Contract[] {
    const out: Chain2Contract[] = [];
    for (let k = 90; k <= 110; k++) {
      out.push(contract("call", k, 0.01, k === 106 ? 300_000 : 120));
      out.push(contract("put", k, 0.01, k === 103 ? 90_000 : 100));
    }
    return out;
  }

  it("un muro de PUTS por ENCIMA del spot confirma un sesgo CALL", () => {
    const s = buildVecinos({ ...BASE, contracts: putWallAbove(), flow: flowOf({}) });
    expect(s.direction).toBe("call");
    const n = s.neighbors.find((x) => x.strike === 103)!;
    expect(n.source).toBe("estructura");
    expect(n.netBias).toBeGreaterThan(0); // soporte, pese a estar por encima del spot
    expect(s.confirmations).toEqual({ flow: 0, structural: 1 });
    expect(s.decision).toBe("entrar");
    expect(s.towardTargets.map((t) => t.strike)).toEqual([103, 106]);
  });

  it("entrar solo por posicionamiento avisa de que es una señal más débil", () => {
    const s = buildVecinos({ ...BASE, contracts: putWallAbove(), flow: flowOf({}) });
    expect(s.warnings.join(" ")).toMatch(/SOLO del posicionamiento/i);
  });

  it("con dinero real en ese mismo strike, el aviso desaparece", () => {
    const s = buildVecinos({
      ...BASE, contracts: putWallAbove(), flow: flowOf({ 103: { call: 40_000 } }),
    });
    expect(s.confirmations).toEqual({ flow: 1, structural: 0 });
    expect(s.warnings.join(" ")).not.toMatch(/SOLO del posicionamiento/i);
  });

  it("un muro de CALLS por DEBAJO del spot confirma un sesgo PUT", () => {
    const out: Chain2Contract[] = [];
    for (let k = 90; k <= 110; k++) {
      out.push(contract("call", k, 0.01, k === 97 ? 90_000 : 100));
      out.push(contract("put", k, 0.01, k === 94 ? 300_000 : 120));
    }
    const s = buildVecinos({ ...BASE, contracts: out, flow: flowOf({}) });
    expect(s.direction).toBe("put"); // imán de puts en 94, por debajo del spot
    const n = s.neighbors.find((x) => x.strike === 97)!;
    expect(n.source).toBe("estructura");
    expect(n.netBias).toBeLessThan(0); // resistencia, pese a estar por debajo del spot
    expect(s.confirmations.structural).toBe(1);
    expect(s.decision).toBe("entrar");
  });
});

describe("Paso 3 — targets hacia el imán", () => {
  it("junta hasta 3 confirmados y añade el imán SIEMPRE como último target", () => {
    const s = buildVecinos({
      ...BASE,
      contracts: chain(108),
      flow: flowOf({
        101: { call: 10_000 }, 102: { call: 20_000 },
        103: { call: 30_000 }, 104: { call: 40_000 }, // el 4º ya no entra
      }),
    });
    expect(s.towardTargets.map((t) => t.strike)).toEqual([101, 102, 103, 108]);
    expect(s.towardTargets.at(-1)!.kind).toBe("iman");
    expect(s.towardTargets.filter((t) => t.kind === "hacia_iman")).toHaveLength(MAX_TOWARD_TARGETS);
  });

  it("solo cuenta el netBias del MISMO signo que la dirección", () => {
    const s = buildVecinos({
      ...BASE,
      contracts: chain(108),
      flow: flowOf({ 101: { put: 50_000 }, 102: { call: 20_000 } }), // 101 es bajista
    });
    expect(s.towardTargets.map((t) => t.strike)).toEqual([102, 108]);
  });

  it("el imán se añade aunque ningún vecino confirme", () => {
    const s = buildVecinos({ ...BASE, contracts: chain(105), flow: flowOf({}) });
    expect(s.towardTargets).toHaveLength(1);
    expect(s.towardTargets[0].kind).toBe("iman");
    expect(s.towardTargets[0].strike).toBe(105);
  });
});

describe("Paso 4 — targets de ruptura", () => {
  it("junta hasta 4 strikes del lado OPUESTO que confirman la dirección contraria", () => {
    const s = buildVecinos({
      ...BASE,
      contracts: chain(105),
      flow: flowOf({
        99: { put: 10_000 }, 98: { put: 20_000 }, 97: { put: 30_000 },
        96: { put: 40_000 }, 95: { put: 50_000 }, // el 5º ya no entra
      }),
    });
    expect(s.breakoutTargets.map((t) => t.strike)).toEqual([99, 98, 97, 96]);
    expect(s.breakoutTargets).toHaveLength(MAX_BREAKOUT_TARGETS);
    expect(s.breakoutTargets.every((t) => t.kind === "ruptura")).toBe(true);
  });

  it("un strike alcista del lado opuesto NO cuenta como ruptura", () => {
    const s = buildVecinos({
      ...BASE, contracts: chain(105), flow: flowOf({ 99: { call: 40_000 } }),
    });
    expect(s.breakoutTargets).toHaveLength(0);
  });
});

describe("Paso 5 — probabilidades", () => {
  it("nunca devuelve 0%: imán lejísimos con el horizonte al mínimo → piso 3%", () => {
    const s = buildVecinos({ ...BASE, contracts: chain(110), horizonDays: 1 / 390, flow: flowOf({}) });
    const t = s.towardTargets.at(-1)!;
    expect(t.baseProbability).toBeLessThan(1e-6); // la estadística pura daría ~0
    expect(t.probability).toBe(PROB_MIN);
  });

  it("nunca devuelve 100%: imán pegado con IV enorme → techo 95%", () => {
    const s = buildVecinos({
      ...BASE, contracts: chain(101), iv: 3, horizonDays: 5, flow: flowOf({ 101: { call: 1e6 } }),
    });
    const t = s.towardTargets.at(-1)!;
    expect(t.baseProbability * 1.25).toBeGreaterThan(PROB_MAX);
    expect(t.probability).toBe(PROB_MAX);
  });

  it("más agresividad en el strike → más probabilidad que un vecino equivalente", () => {
    const s = buildVecinos({
      ...BASE,
      contracts: chain(108),
      flow: flowOf({ 101: { call: 5_000 }, 102: { call: 500_000 } }),
    });
    const t101 = s.towardTargets.find((t) => t.strike === 101)!;
    const t102 = s.towardTargets.find((t) => t.strike === 102)!;
    // 102 está MÁS lejos (menos probable por estadística) pero su flujo es máximo.
    expect(t101.baseProbability).toBeGreaterThan(t102.baseProbability);
    expect(t102.probability / t102.baseProbability).toBeGreaterThan(
      t101.probability / t101.baseProbability,
    );
  });

  it("los targets de RUPTURA llevan el descuento ×0.65", () => {
    const s = buildVecinos({
      ...BASE, contracts: chain(105), flow: flowOf({ 99: { put: 40_000 } }),
    });
    const t = s.breakoutTargets[0];
    // Único strike con flujo → agresividad 1 → factor de flujo = 1.25.
    expect(t.probability).toBeCloseTo(t.baseProbability * 1.25 * BREAKOUT_DISCOUNT, 6);
  });

  it("en régimen γ− los targets hacia el imán llevan el descuento ×0.75", () => {
    // Imán en un strike de PUTS por debajo → GEX total negativo (γ−).
    const s = buildVecinos({
      ...BASE, contracts: chain(95, "put"), flow: flowOf({ 99: { put: 40_000 } }),
    });
    expect(s.regime).toBe("negative");
    const t = s.towardTargets.find((x) => x.strike === 99)!;
    expect(t.probability).toBeCloseTo(t.baseProbability * 1.25 * NEGATIVE_GAMMA_DISCOUNT, 6);
  });
});

describe("Paso 6 — decisión final", () => {
  it("entrar: al menos un strike confirmó hacia el imán", () => {
    const s = buildVecinos({
      ...BASE, contracts: chain(105), flow: flowOf({ 102: { call: 40_000 } }),
    });
    expect(s.decision).toBe("entrar");
    expect(s.confirmations.flow).toBe(1);
  });

  it("esperar_breakout: hay imán pero ningún vecino lo confirma", () => {
    const s = buildVecinos({
      ...BASE, contracts: chain(105), flow: flowOf({ 99: { put: 40_000 } }),
    });
    expect(s.direction).toBe("call");
    expect(s.decision).toBe("esperar_breakout");
    expect(s.confirmations).toEqual({ flow: 0, structural: 0 });
  });

  it("lateral: el imán está pegado al spot", () => {
    const s = buildVecinos({ ...BASE, contracts: chain(100), flow: flowOf({}) });
    expect(s.decision).toBe("lateral");
  });

  it("una pared de CALLS camino al imán no confirma: es resistencia, no soporte", () => {
    const out: Chain2Contract[] = [];
    for (let k = 90; k <= 110; k++) {
      out.push(contract("call", k, 0.01, k === 103 ? 80_000 : 120)); // resistencia camino al imán
      out.push(contract("put", k, 0.01, k === 97 ? 80_000 : 100));   // soporte del lado opuesto
    }
    out.push(contract("call", 105, 0.05, 200_000)); // imán arriba → dirección CALL
    const s = buildVecinos({ ...BASE, contracts: out, flow: flowOf({}) });

    expect(s.direction).toBe("call");
    const w103 = s.neighbors.find((n) => n.strike === 103)!;
    expect(w103.source).toBe("estructura");
    expect(w103.netBias).toBeLessThan(0);
    expect(s.confirmations).toEqual({ flow: 0, structural: 0 });
    expect(s.decision).toBe("esperar_breakout");
    // El soporte de puts en 97 tampoco es ruptura: la ruptura exige sesgo BAJISTA
    // por debajo del spot, y un soporte es alcista.
    expect(s.breakoutTargets).toHaveLength(0);
  });
});

describe("EXTRA — confirmación cruzada del índice hermano", () => {
  const contracts = chain(105);

  it("si coincide y NO había otra confirmación, sube la entrada ×1.15", () => {
    const s = buildVecinos({
      ...BASE, contracts, flow: flowOf({}), sibling: { symbol: "SPX", direction: "call" },
    });
    expect(s.confirmations.flow + s.confirmations.structural).toBe(0);
    expect(s.sibling).toMatchObject({ effect: "confirma", factor: SIBLING_BOOST });
    const t = s.towardTargets[0];
    // El propio imán es una pared de calls, así que el Paso 2b lo clasifica y es el
    // único strike estructural del vecindario → agresividad 1 → factor de flujo 1.25.
    expect(t.probability).toBeCloseTo(clamp(t.baseProbability * 1.25 * SIBLING_BOOST), 6);
  });

  it("si coincide pero YA había una pared confirmada, no aplica el boost", () => {
    const s = buildVecinos({
      ...BASE, contracts, flow: flowOf({ 102: { call: 40_000 } }),
      sibling: { symbol: "SPX", direction: "call" },
    });
    expect(s.sibling).toMatchObject({ effect: "confirma", factor: 1 });
  });

  it("si contradice, descuenta ×0.6 y avisa", () => {
    const s = buildVecinos({
      ...BASE, contracts, flow: flowOf({ 102: { call: 40_000 } }),
      sibling: { symbol: "SPX", direction: "put" },
    });
    expect(s.sibling).toMatchObject({ effect: "contradice", factor: SIBLING_PENALTY });
    expect(s.warnings.join(" ")).toMatch(/en contra del imán/i);
    const t = s.towardTargets.find((x) => x.strike === 102)!;
    expect(t.probability).toBeCloseTo(clamp(t.baseProbability * 1.25 * SIBLING_PENALTY), 6);
  });

  it("el descuento del hermano NO toca los targets de ruptura", () => {
    const s = buildVecinos({
      ...BASE, contracts, flow: flowOf({ 102: { call: 40_000 }, 99: { put: 40_000 } }),
      sibling: { symbol: "SPX", direction: "put" },
    });
    const b = s.breakoutTargets[0];
    expect(b.probability).toBeCloseTo(b.baseProbability * 1.25 * BREAKOUT_DISCOUNT, 6);
  });
});
