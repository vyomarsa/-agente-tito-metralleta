// Regulador de caudal para Massive.
//
// Desde que el plan pasó a GRATIS (2026-08-16) la API admite 5 peticiones por
// minuto. Abrir un ticker dispara 7+ (cadena, barras ×3, quotes, pulso), así que
// las últimas en salir recibían 429 y la gráfica quedaba vacía sin explicación.
//
// Este módulo pone UNA cola FIFO delante de todas las llamadas: cada petición
// reserva turno y espera a que haya hueco en la ventana de 60 s. Si la espera
// estimada es mayor que lo que aguanta una petición HTTP, se rinde con un error
// que trae `retryAfterMs`, y quien llama decide (servir cache viejo, reintentar).
//
// LIMITACIÓN CONOCIDA: el contador vive en este proceso. Las tareas programadas
// de Windows (KeepAlive, paper de Venta Prima) usan la misma key desde procesos
// aparte y no se ven aquí. Por eso `penalize()` existe: cuando Massive nos dice
// 429 de verdad, se bloquea el cubo para todos aunque nuestra cuenta dijera que
// había hueco. Si esas tareas compiten mucho, baja MASSIVE_MAX_RPM a 4 o 3.

const WINDOW_MS = 60_000;

/**
 * Espera máxima que aguanta una petición HTTP antes de rendirse.
 *
 * 20 s y no menos: el caso corriente es abrir un ticker justo después de que la
 * cadena se comiera el presupuesto, con la ventana a punto de liberar hueco.
 * Con un tope corto esos casi-aciertos se rechazaban y el cliente reintentaba
 * igual unos segundos después — misma espera para el usuario, pero con un error
 * de por medio. Más de 20 s ya se lee como que la página se colgó.
 */
export const DEFAULT_MAX_WAIT_MS = 20_000;

/** Error de cuota. `retryAfterMs` = cuándo tiene sentido volver a intentar. */
export class MassiveBudgetError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "MassiveBudgetError";
    this.retryAfterMs = retryAfterMs;
  }
}

interface LimiterState {
  /** Marcas de tiempo (ms) de las peticiones que ya salieron. */
  hits: number[];
  /** Cola: cada turno se encadena al anterior para respetar el orden de llegada. */
  chain: Promise<unknown>;
  /** Cuántos esperan turno ahora mismo (para estimar la espera de uno nuevo). */
  queued: number;
  /** Si Massive nos castigó con un 429, no se sale hasta esta marca. */
  blockedUntil: number;
}

// Next.js recarga módulos en dev (HMR) y monta todas las rutas en el mismo
// proceso: el estado vive en globalThis para que TODAS compartan un solo cubo.
const g = globalThis as typeof globalThis & { __massiveLimiter?: LimiterState };
const state: LimiterState = (g.__massiveLimiter ??= {
  hits: [],
  chain: Promise.resolve(),
  queued: 0,
  blockedUntil: 0,
});

function rpm(): number {
  const n = Number(process.env.MASSIVE_MAX_RPM);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function prune(now: number): void {
  if (state.hits.length === 0) return;
  state.hits = state.hits.filter((t) => now - t < WINDOW_MS);
}

/**
 * ms hasta que se conceda el turno de quien tenga `position` peticiones por
 * delante (0 = el próximo en entrar).
 *
 * Se cuenta por EXPIRACIONES, no por ventanas enteras: si las 5 marcas vivas
 * caducan a la vez, los 5 primeros de la cola entran juntos. Contar "una ventana
 * por cada `rpm` en cola" subestimaba la espera de los últimos, que es lo que
 * dejó pasar peticiones destinadas a tardar un minuto.
 */
function waitForPosition(position: number, now: number): number {
  prune(now);
  const limit = rpm();
  const blocked = Math.max(0, state.blockedUntil - now);
  const needed = state.hits.length + position + 1 - limit;
  if (needed <= 0) return blocked;

  if (needed <= state.hits.length) {
    return Math.max(blocked, state.hits[needed - 1] + WINDOW_MS - now);
  }
  // Más turnos de los que pueden liberar las marcas vivas: los que esperan se
  // convertirán a su vez en marcas, y cada ventana extra libera `limit` turnos.
  const extra = Math.ceil((needed - state.hits.length) / limit);
  const last = state.hits.length > 0 ? state.hits[state.hits.length - 1] : now;
  return Math.max(blocked, last + WINDOW_MS * (1 + extra) - now);
}

/** ms hasta que se libere un hueco en el cubo (0 = hay hueco ya). */
function bucketWaitMs(now: number): number {
  return waitForPosition(0, now);
}

/** Espera estimada para alguien que llegue AHORA, contando la cola por delante. */
export function queueWaitMs(now = Date.now()): number {
  return waitForPosition(state.queued, now);
}

/**
 * Marca que Massive rechazó por cuota: bloquea el cubo entero durante
 * `retryAfterMs`. Se usa cuando el 429 llega pese a nuestra contabilidad
 * (típico: otro proceso gastando la misma key).
 */
export function penalize(retryAfterMs: number, now = Date.now()): void {
  const until = now + Math.max(0, retryAfterMs);
  if (until > state.blockedUntil) state.blockedUntil = until;
}

/**
 * `deadline` es ABSOLUTO y se fija al pedir turno, no al empezar a reservar:
 * si se calculara aquí, el rato pasado en la cola no contaría contra el tope y
 * una petición podría tardar minutos con un tope de 20 s.
 */
async function reserve(deadline: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    const wait = bucketWaitMs(now);
    if (wait <= 0) {
      state.hits.push(now);
      return;
    }
    if (now + wait > deadline) {
      throw new MassiveBudgetError(
        `Sin cuota de Massive ahora mismo (plan gratis: ${rpm()} peticiones/minuto).`,
        wait,
      );
    }
    await sleep(Math.min(wait + 25, 2_000));
  }
}

/**
 * Reserva turno para UNA petición a Massive. Resuelve cuando hay hueco; lanza
 * `MassiveBudgetError` si la espera pasa de `maxWaitMs`.
 */
export async function acquireSlot(maxWaitMs = DEFAULT_MAX_WAIT_MS): Promise<void> {
  // Corte rápido: si la cola ya es larga, no tiene sentido ni encolarse.
  const estimate = queueWaitMs();
  if (estimate > maxWaitMs) {
    throw new MassiveBudgetError(
      `Sin cuota de Massive ahora mismo (plan gratis: ${rpm()} peticiones/minuto).`,
      estimate,
    );
  }

  const deadline = Date.now() + maxWaitMs;
  state.queued += 1;
  const turn = state.chain.then(() => reserve(deadline));
  // La cadena nunca se rompe: un turno fallido no debe bloquear a los siguientes.
  state.chain = turn.then(
    () => {},
    () => {},
  );
  try {
    await turn;
  } finally {
    state.queued -= 1;
  }
}

/** Solo para tests: deja el cubo como recién arrancado. */
export function resetLimiter(): void {
  state.hits = [];
  state.chain = Promise.resolve();
  state.queued = 0;
  state.blockedUntil = 0;
}
