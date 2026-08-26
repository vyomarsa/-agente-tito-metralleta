// La IV con la que el 0DTE PROYECTA no es la de la cadena.
//
// Estos tests fijan justo la regresión que costó dinero (auditoría del libro de
// paper, 2026-08-26): el cono se construía con la IV ATM del 0DTE —que se dispara
// cuando quedan horas para el vencimiento— y proyectaba 12× el recorrido real del
// subyacente, así que el objetivo del modelo de momentum, acotado a 1σ, acababa
// donde el precio no llega.

import { describe, it, expect } from "vitest";
import { coneIv, representativeIv } from "./zerodte";
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
