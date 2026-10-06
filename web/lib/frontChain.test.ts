// Cascada Tastytrade → MarketSnack del 0DTE y el Scalping, con las dos fuentes simuladas.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TtContract } from "./tastytrade";

const tt = {
  configured: true,
  chain: vi.fn(),
  expirations: vi.fn(),
};
const ms = {
  expirations: vi.fn(),
  chain: vi.fn(),
};

vi.mock("./tastytrade", () => ({
  tastytradeConfigured: () => tt.configured,
  fetchTastytradeChain: (...a: unknown[]) => tt.chain(...a),
  fetchTastytradeExpirations: (...a: unknown[]) => tt.expirations(...a),
}));
vi.mock("./marketsnack", () => ({
  fetchExpirations: (...a: unknown[]) => ms.expirations(...a),
  fetchOptionChain2: (...a: unknown[]) => ms.chain(...a),
}));

const { ttToChain2, fetchChainsByDate, listExpirations, FrontChainError } = await import("./frontChain");

function ttc(p: Partial<TtContract> = {}): TtContract {
  return {
    strike: 760, type: "call", expiration: "2026-09-17", dte: 0,
    bid: 1.0, ask: 1.2, delta: 0.5, iv: 0.15, gamma: 0.08,
    openInterest: 1000, volume: 500, last: 1.1,
    ...p,
  };
}

function msRaw(expiration: string, strike = 760) {
  return [{ symbol: `SPY${strike}`, type: "call", strike, expiration, open_interest: 10, volume: 1 }];
}

beforeEach(() => {
  tt.configured = true;
  tt.chain.mockReset();
  tt.expirations.mockReset();
  ms.expirations.mockReset();
  ms.chain.mockReset();
});

describe("ttToChain2", () => {
  it("usa el símbolo OCC de Tastytrade y calcula el mid", () => {
    const c = ttToChain2(ttc({ symbol: "SPY260917C00760000" }), "SPY");
    expect(c.symbol).toBe("SPY260917C00760000");
    expect(c.mid).toBeCloseTo(1.1);
    expect(c.gamma).toBe(0.08);
    expect(c.openInterest).toBe(1000);
  });

  it("sin símbolo lo monta en el MISMO formato que guarda el paper del 0DTE", () => {
    expect(ttToChain2(ttc(), "SPY").symbol).toBe("SPY260917C00760000");
    expect(ttToChain2(ttc({ type: "put", strike: 298.5 }), "IWM").symbol).toBe("IWM260917P00298500");
  });

  it("aproxima la prima negociada como volumen × mid × 100", () => {
    expect(ttToChain2(ttc(), "SPY").premiumTraded).toBeCloseTo(500 * 1.1 * 100);
  });

  it("sin horquilla usa el último para la prima y deja el mid en null", () => {
    const c = ttToChain2(ttc({ bid: null, ask: null, last: 2 }), "SPY");
    expect(c.mid).toBeNull();
    expect(c.premiumTraded).toBe(500 * 2 * 100);
  });

  it("un bid de 0 con ask válido sí da mid (strike muy OTM)", () => {
    expect(ttToChain2(ttc({ bid: 0, ask: 0.02 }), "SPY").mid).toBeCloseTo(0.01);
  });

  it("un último de 0 no es un precio", () => {
    expect(ttToChain2(ttc({ last: 0 }), "SPY").lastPrice).toBeNull();
  });
});

describe("fetchChainsByDate", () => {
  it("con Tastytrade agrupa por vencimiento y trae el spot", async () => {
    tt.chain.mockResolvedValue({
      spot: 761.2,
      contracts: [ttc(), ttc({ type: "put" }), ttc({ expiration: "2026-09-18" })],
    });
    const r = await fetchChainsByDate("SPY", ["2026-09-17", "2026-09-18"]);
    expect(r.source).toBe("tastytrade");
    expect(r.spot).toBe(761.2);
    expect(r.byDate.get("2026-09-17")).toHaveLength(2);
    expect(r.byDate.get("2026-09-18")).toHaveLength(1);
    expect(tt.chain.mock.calls[0][1].dates).toEqual(["2026-09-17", "2026-09-18"]);
    expect(ms.chain).not.toHaveBeenCalled();
  });

  it("si Tastytrade no trae el FRENTE, cae entero a MarketSnack (no mezcla fuentes)", async () => {
    tt.chain.mockResolvedValue({ spot: 761, contracts: [ttc({ expiration: "2026-09-18" })] });
    ms.chain.mockImplementation(async (_t: string, d: string) => msRaw(d));
    const r = await fetchChainsByDate("SPY", ["2026-09-17", "2026-09-18"]);
    expect(r.source).toBe("marketsnack");
    expect(r.spot).toBeNull();
    expect(ms.chain).toHaveBeenCalledTimes(2);
  });

  it("si Tastytrade falla, usa MarketSnack", async () => {
    tt.chain.mockRejectedValue(new Error("401"));
    ms.chain.mockResolvedValue(msRaw("2026-09-17"));
    const r = await fetchChainsByDate("SPY", ["2026-09-17"]);
    expect(r.source).toBe("marketsnack");
    expect(r.byDate.get("2026-09-17")).toHaveLength(1);
  });

  it("sin Tastytrade configurado ni lo intenta", async () => {
    tt.configured = false;
    ms.chain.mockResolvedValue(msRaw("2026-09-17"));
    await fetchChainsByDate("SPY", ["2026-09-17"]);
    expect(tt.chain).not.toHaveBeenCalled();
  });

  it("en MarketSnack un vencimiento SECUNDARIO que falla se salta", async () => {
    tt.configured = false;
    ms.chain.mockImplementation(async (_t: string, d: string) => {
      if (d === "2026-09-18") throw new Error("404");
      return msRaw(d);
    });
    const r = await fetchChainsByDate("SPY", ["2026-09-17", "2026-09-18"]);
    expect(r.byDate.has("2026-09-18")).toBe(false);
    expect(r.byDate.get("2026-09-17")).toHaveLength(1);
  });

  it("si fallan las dos en el frente, el error nombra a las dos", async () => {
    tt.chain.mockRejectedValue(new Error("token rechazado"));
    ms.chain.mockRejectedValue(new Error("cookie expirada"));
    const p = fetchChainsByDate("SPY", ["2026-09-17"]);
    await expect(p).rejects.toBeInstanceOf(FrontChainError);
    await expect(p).rejects.toThrow(/token rechazado.*cookie expirada/);
  });
});

describe("listExpirations", () => {
  it("Tastytrade primero, ordenadas", async () => {
    tt.expirations.mockResolvedValue([{ date: "2026-09-18", dte: 1 }, { date: "2026-09-17", dte: 0 }]);
    const r = await listExpirations("SPY");
    expect(r).toEqual({ dates: ["2026-09-17", "2026-09-18"], source: "tastytrade" });
    expect(ms.expirations).not.toHaveBeenCalled();
  });

  it("lista vacía de Tastytrade → MarketSnack", async () => {
    tt.expirations.mockResolvedValue([]);
    ms.expirations.mockResolvedValue([{ date: "2026-09-17" }]);
    expect((await listExpirations("SPY")).source).toBe("marketsnack");
  });

  it("si fallan las dos lanza FrontChainError", async () => {
    tt.expirations.mockRejectedValue(new Error("caído"));
    ms.expirations.mockRejectedValue(new Error("sin cookie"));
    await expect(listExpirations("SPY")).rejects.toBeInstanceOf(FrontChainError);
  });
});
