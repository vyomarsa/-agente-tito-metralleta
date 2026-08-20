import { describe, expect, it } from "vitest";
import {
  START_EQUITY, parseVpLedger, parseVpTrade, summarizeVp, type VpTrade,
} from "./ventaPrimaLedger";

function t(pnl: number, outcome?: VpTrade["outcome"], sym = "MSFT"): VpTrade {
  return parseVpTrade({
    id: `P${pnl}`, underlying: sym, spread_type: "PUT_CREDIT",
    short_strike: 470, long_strike: 465, contracts: 1,
    entry_credit: 0.5, exit_value: 0.2, pnl,
    profit_pct_of_max: 0.6, peak_profit_pct: 0.7,
    outcome: outcome ?? (pnl > 0 ? "ganada" : pnl < 0 ? "perdida" : "neutra"),
    close_reason: "prueba", exit_time: "2026-08-21T16:00:00", sector: "tech",
  });
}

describe("parseVpLedger", () => {
  it("salta las líneas corruptas sin invalidar el resto", () => {
    const txt = [
      JSON.stringify({ underlying: "SPY", pnl: 42, outcome: "ganada" }),
      "{ no soy json",
      "",
      JSON.stringify({ underlying: "QQQ", pnl: -10, outcome: "perdida" }),
    ].join("\n");
    const libro = parseVpLedger(txt);
    expect(libro).toHaveLength(2);
    expect(summarizeVp(libro).realizedPnl).toBe(32);
  });

  it("tolera filas viejas sin los campos nuevos", () => {
    const v = parseVpTrade({ underlying: "SPY", pnl: 20, outcome: "ganada" });
    expect(v.closeReason).toBe("");
    expect(v.peakProfitPct).toBe(0);
    expect(v.exitDate).toBe("");
  });

  it("saca la fecha del cierre del timestamp", () => {
    expect(t(10).exitDate).toBe("2026-08-21");
  });
});

describe("summarizeVp — cuenta acumulativa", () => {
  it("sin operaciones la cuenta está intacta y el win rate es null", () => {
    const s = summarizeVp([]);
    expect(s.equity).toBe(START_EQUITY);
    expect(s.trades).toBe(0);
    expect(s.winRate).toBeNull();
  });

  it("suma y resta sobre la cantidad de partida", () => {
    const s = summarizeVp([t(250), t(-100), t(80)]);
    expect(s.realizedPnl).toBe(230);
    expect(s.equity).toBe(10_230);
    expect(s.returnPct).toBe(2.3);
  });

  it("la curva lleva un punto por operación más el inicio", () => {
    expect(summarizeVp([t(250), t(-100)]).equityCurve).toEqual([10_000, 10_250, 10_150]);
  });

  it("NO se resetea: al añadir más operaciones sigue acumulando", () => {
    const libro = [t(250), t(-100)];
    expect(summarizeVp(libro).equity).toBe(10_150);
    libro.push(t(500));
    expect(summarizeVp(libro).equity).toBe(10_650);
  });

  it("el win rate ignora las neutras", () => {
    const s = summarizeVp([t(100), t(-30), t(0)]);
    expect([s.wins, s.losses, s.neutral]).toEqual([1, 1, 1]);
    expect(s.winRate).toBe(50);
  });

  it("mejor y peor", () => {
    const s = summarizeVp([t(100), t(-250), t(40)]);
    expect(s.best!.pnl).toBe(100);
    expect(s.worst!.pnl).toBe(-250);
  });

  it("desglosa por símbolo ordenado por PnL", () => {
    const s = summarizeVp([t(100, undefined, "NVDA"), t(-50, undefined, "MSFT"), t(30, undefined, "NVDA")]);
    expect(s.bySymbol.map((x) => x.symbol)).toEqual(["NVDA", "MSFT"]);
    expect(s.bySymbol[0]).toMatchObject({ trades: 2, wins: 2, pnl: 130 });
  });

  it("los céntimos no se acumulan mal", () => {
    const s = summarizeVp([t(0.1), t(0.1), t(0.1)]);
    expect(s.realizedPnl).toBe(0.3);
    expect(s.equity).toBe(10_000.3);
  });

  it("coincide con el resumen del bot Python (mismos criterios)", () => {
    // Mismo caso que tests/test_simulator.py::test_win_rate_ignora_las_neutras
    const s = summarizeVp([t(100), t(-30), t(0)]);
    expect(s.winRate).toBe(50);
    expect(s.equity).toBe(10_070);
  });
});
