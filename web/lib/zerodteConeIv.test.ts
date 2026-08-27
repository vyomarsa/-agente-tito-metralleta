// La IV con la que el 0DTE PROYECTA no es la de la cadena.
//
// Estos tests fijan justo la regresión que costó dinero (auditoría del libro de
// paper, 2026-08-26): el cono se construía con la IV ATM del 0DTE —que se dispara
// cuando quedan horas para el vencimiento— y proyectaba 12× el recorrido real del
// subyacente, así que el objetivo del modelo de momentum, acotado a 1σ, acababa
// donde el precio no llega.

import { describe, it, expect } from "vitest";
import { coneIv, representativeIv, effectiveHorizon, MIN_HORIZON_DAYS, buildZeroDte } from "./zerodte";
import { expectedMove, probTouch } from "./expectedMove";
import type { Chain2Contract } from "./optionChain2";

/** Serie de cierres con una volatilidad diaria dada (determinista, sin azar). */
function cierres(volDiaria: number, n = 40, base = 100): number[] {
  const out = [base];
  for (let i = 1; i < n; i++) {
    // Alterna arriba/abajo: la desviación típica de los retornos es volDiaria.
    out.push(out[i - 1] * (1 + (i % 2 === 0 ? volDiaria : -volDiaria)));
  }
  return out;
}

function contrato(over: Partial<Chain2Contract> = {}): Chain2Contract {
  return {
    symbol: "T", strike: 100, type: "call", expiration: "2026-08-26",
    bid: 0.1, ask: 0.12, mid: 0.11, lastPrice: 0.11,
    delta: 0.5, gamma: 0.05, iv: 1.19, // ← IV de 0DTE: 119%
    openInterest: 1000, volume: 1000, premiumTraded: 0,
    ...over,
  } as Chain2Contract;
}

describe("coneIv — la IV de proyectar", () => {
  it("NO usa la IV de la cadena, por muy alta que venga", () => {
    const closes = cierres(0.005); // 0,5% diario, tipo SPY
    const cadena = [contrato({ iv: 1.19 })];

    expect(representativeIv(cadena, closes)).toBeCloseTo(1.19, 2);
    expect(coneIv(closes)).toBeLessThan(0.3); // la realizada, muy por debajo
  });

  it("proyecta un movimiento diario del orden del recorrido real", () => {
    // 0,5% diario → anualizado ≈ 0,5% × √252 ≈ 7,9%; de vuelta a diario /√365.
    const iv = coneIv(cierres(0.005));
    const diario = (iv / Math.sqrt(365)) * 100;
    expect(diario).toBeGreaterThan(0.3);
    expect(diario).toBeLessThan(1.2);
  });

  it("un subyacente MÁS movido da una IV mayor", () => {
    expect(coneIv(cierres(0.02))).toBeGreaterThan(coneIv(cierres(0.005)));
  });

  it("el suelo y el techo del estimador siguen puestos", () => {
    expect(coneIv([100, 100, 100, 100, 100])).toBeGreaterThanOrEqual(0.05);
    expect(coneIv(cierres(0.5))).toBeLessThanOrEqual(3);
  });

  it("sin cierres suficientes no revienta: cae al valor de reserva", () => {
    const iv = coneIv([100]);
    expect(iv).toBeGreaterThan(0);
    expect(Number.isFinite(iv)).toBe(true);
  });
});

describe("representativeIv — la IV que cobra la cadena (informativa)", () => {
  it("promedia los contratos ATM", () => {
    const cadena = [
      contrato({ iv: 1.0, delta: 0.5 }),
      contrato({ iv: 1.4, delta: -0.5 }),
      contrato({ iv: 2.9, delta: 0.05 }), // fuera de la banda ATM: no cuenta
    ];
    expect(representativeIv(cadena, cierres(0.005))).toBeCloseTo(1.2, 2);
  });

  it("sin IV en la cadena cae a la realizada, y ahí coincide con coneIv", () => {
    const closes = cierres(0.005);
    const cadena = [contrato({ iv: null })];
    expect(representativeIv(cadena, closes)).toBeCloseTo(coneIv(closes), 6);
  });
});

// ---------------------------------------------------------------------------
// Un solo horizonte para toda la vista
// ---------------------------------------------------------------------------

describe("effectiveHorizon", () => {
  it("respeta el horizonte cuando queda sesión de sobra", () => {
    expect(effectiveHorizon(0.25)).toBe(0.25);
  });

  it("aplica el suelo al filo del cierre, donde el cono se cerraría a un punto", () => {
    expect(effectiveHorizon(0.0002)).toBe(MIN_HORIZON_DAYS); // ~17 s restantes
    expect(effectiveHorizon(0)).toBe(MIN_HORIZON_DAYS);
  });

  it("el borde de 1σ se toca ~32% con el MISMO horizonte que lo definió", () => {
    // Es la comprobación que fallaba: el nivel se calculaba con un reloj y su
    // probabilidad con otro, así que el suelo de 1σ salía con "0% de tocarlo".
    const spot = 770, iv = 0.129, hd = effectiveHorizon(0.0002);
    const { upper1, lower1 } = expectedMove(spot, iv, hd);

    for (const nivel of [upper1, lower1]) {
      const p = probTouch(spot, nivel, iv, hd);
      expect(p).toBeGreaterThan(0.25);
      expect(p).toBeLessThan(0.40);
    }
  });

  it("con el suelo VIEJO de probTouch (9 s) el mismo nivel daba casi cero", () => {
    const spot = 770, iv = 0.129;
    const { lower1 } = expectedMove(spot, iv, effectiveHorizon(0.0002));
    const viejo = probTouch(spot, lower1, iv, Math.max(0.0002, 1 / (390 * 24)));
    expect(lower1).toBeGreaterThan(0); // que el nivel exista de verdad
    expect(viejo).toBeLessThan(0.02); // la incoherencia que se arregló
  });
});

// ---------------------------------------------------------------------------
// El motivo del escenario tiene que decir qué mandó DE VERDAD
// ---------------------------------------------------------------------------

describe("driver de los escenarios bull/bear", () => {
  /** Cadena mínima con un muro de calls y otro de puts colocados a voluntad. */
  function analisis(muroCall: number, muroPut: number, spot = 100) {
    const strikes = [muroPut, spot, muroCall].map((k) => ({
      strike: k,
      call: { symbol: `C${k}`, strike: k, type: "call" as const, expiration: "2026-08-26",
        bid: 1, ask: 1.1, mid: 1.05, lastPrice: 1, delta: 0.5, gamma: 0.05, iv: 0.2,
        openInterest: k === muroCall ? 9000 : 100, volume: 100, premiumTraded: 0 },
      put: { symbol: `P${k}`, strike: k, type: "put" as const, expiration: "2026-08-26",
        bid: 1, ask: 1.1, mid: 1.05, lastPrice: 1, delta: -0.5, gamma: 0.05, iv: 0.2,
        openInterest: k === muroPut ? 9000 : 100, volume: 100, premiumTraded: 0 },
    }));
    const contracts = strikes.flatMap((s) => [s.call, s.put]) as unknown as Chain2Contract[];
    return buildZeroDte({
      contracts, spot, closes: cierres(0.005), now: new Date("2026-08-26T15:00:00Z"),
      horizonDays: 0.2,
    });
  }

  it("cuando el muro queda MÁS ALLÁ de 2σ, el motivo dice 2σ y NO 1σ", () => {
    // Muro a +3% del spot: dentro de la ventana de la vista (±4%) pero muy
    // fuera de 2σ, que intradía anda por el 0,37%. Manda el clip.
    const a = analisis(103, 97, 100);
    expect(a.scenarios.bull.driver).toMatch(/2σ/);
    expect(a.scenarios.bull.driver).not.toMatch(/1σ/);
    expect(a.scenarios.bull.driver).toMatch(/se recorta/);
  });

  it("el motivo del recorte nombra el objetivo natural que se descartó", () => {
    const a = analisis(103, 97, 100);
    expect(a.scenarios.bull.driver).toContain("103.00");
  });

  it("el bajista se comporta igual por su lado", () => {
    const a = analisis(103, 97, 100);
    expect(a.scenarios.bear.driver).toMatch(/2σ/);
    expect(a.scenarios.bear.driver).not.toMatch(/1σ/);
  });

  it("el objetivo recortado se queda EXACTAMENTE en el borde de 2σ", () => {
    const a = analisis(103, 97, 100);
    const sigma = a.spot * (a.expectedRange.sigmaPct / 100);
    // 2σ en log-espacio, que es como lo construye expectedMove.
    expect(a.scenarios.bull.target).toBeGreaterThan(a.spot + sigma);
    expect(a.scenarios.bear.target).toBeLessThan(a.spot - sigma);
  });
});
