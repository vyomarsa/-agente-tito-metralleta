// Política del REST de Tastytrade: tope de tiempo y reintento.
//
// `fetchConTope` es privada a propósito, así que se ejercita por la puerta pública
// (`fetchMarketMetrics` → `getJson`). El token se sirve del "disco" ya vigente para
// que las pruebas midan SOLO la llamada de datos.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const disco = { texto: "" };
vi.mock("fs", () => ({
  promises: {
    readFile: async () => disco.texto,
    writeFile: async (_f: string, data: string) => { disco.texto = data; },
    mkdir: async () => undefined,
    unlink: async () => undefined,
  },
}));

const { fetchMarketMetrics, TastytradeError } = await import("./tastytrade");

/** Lo que lanza `AbortSignal.timeout` al saltar. */
function corteDeTiempo(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

function respuesta(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const METRICAS = { data: { items: [{ symbol: "AAPL", "implied-volatility-index-rank": "0.35" }] } };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Token vigente en disco → getAccessToken no sale a la red.
  disco.texto = JSON.stringify({
    access_token: "tok",
    access_expires_at: Date.now() + 10 * 60_000,
    env: "production",
  });
  process.env.TASTYTRADE_ENV = "production";
  process.env.TASTYTRADE_CLIENT_SECRET = "secreto";
  process.env.TASTYTRADE_REFRESH_TOKEN = "refresco";

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("tope de tiempo del REST", () => {
  it("pasa una señal de aborto en cada intento", async () => {
    fetchMock.mockResolvedValue(respuesta(METRICAS));
    await fetchMarketMetrics(["AAPL"]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("un atasco se reintenta UNA vez y el segundo intento salva la llamada", async () => {
    fetchMock
      .mockRejectedValueOnce(corteDeTiempo())
      .mockResolvedValueOnce(respuesta(METRICAS));

    const out = await fetchMarketMetrics(["AAPL"]);
    expect(out[0]?.ivRank).toBeCloseTo(35);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dos atascos seguidos se rinden con un mensaje que dice qué pasó", async () => {
    fetchMock.mockRejectedValue(corteDeTiempo());

    await expect(fetchMarketMetrics(["AAPL"])).rejects.toThrow(TastytradeError);
    await expect(fetchMarketMetrics(["AAPL"])).rejects.toThrow(/no respondió en 12 s/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 intentos × 2 llamadas
  });

  it("un fallo de red también se reintenta", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(respuesta(METRICAS));

    await expect(fetchMarketMetrics(["AAPL"])).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("qué NO se reintenta", () => {
  it("un 401 sale a la primera, sin machacar", async () => {
    fetchMock.mockResolvedValue(respuesta({ error: "no" }, 401));

    await expect(fetchMarketMetrics(["AAPL"])).rejects.toThrow(TastytradeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un 429 NO se reintenta — machacar un límite de tasa lo empeora", async () => {
    fetchMock.mockResolvedValue(respuesta({ error: "slow down" }, 429));

    await expect(fetchMarketMetrics(["AAPL"])).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("una respuesta buena no reintenta nada", async () => {
    fetchMock.mockResolvedValue(respuesta(METRICAS));

    await fetchMarketMetrics(["AAPL"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
