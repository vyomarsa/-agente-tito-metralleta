import { describe, expect, it } from "vitest";
import {
  MIN_SEEN_IN_PASSES, candidateKey, emptyBook, filterByPersistence, noWindow,
  persistence, requiredSeen, seenIn, type WatchBook,
} from "./primaWatchStore";

const NOW = new Date("2026-08-24T14:35:00Z"); // 10:35 ET

function cand(over: Partial<{ ticker: string; type: string; short: number; long: number; exp: string }> = {}) {
  const { ticker = "MSFT", type = "call", short = 510, long = 515, exp = "2026-08-28" } = over;
  return {
    ticker, type: type as "call" | "put", expiration: exp,
    shortLeg: { strike: short }, longLeg: { strike: long },
  };
}

function book(passes: string[][]): WatchBook {
  return {
    date: "2026-08-24",
    passes: passes.map((keys, i) => ({
      at: new Date(NOW.getTime() + i * 15 * 60_000).toISOString(),
      scanned: 96, failed: 7, keys,
    })),
  };
}

describe("candidateKey", () => {
  it("identifica el spread por ticker, tipo, AMBOS strikes y vencimiento", () => {
    expect(candidateKey(cand())).toBe("MSFT:call:510/515:2026-08-28");
  });

  // El mismo ticker con otro ancho es otra operación; contarlos juntos inflaría
  // la persistencia y haría creer que un spread lleva viéndose toda la mañana.
  it("distingue anchos distintos del mismo ticker", () => {
    expect(candidateKey(cand({ long: 515 }))).not.toBe(candidateKey(cand({ long: 520 })));
  });

  it("distingue put de call y vencimientos distintos", () => {
    expect(candidateKey(cand({ type: "put" }))).not.toBe(candidateKey(cand({ type: "call" })));
    expect(candidateKey(cand({ exp: "2026-09-04" }))).not.toBe(candidateKey(cand()));
  });
});

describe("seenIn", () => {
  it("cuenta en cuántas pasadas apareció", () => {
    const b = book([["A", "B"], ["A"], ["A", "C"]]);
    expect(seenIn(b, "A")).toBe(3);
    expect(seenIn(b, "B")).toBe(1);
    expect(seenIn(b, "C")).toBe(1);
  });

  it("una clave que nunca se vio da 0, no undefined", () => {
    expect(seenIn(book([["A"]]), "Z")).toBe(0);
  });

  // Con la ventana sin correr, la apertura de las 11:45 sigue su curso: la
  // persistencia informa, no bloquea.
  it("sin pasadas devuelve 0 para todo", () => {
    expect(seenIn(emptyBook(NOW), "A")).toBe(0);
  });
});

describe("persistence", () => {
  it("ordena por veces vistas, y desempata por clave para ser determinista", () => {
    const b = book([["A", "B"], ["A", "C"], ["A", "B"]]);
    expect(persistence(b)).toEqual([
      { key: "A", seen: 3 },
      { key: "B", seen: 2 },
      { key: "C", seen: 1 },
    ]);
  });

  it("un libro vacío no revienta", () => {
    expect(persistence(emptyBook(NOW))).toEqual([]);
  });
});

describe("emptyBook", () => {
  it("se ancla a la fecha de MERCADO (ET), no a la del reloj", () => {
    // 01:00 UTC del día 25 son las 21:00 ET del día 24: sigue siendo la sesión del 24.
    expect(emptyBook(new Date("2026-08-25T01:00:00Z")).date).toBe("2026-08-24");
  });
});

describe("requiredSeen — el umbral se topa a las pasadas que hubo", () => {
  it("con la ventana completa exige el mínimo del dueño", () => {
    expect(requiredSeen(5)).toBe(MIN_SEEN_IN_PASSES);
    expect(requiredSeen(3)).toBe(3);
  });

  // Nadie puede salir en 3 pasadas si solo hubo 2. Sin este tope, un PC apagado
  // media mañana bloquearía la apertura por un motivo que no tiene nada que ver
  // con la calidad del spread.
  it("con la ventana a medias exige lo que se pudo observar", () => {
    expect(requiredSeen(2)).toBe(2);
    expect(requiredSeen(1)).toBe(1);
  });

  // Sin ventana NO se relaja: se mantiene la exigencia completa, que con cero
  // observaciones nadie puede cumplir. Así la ausencia de ventana bloquea sola.
  it("sin ninguna pasada NO se relaja: exige el máximo y por tanto no pasa nadie", () => {
    expect(requiredSeen(0)).toBe(MIN_SEEN_IN_PASSES);
    expect(requiredSeen(-1)).toBe(MIN_SEEN_IN_PASSES);
  });
});

describe("filterByPersistence", () => {
  const A = cand({ ticker: "AAA" });
  const B = cand({ ticker: "BBB" });
  const C = cand({ ticker: "CCC" });
  const k = (c: ReturnType<typeof cand>) => candidateKey(c);

  it("deja pasar solo lo visto en 3 o más de las 5 pasadas", () => {
    const b = book([
      [k(A), k(B)], [k(A), k(B)], [k(A)], [k(A), k(C)], [k(A)],
    ]); // A×5, B×2, C×1
    const r = filterByPersistence([A, B, C], b);
    expect(r.required).toBe(3);
    expect(r.passing.map((c) => c.ticker)).toEqual(["AAA"]);
    expect(r.dropped).toBe(2);
  });

  it("justo en el umbral pasa (es >=, no >)", () => {
    const b = book([[k(A)], [k(A)], [k(A)], [], []]); // A×3
    expect(filterByPersistence([A], b).passing).toHaveLength(1);
  });

  it("con 2 pasadas exige 2, no 3", () => {
    const b = book([[k(A), k(B)], [k(A)]]); // A×2, B×1
    const r = filterByPersistence([A, B], b);
    expect(r.required).toBe(2);
    expect(r.passing.map((c) => c.ticker)).toEqual(["AAA"]);
  });

  // Decisión del dueño: sin ventana, sin operación. Y sale del propio umbral,
  // sin caso especial: exige 3, nadie tiene ninguna.
  it("sin ventana NO pasa nadie", () => {
    const r = filterByPersistence([A, B, C], emptyBook(NOW));
    expect(r.required).toBe(MIN_SEEN_IN_PASSES);
    expect(r.passing).toEqual([]);
    expect(r.dropped).toBe(3);
  });

  it("devuelve el recuento por clave para poder guardarlo en la posición", () => {
    const b = book([[k(A)], [k(A)], [k(A)], [k(B)], []]);
    const r = filterByPersistence([A, B], b);
    expect(r.seen.get(k(A))).toBe(3);
    expect(r.seen.get(k(B))).toBe(1);
  });

  it("una lista vacía de candidatos no revienta", () => {
    expect(filterByPersistence([], book([[], [], []])).passing).toEqual([]);
  });
});

describe("noWindow", () => {
  it("detecta el libro sin pasadas", () => {
    expect(noWindow(emptyBook(NOW))).toBe(true);
  });

  it("una sola pasada ya es ventana", () => {
    expect(noWindow(book([["A"]]))).toBe(false);
  });
});
