import { describe, expect, it } from "vitest";
import {
  BIAS_MINUTES, emptyBook, gradeBook, MIN_CALL_GAP_MS,
  recordBias, recordTrade, scoreboard,
} from "./zerodteLiveStore";
import type { ZeroDteBias, ZeroDteTrade } from "./zerodteSignals";

const T0 = new Date("2026-08-24T14:00:00Z"); // 10:00 ET
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function bias(over: Partial<ZeroDteBias> = {}): ZeroDteBias {
  return {
    model: "original", minutes: BIAS_MINUTES, spot: 100, center: 100,
    low: 99, high: 101, sigmaPts: 1, dir: "flat", confidence: "media",
    note: "", flowNote: null, ...over,
  };
}

function trade(over: Partial<ZeroDteTrade> = {}): ZeroDteTrade {
  return {
    model: "magnet", side: "LONG", entry: 100, target: 102, stop: 99,
    reward: 2, risk: 1, rr: 2, rationale: "", ...over,
  };
}

describe("recordBias", () => {
  it("con el mercado cerrado no apunta nada", () => {
    const b = recordBias(emptyBook("SPY", T0), bias(), T0, false);
    expect(b.bias).toHaveLength(0);
  });

  it("no duplica llamadas del mismo modelo dentro del hueco mínimo", () => {
    let book = emptyBook("SPY", T0);
    book = recordBias(book, bias(), T0, true);
    book = recordBias(book, bias(), new Date(T0.getTime() + MIN_CALL_GAP_MS - 1000), true);
    expect(book.bias).toHaveLength(1);
  });

  it("pasado el hueco sí apunta otra", () => {
    let book = emptyBook("SPY", T0);
    book = recordBias(book, bias(), T0, true);
    book = recordBias(book, bias(), at(2), true);
    expect(book.bias).toHaveLength(2);
  });

  it("original y alterno llevan cuentas separadas", () => {
    let book = emptyBook("SPY", T0);
    book = recordBias(book, bias({ model: "original" }), T0, true);
    book = recordBias(book, bias({ model: "alterno" }), T0, true);
    expect(book.bias).toHaveLength(2);
  });

  it("fija el vencimiento a los minutos del sesgo", () => {
    const book = recordBias(emptyBook("SPY", T0), bias(), T0, true);
    expect(Date.parse(book.bias[0].dueAt) - T0.getTime()).toBe(BIAS_MINUTES * 60_000);
  });
});

describe("gradeBook — sesgo", () => {
  it("no califica antes de que venza la llamada", () => {
    const book = recordBias(emptyBook("SPY", T0), bias(), T0, true);
    gradeBook(book, 100.5, at(3), true);
    expect(book.bias[0].actual).toBeNull();
  });

  it("acierta el rango si el precio cayó dentro del cono", () => {
    const book = recordBias(emptyBook("SPY", T0), bias(), T0, true);
    gradeBook(book, 100.5, at(6), true);
    expect(book.bias[0].hitRange).toBe(true);
    expect(book.bias[0].actual).toBe(100.5);
  });

  it("falla el rango si se salió del cono", () => {
    const book = recordBias(emptyBook("SPY", T0), bias(), T0, true);
    gradeBook(book, 103, at(6), true);
    expect(book.bias[0].hitRange).toBe(false);
  });

  it("una llamada 'lateral' acierta dirección si se movió menos de 1σ", () => {
    const book = recordBias(emptyBook("SPY", T0), bias({ dir: "flat" }), T0, true);
    gradeBook(book, 100.4, at(6), true);
    expect(book.bias[0].hitDir).toBe(true);
  });

  it("una llamada 'al alza' acierta solo si subió", () => {
    let book = recordBias(emptyBook("SPY", T0), bias({ dir: "up" }), T0, true);
    gradeBook(book, 100.4, at(6), true);
    expect(book.bias[0].hitDir).toBe(true);

    book = recordBias(emptyBook("SPY", T0), bias({ dir: "up" }), T0, true);
    gradeBook(book, 99.6, at(6), true);
    expect(book.bias[0].hitDir).toBe(false);
  });

  it("una vez calificada no se recalifica con un precio posterior", () => {
    const book = recordBias(emptyBook("SPY", T0), bias(), T0, true);
    gradeBook(book, 100.5, at(6), true);
    gradeBook(book, 120, at(9), true);
    expect(book.bias[0].actual).toBe(100.5);
  });
});

describe("recordTrade y su calificación", () => {
  it("un modelo sostiene UNA idea a la vez", () => {
    let book = emptyBook("SPY", T0);
    book = recordTrade(book, trade(), T0, true);
    book = recordTrade(book, trade({ target: 105 }), at(5), true);
    expect(book.trades).toHaveLength(1);
  });

  it("los dos modelos pueden tener idea a la vez", () => {
    let book = emptyBook("SPY", T0);
    book = recordTrade(book, trade({ model: "magnet" }), T0, true);
    book = recordTrade(book, trade({ model: "momentum" }), T0, true);
    expect(book.trades).toHaveLength(2);
  });

  it("gana cuando el precio alcanza el objetivo y libera el modelo", () => {
    let book = recordTrade(emptyBook("SPY", T0), trade(), T0, true);
    gradeBook(book, 102.5, at(10), true);
    expect(book.trades[0].status).toBe("win");
    book = recordTrade(book, trade(), at(11), true);
    expect(book.trades).toHaveLength(2);
  });

  it("pierde cuando el precio alcanza el stop", () => {
    const book = recordTrade(emptyBook("SPY", T0), trade(), T0, true);
    gradeBook(book, 98.5, at(10), true);
    expect(book.trades[0].status).toBe("loss");
  });

  it("un SHORT se califica al revés", () => {
    const book = recordTrade(emptyBook("SPY", T0), trade({ side: "SHORT", target: 98, stop: 101 }), T0, true);
    gradeBook(book, 97.5, at(10), true);
    expect(book.trades[0].status).toBe("win");
  });

  it("al cerrar el mercado lo que siga vivo queda 'flat', ni gana ni pierde", () => {
    const book = recordTrade(emptyBook("SPY", T0), trade(), T0, true);
    gradeBook(book, 100.2, at(300), false);
    expect(book.trades[0].status).toBe("flat");
  });
});

describe("scoreboard", () => {
  it("sin llamadas calificadas los porcentajes son null, no 0", () => {
    const s = scoreboard(emptyBook("SPY", T0));
    expect(s.bias[0].rangePct).toBeNull();
    expect(s.trades[0].winRate).toBeNull();
  });

  it("cuenta rango y dirección por separado y por modelo", () => {
    let book = emptyBook("SPY", T0);
    book = recordBias(book, bias({ model: "original", dir: "up" }), T0, true);
    book = recordBias(book, bias({ model: "alterno", dir: "up" }), T0, true);
    gradeBook(book, 103, at(6), true); // fuera del cono, pero subió
    const s = scoreboard(book);
    const orig = s.bias.find((b) => b.model === "original")!;
    expect(orig.graded).toBe(1);
    expect(orig.rangePct).toBe(0);
    expect(orig.dirPct).toBe(100);
  });

  it("el win rate ignora las 'flat' pero las cuenta como cerradas", () => {
    let book = emptyBook("SPY", T0);
    book = recordTrade(book, trade(), T0, true);
    gradeBook(book, 102.5, at(5), true);          // win
    book = recordTrade(book, trade(), at(6), true);
    gradeBook(book, 98.5, at(10), true);          // loss
    book = recordTrade(book, trade(), at(11), true);
    gradeBook(book, 100.1, at(400), false);       // flat
    const m = scoreboard(book).trades.find((t) => t.model === "magnet")!;
    expect(m.closed).toBe(3);
    expect(m.flats).toBe(1);
    expect(m.winRate).toBe(50); // 1 de 2 decididas
  });
});
