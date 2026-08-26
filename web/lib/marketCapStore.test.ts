import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// El store lee y escribe `data/marketcap.json` y le pregunta a Massive. Aquí se
// sustituyen las dos cosas: lo que se prueba es la POLÍTICA de cache (qué se
// guarda, qué caduca y cuándo se va a la red), no el disco ni la API.
const disco = { texto: "{}" };
const fetchCompanyMock = vi.fn();

vi.mock("fs", () => ({
  promises: {
    readFile: async () => disco.texto,
    writeFile: async (_f: string, data: string) => { disco.texto = data; },
    mkdir: async () => undefined,
  },
}));
vi.mock("./massive", () => ({ fetchCompany: (...a: unknown[]) => fetchCompanyMock(...a) }));

const { cachedMarketCap, saveMarketCap, peekMarketCap } = await import("./marketCapStore");

const DIA = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 26, 12, 0, 0);

/** Ficha de Massive con solo lo que el store mira. */
function ficha(marketCap: number | null) {
  return { ticker: "X", marketCap } as Awaited<ReturnType<typeof import("./massive").fetchCompany>>;
}

beforeEach(() => {
  disco.texto = "{}";
  fetchCompanyMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("cachedMarketCap — caps normales", () => {
  it("pregunta una vez y luego sirve del disco", async () => {
    fetchCompanyMock.mockResolvedValue(ficha(50e9));

    expect(await cachedMarketCap("AAPL", T0)).toBe(50e9);
    expect(await cachedMarketCap("AAPL", T0 + DIA)).toBe(50e9);
    expect(fetchCompanyMock).toHaveBeenCalledTimes(1);
  });

  it("repregunta pasados los 30 días", async () => {
    fetchCompanyMock.mockResolvedValue(ficha(50e9));
    await cachedMarketCap("AAPL", T0);

    fetchCompanyMock.mockResolvedValue(ficha(60e9));
    expect(await cachedMarketCap("AAPL", T0 + 31 * DIA)).toBe(60e9);
    expect(fetchCompanyMock).toHaveBeenCalledTimes(2);
  });
});

describe("cachedMarketCap — cache NEGATIVO", () => {
  it("anota el 'no hay cap' y deja de preguntar (el caso QQQ/SPX)", async () => {
    fetchCompanyMock.mockResolvedValue(ficha(null));

    expect(await cachedMarketCap("QQQ", T0)).toBeNull();
    expect(await cachedMarketCap("QQQ", T0 + 60_000)).toBeNull();
    expect(await cachedMarketCap("QQQ", T0 + 6 * DIA)).toBeNull();
    expect(fetchCompanyMock).toHaveBeenCalledTimes(1);
  });

  it("el negativo caduca a los 7 días, antes que una cap buena", async () => {
    fetchCompanyMock.mockResolvedValue(ficha(null));
    await cachedMarketCap("QQQ", T0);

    fetchCompanyMock.mockResolvedValue(ficha(42e9));
    expect(await cachedMarketCap("QQQ", T0 + 8 * DIA)).toBe(42e9);
    expect(fetchCompanyMock).toHaveBeenCalledTimes(2);
  });

  it("una cap de 0 cuenta como 'no hay cap'", async () => {
    fetchCompanyMock.mockResolvedValue(ficha(0));
    expect(await cachedMarketCap("RARO", T0)).toBeNull();
    expect(JSON.parse(disco.texto).RARO).toEqual({ cap: null, at: T0 });
  });
});

describe("cachedMarketCap — 'no pude preguntar' NO se anota como 'no hay cap'", () => {
  it("un fallo de red no escribe nada y se reintenta a la siguiente", async () => {
    fetchCompanyMock.mockRejectedValue(new Error("429 sin cuota"));

    expect(await cachedMarketCap("NVDA", T0)).toBeNull();
    expect(disco.texto).toBe("{}"); // nada anotado

    fetchCompanyMock.mockResolvedValue(ficha(80e9));
    expect(await cachedMarketCap("NVDA", T0 + 1_000)).toBe(80e9);
    expect(fetchCompanyMock).toHaveBeenCalledTimes(2);
  });

  it("con la red caída sirve la cap vieja antes que null, aunque haya caducado", async () => {
    await saveMarketCap("MSFT", 90e9, T0);
    fetchCompanyMock.mockRejectedValue(new Error("sin cuota"));

    expect(await cachedMarketCap("MSFT", T0 + 40 * DIA)).toBe(90e9);
  });
});

describe("compatibilidad y utilidades", () => {
  it("lee las entradas ya guardadas por la versión anterior (sin negativos)", async () => {
    disco.texto = JSON.stringify({ TSLA: { cap: 1.4e12, at: T0 } });
    expect(await cachedMarketCap("TSLA", T0 + DIA)).toBe(1.4e12);
    expect(fetchCompanyMock).not.toHaveBeenCalled();
  });

  it("normaliza el ticker", async () => {
    fetchCompanyMock.mockResolvedValue(ficha(10e9));
    await cachedMarketCap(" aapl ", T0);
    expect(await peekMarketCap("AAPL")).toBe(10e9);
  });

  it("dos llamadas a la vez comparten una sola consulta", async () => {
    fetchCompanyMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return ficha(30e9);
    });

    const [a, b] = await Promise.all([cachedMarketCap("AMD", T0), cachedMarketCap("AMD", T0)]);
    expect([a, b]).toEqual([30e9, 30e9]);
    expect(fetchCompanyMock).toHaveBeenCalledTimes(1);
  });
});
