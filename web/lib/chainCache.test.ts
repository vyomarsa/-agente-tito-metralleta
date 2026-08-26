import { describe, it, expect, beforeEach } from "vitest";
import {
  withChainCache, chainTtlMs, chainKey, clearChainCache, chainCacheSize,
  TTL_SESION_MS, TTL_CERRADO_MS, MAX_ENTRADAS,
} from "./chainCache";

/** Un instante concreto en hora de Nueva York (agosto → EDT, UTC−4). */
function et(hhmmss: string): Date {
  const [h, m, s = 0] = hhmmss.split(":").map(Number);
  return new Date(Date.UTC(2026, 7, 26, h + 4, m, s));
}

beforeEach(() => clearChainCache());

describe("chainTtlMs", () => {
  it("usa el TTL corto dentro de la sesión regular", () => {
    expect(chainTtlMs(et("09:30"))).toBe(TTL_SESION_MS);
    expect(chainTtlMs(et("12:00"))).toBe(TTL_SESION_MS);
    expect(chainTtlMs(et("15:59"))).toBe(TTL_SESION_MS);
  });

  it("usa el TTL largo en pre-market y tras el cierre", () => {
    expect(chainTtlMs(et("06:40"))).toBe(TTL_CERRADO_MS);
    expect(chainTtlMs(et("09:29"))).toBe(TTL_CERRADO_MS);
    expect(chainTtlMs(et("16:00"))).toBe(TTL_CERRADO_MS);
    expect(chainTtlMs(et("20:15"))).toBe(TTL_CERRADO_MS);
  });
});

describe("chainKey", () => {
  it("normaliza el ticker y separa por nº de vencimientos", () => {
    expect(chainKey(" spy ", 8)).toBe("SPY|8");
    expect(chainKey("SPY", 4)).not.toBe(chainKey("SPY", 8));
  });
});

describe("withChainCache", () => {
  it("sirve del cache mientras la foto está fresca", async () => {
    let llamadas = 0;
    const baja = () => withChainCache("SPY|8", async () => { llamadas++; return { n: llamadas }; }, et("12:00"));

    expect(await baja()).toEqual({ n: 1 });
    expect(await baja()).toEqual({ n: 1 });
    expect(llamadas).toBe(1);
  });

  it("vuelve a bajar cuando el TTL venció", async () => {
    let llamadas = 0;
    const fetcher = async () => { llamadas++; return llamadas; };

    expect(await withChainCache("SPY|8", fetcher, et("12:00:00"))).toBe(1);
    expect(await withChainCache("SPY|8", fetcher, et("12:00:44"))).toBe(1); // dentro de los 45 s
    expect(await withChainCache("SPY|8", fetcher, et("12:00:46"))).toBe(2); // fuera
    expect(llamadas).toBe(2);
  });

  it("aguanta 10 minutos con el mercado cerrado", async () => {
    let llamadas = 0;
    const fetcher = async () => { llamadas++; return llamadas; };

    expect(await withChainCache("SPY|8", fetcher, et("06:40:00"))).toBe(1);
    expect(await withChainCache("SPY|8", fetcher, et("06:41:30"))).toBe(1); // el TTL de sesión ya habría vencido
    expect(await withChainCache("SPY|8", fetcher, et("06:49:00"))).toBe(1);
    expect(await withChainCache("SPY|8", fetcher, et("06:50:30"))).toBe(2);
    expect(llamadas).toBe(2);
  });

  it("comparte UNA sola bajada entre llamadas simultáneas (single-flight)", async () => {
    let llamadas = 0;
    const lenta = async () => {
      llamadas++;
      await new Promise((r) => setTimeout(r, 20));
      return "cadena";
    };

    const [a, b, c] = await Promise.all([
      withChainCache("SPX|8", lenta, et("12:00")),
      withChainCache("SPX|8", lenta, et("12:00")),
      withChainCache("SPX|8", lenta, et("12:00")),
    ]);

    expect([a, b, c]).toEqual(["cadena", "cadena", "cadena"]);
    expect(llamadas).toBe(1);
  });

  it("no guarda la entrada si el fetcher falla, y el siguiente reintenta", async () => {
    let llamadas = 0;
    const fetcher = async () => {
      llamadas++;
      if (llamadas === 1) throw new Error("streamer caído");
      return "ok";
    };

    await expect(withChainCache("QQQ|8", fetcher, et("12:00"))).rejects.toThrow("streamer caído");
    expect(chainCacheSize()).toBe(0);
    expect(await withChainCache("QQQ|8", fetcher, et("12:00"))).toBe("ok");
    expect(llamadas).toBe(2);
  });

  it("no mezcla tickers distintos", async () => {
    const uno = await withChainCache("SPY|8", async () => "spy", et("12:00"));
    const dos = await withChainCache("QQQ|8", async () => "qqq", et("12:00"));
    expect(uno).toBe("spy");
    expect(dos).toBe("qqq");
    expect(chainCacheSize()).toBe(2);
  });

  it("no crece por encima del tope de entradas", async () => {
    for (let i = 0; i < MAX_ENTRADAS + 6; i++) {
      await withChainCache(`T${i}|8`, async () => i, et("12:00"));
    }
    expect(chainCacheSize()).toBeLessThanOrEqual(MAX_ENTRADAS);
  });
});
