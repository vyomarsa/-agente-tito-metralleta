// Cache persistente de capitalización bursátil. Solo servidor.
//
// El filtro de elegibilidad de venta de prima exige cap ≥ $10B para acciones
// (`creditSpread.ts`), y el único sitio que la daba era `fetchCompany` de Massive
// — 1 llamada por símbolo. Con 103 símbolos y el plan gratis (5 peticiones por
// minuto) un escaneo necesitaba 20 minutos SOLO para las caps, así que la ventana
// de apertura se quedaba sin candidatos: los 103 salían como "sin precio".
//
// La cap se mueve despacio y el umbral es grueso ($10B): un valor de hace días
// decide igual de bien que uno de hace un minuto. Por eso se guarda en disco con
// TTL largo y solo se va a la red cuando falta.
//
// OJO: esto NO resuelve el spot. El spot sí tiene que ser fresco y viene de
// Tastytrade, en la misma llamada que la cadena (ver `spreadScan.ts`).

import { promises as fs } from "fs";
import path from "path";
import { fetchCompany } from "./massive";

const FILE = path.join(process.cwd(), "data", "marketcap.json");

/**
 * Símbolos que **Massive** escribe distinto que las fuentes de opciones.
 *
 * Las clases de acción llevan punto en Massive (`BRK.B`) y van pegadas en
 * MarketSnack y Tastytrade (`BRKB`). El universo guarda la forma de las fuentes de
 * opciones —es la que manda, porque de ahí sale la cadena— y la traducción se hace
 * SOLO aquí, que es el único sitio donde se le pregunta algo a Massive.
 *
 * Comprobado el 2026-08-24: `BRK.B` en Massive da Berkshire Hathaway Class B; `BRKB`
 * da NOT_FOUND. Y al revés en Tastytrade: `BRKB` trae 15 vencimientos y `BRK.B`, cero.
 */
const MASSIVE_SYMBOL: Record<string, string> = {
  BRKB: "BRK.B",
};

/** 30 días: mucho más que el ruido que puede mover una cap respecto al umbral. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * TTL del "aquí no hay cap" (7 días), más corto que el de una cap buena.
 *
 * Sin este cache negativo, un símbolo SIN capitalización volvía a preguntarle a
 * Massive en CADA consulta — 2 peticiones de las 5 por minuto del plan gratis — y
 * la cola dejaba la llamada esperando hasta 20 s. Le pegaba justo a los ETFs y a
 * los índices (QQQ, SPX, SPY), que no tienen cap por definición: medido el
 * 2026-08-26, la Tarjeta de QQQ tardaba 20,5 s de los que 20 eran esto.
 *
 * Siete días y no treinta porque un negativo es una afirmación más frágil que una
 * cap: si algún día Massive empieza a servir la referencia de un símbolo que hoy
 * no cubre, una semana es lo que tarda en notarse. Refrescarlo cuesta 1 petición
 * por símbolo por semana.
 */
const TTL_SIN_CAP_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry {
  /** `null` = Massive respondió y NO hay capitalización para este símbolo. */
  cap: number | null;
  /** epoch ms de cuando se guardó. */
  at: number;
}

/** Cuánto vale una entrada antes de repreguntar. Un negativo caduca antes. */
function ttlFor(entry: Entry): number {
  return entry.cap == null ? TTL_SIN_CAP_MS : TTL_MS;
}

type Book = Record<string, Entry>;

// Un solo fichero para todo el universo: son ~100 números, no merece un archivo
// por símbolo.
//
// **Se lee del disco en CADA consulta, a propósito.** Un cache en memoria parecía
// la optimización obvia, pero el prellenado (`scripts/prefill-marketcap.mjs`)
// escribe este fichero desde OTRO proceso: con el libro memorizado, el servidor de
// Next se quedaría con la foto vacía del arranque y no vería nunca lo prellenado.
// Son ~100 números en disco local; el coste no se nota al lado de una llamada WS.
const g = globalThis as typeof globalThis & {
  __marketCapInflight?: Map<string, Promise<number | null>>;
};
const inflight: Map<string, Promise<number | null>> = (g.__marketCapInflight ??= new Map());

async function loadBook(): Promise<Book> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Book;
  } catch {
    return {};
  }
}

async function persist(book: Book): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(book), "utf8");
}

/**
 * Guarda una cap ya conocida (la usa el prellenado), o `null` para anotar que
 * Massive respondió y este símbolo NO tiene capitalización.
 */
export async function saveMarketCap(ticker: string, cap: number | null, now = Date.now()): Promise<void> {
  const book = await loadBook(); // relectura: otro proceso puede haber escrito
  book[ticker.trim().toUpperCase()] = { cap, at: now };
  await persist(book);
}

/** Lo que hay en disco para un símbolo, sin mirar el TTL ni tocar la red. */
export async function peekMarketCap(ticker: string): Promise<number | null> {
  const book = await loadBook();
  return book[ticker.trim().toUpperCase()]?.cap ?? null;
}

/**
 * Cap del símbolo. Sirve el disco mientras esté dentro del TTL; si no, intenta
 * refrescarla y, si la red falla (cuota agotada), **devuelve la vieja** antes que
 * `null` — un `null` descarta el símbolo entero por el filtro de cap, y una cap de
 * hace una semana es una razón mucho mejor para decidir que ninguna.
 *
 * **La distinción que importa: "no hay cap" NO es lo mismo que "no pude preguntar".**
 * Solo se anota el negativo cuando Massive RESPONDIÓ y no trajo capitalización —
 * eso es una respuesta, y se guarda para dejar de preguntar. Si la llamada falla
 * (cuota, red, 429) no se anota nada: apuntar un `null` ahí marcaría una acción
 * real como "sin cap" y el filtro de elegibilidad de venta de prima la dejaría
 * fuera durante días por un 429 pasajero.
 */
export async function cachedMarketCap(ticker: string, now = Date.now()): Promise<number | null> {
  const clean = ticker.trim().toUpperCase();
  const book = await loadBook();
  const hit = book[clean];
  if (hit && now - hit.at < ttlFor(hit)) return hit.cap;

  const running = inflight.get(clean);
  if (running) return running;

  const job = (async () => {
    let company: Awaited<ReturnType<typeof fetchCompany>>;
    try {
      company = await fetchCompany(MASSIVE_SYMBOL[clean] ?? clean);
    } catch {
      // Sin cuota o sin red: se sirve lo último que se supo y NO se anota nada.
      return hit?.cap ?? null;
    }

    const cap = company.marketCap;
    // El guardado va con red: un disco lleno o de solo lectura no debe tumbar un
    // escaneo — solo significa que la próxima vez se vuelve a preguntar.
    if (cap != null && cap > 0) {
      await saveMarketCap(clean, cap, now).catch(() => { /* sin persistir */ });
      return cap;
    }
    // Massive contestó y no hay cap (ETF, índice, o símbolo fuera de su plan).
    await saveMarketCap(clean, null, now).catch(() => { /* sin persistir */ });
    return null;
  })().finally(() => {
    inflight.delete(clean);
  });

  inflight.set(clean, job);
  return job;
}
