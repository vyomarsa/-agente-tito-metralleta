import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSlot, MassiveBudgetError, penalize, queueWaitMs, resetLimiter,
} from "./massiveLimiter";

const WINDOW = 60_000;

// Con el límite en 3 los casos se leen mejor que con los 5 reales, y la lógica
// es la misma: lo que importa es "cuántas caben en la ventana", no el número.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T14:00:00Z"));
  process.env.MASSIVE_MAX_RPM = "3";
  resetLimiter();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MASSIVE_MAX_RPM;
});

async function fillBucket(): Promise<void> {
  await acquireSlot();
  await acquireSlot();
  await acquireSlot();
}

describe("acquireSlot", () => {
  it("deja pasar sin esperar tantas peticiones como marca el límite", async () => {
    await expect(fillBucket()).resolves.toBeUndefined();
    // El cubo queda lleno: el siguiente tendría que esperar la ventana entera.
    expect(queueWaitMs()).toBe(WINDOW);
  });

  it("la petición que no cabe espera a que la ventana libere hueco", async () => {
    await fillBucket();
    let granted = false;
    const turn = acquireSlot(WINDOW + 5_000).then(() => { granted = true; });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(granted).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    await turn;
    expect(granted).toBe(true);
  });

  it("se rinde en vez de colgar la petición si la espera pasa del tope", async () => {
    await fillBucket();
    await expect(acquireSlot(5_000)).rejects.toBeInstanceOf(MassiveBudgetError);
  });

  it("el error dice cuándo tiene sentido reintentar", async () => {
    await fillBucket();
    const err = await acquireSlot(5_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MassiveBudgetError);
    expect((err as MassiveBudgetError).retryAfterMs).toBe(WINDOW);
  });

  it("concede los turnos en orden de llegada", async () => {
    await fillBucket();
    const order: number[] = [];
    const a = acquireSlot(WINDOW * 3).then(() => { order.push(1); });
    const b = acquireSlot(WINDOW * 3).then(() => { order.push(2); });
    const c = acquireSlot(WINDOW * 3).then(() => { order.push(3); });

    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("un turno que se rinde NO rompe la cola para los siguientes", async () => {
    await fillBucket();
    // Se encola con margen y justo después llega un castigo largo: ese turno
    // muere, pero la cadena tiene que seguir viva.
    const doomed = acquireSlot(WINDOW + 10_000);
    penalize(WINDOW * 5);
    await expect(doomed).rejects.toBeInstanceOf(MassiveBudgetError);

    vi.setSystemTime(Date.now() + WINDOW * 6);
    await expect(acquireSlot()).resolves.toBeUndefined();
  });
});

// Estos dos fijan un fallo real visto en vivo: una petición con tope de 20 s
// tardó 52 s. La cola por delante no contaba, ni en la estimación ni en el tope.
describe("la cola por delante SÍ cuenta", () => {
  // Marcas ESCALONADAS: es donde se ve el fallo. Con las tres a la misma hora
  // caducan juntas y cualquier cuenta da lo mismo; escalonadas, cada turno de la
  // cola se sirve de una expiración distinta.
  async function staggeredBucket(): Promise<void> {
    await acquireSlot();
    vi.setSystemTime(Date.now() + 20_000);
    await acquireSlot();
    vi.setSystemTime(Date.now() + 20_000);
    await acquireSlot();
  }

  it("el que va detrás espera a SU expiración, no a la primera", async () => {
    await staggeredBucket();
    // El próximo entra al caducar la marca más vieja: quedan 20 s.
    expect(queueWaitMs()).toBe(20_000);

    const primero = acquireSlot(WINDOW * 5);
    // Con uno delante, el segundo depende de la SEGUNDA expiración: 40 s.
    // La cuenta vieja seguía diciendo 20 s y colaba peticiones de un minuto.
    expect(queueWaitMs()).toBe(40_000);

    await vi.advanceTimersByTimeAsync(WINDOW);
    await primero;
  });

  it("rechaza al que no cabe en su tope aunque el cubo parezca cerca de abrirse", async () => {
    await staggeredBucket();
    const primero = acquireSlot(WINDOW * 5);
    // Su espera real son 40 s; con un tope de 30 no debe colarse pese a que el
    // primer hueco esté a solo 20 s.
    await expect(acquireSlot(30_000)).rejects.toBeInstanceOf(MassiveBudgetError);

    await vi.advanceTimersByTimeAsync(WINDOW);
    await primero;
  });

  it("nadie tarda más de su tope: el reloj corre desde que se pide turno", async () => {
    await staggeredBucket();
    const t0 = Date.now();
    const lentos = [acquireSlot(WINDOW * 5), acquireSlot(WINDOW * 5)];
    let grantedAt: number | null = null;
    const tarde = acquireSlot(WINDOW * 5).then(() => { grantedAt = Date.now(); });

    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    await Promise.all([...lentos, tarde]);
    // Tercero en la cola → tercera expiración, 60 s desde t0. Y dentro del tope.
    expect(grantedAt! - t0).toBeLessThanOrEqual(WINDOW * 5);
    expect(grantedAt! - t0).toBe(WINDOW);
  });
});

describe("ventana deslizante", () => {
  it("las marcas salen de la ventana al pasar el minuto", async () => {
    await fillBucket();
    expect(queueWaitMs()).toBe(WINDOW);

    vi.setSystemTime(Date.now() + WINDOW + 1);
    expect(queueWaitMs()).toBe(0);
  });

  it("libera hueco a hueco, no de golpe", async () => {
    await acquireSlot();
    vi.setSystemTime(Date.now() + 20_000);
    await acquireSlot();
    await acquireSlot();

    // La marca más vieja es la de hace 20 s: quedan 40 s para el primer hueco.
    expect(queueWaitMs()).toBe(WINDOW - 20_000);
  });
});

describe("penalize", () => {
  it("frena el cubo aunque queden huecos libres", async () => {
    penalize(30_000);
    expect(queueWaitMs()).toBe(30_000);
    await expect(acquireSlot(5_000)).rejects.toThrow(/Sin cuota/);
  });

  it("un castigo más corto no acorta uno más largo ya vigente", () => {
    penalize(40_000);
    penalize(10_000);
    expect(queueWaitMs()).toBe(40_000);
  });

  it("deja de frenar cuando expira", async () => {
    penalize(30_000);
    vi.setSystemTime(Date.now() + 30_001);
    expect(queueWaitMs()).toBe(0);
    await expect(acquireSlot()).resolves.toBeUndefined();
  });
});
