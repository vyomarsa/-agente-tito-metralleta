// Ficha de empresa: parte ESTÁTICA cacheada en disco + parte VIVA de Tastytrade.
//
// `fetchCompany` de Massive son 2 peticiones y, con el plan gratis (5 por minuto),
// esperar turno costaba **16,5 s medidos** al abrir un ticker — el 62% de todo el
// tiempo de carga del panel, más que la cadena entera.
//
// El reparto es lo que lo arregla: nombre, bolsa, sector, empleados y descripción NO
// cambian de un día para otro, así que se guardan en disco con TTL largo y Massive
// solo se consulta la primera vez. El precio, la variación y el rango del día SÍ
// tienen que ser frescos, y esos los da Tastytrade en vivo por el streamer.
//
// Solo servidor.

import { promises as fs } from "fs";
import path from "path";
import { fetchCompany } from "./massive";
import { cachedMarketCap } from "./marketCapStore";
import { fetchTastytradeQuotes, tastytradeConfigured, type QuoteToken } from "./tastytrade";
import type { CompanyInfo } from "./types";

const FILE = path.join(process.cwd(), "data", "companies.json");

/** 7 días: los datos de referencia no se mueven, pero tampoco se congelan para siempre. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Lo que NO cambia intradía. Es lo único que se guarda. */
interface CompanyRef {
  name: string | null;
  exchange: string | null;
  marketCap: number | null;
  homepageUrl: string | null;
  employees: number | null;
  listDate: string | null;
  sector: string | null;
  description: string | null;
  hasLogo: boolean;
  at: number;
}

type Book = Record<string, CompanyRef>;

// Se relee del disco en cada consulta, igual que `marketCapStore`: hay procesos
// aparte (tareas programadas) que también escriben, y un cache en memoria dejaría
// al servidor con la foto del arranque.
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
 * Ficha completa: referencia del disco (o de Massive si falta) + cotización viva de
 * Tastytrade. Nunca lanza — devuelve lo que haya podido reunir.
 */
export async function cachedCompany(
  ticker: string,
  opts: { quoteToken?: QuoteToken } = {},
): Promise<CompanyInfo> {
  const clean = ticker.trim().toUpperCase();
  const now = Date.now();

  const [book, viva] = await Promise.all([
    loadBook(),
    tastytradeConfigured()
      ? fetchTastytradeQuotes([clean], { quoteToken: opts.quoteToken }).catch(() => null)
      : Promise.resolve(null),
  ]);

  let ref = book[clean];
  if (!ref || now - ref.at >= TTL_MS) {
    // Solo aquí se paga Massive, y solo la primera vez por ticker cada 7 días.
    const fresca = await fetchCompany(clean).catch(() => null);
    if (fresca) {
      ref = {
        name: fresca.name, exchange: fresca.exchange, marketCap: fresca.marketCap,
        homepageUrl: fresca.homepageUrl, employees: fresca.employees, listDate: fresca.listDate,
        sector: fresca.sector, description: fresca.description, hasLogo: fresca.hasLogo,
        at: now,
      };
      book[clean] = ref;
      await persist(book).catch(() => { /* disco lleno o solo lectura: no es fatal */ });
    }
  }

  const q = viva?.get(clean) ?? null;
  // La cap tiene su propio almacén (lo usa el escáner de venta de prima); si la
  // referencia no la trajo, se pregunta allí antes que dejarla en null.
  const marketCap = ref?.marketCap ?? (await cachedMarketCap(clean, now).catch(() => null));

  return {
    ticker: clean,
    name: ref?.name ?? null,
    exchange: ref?.exchange ?? null,
    marketCap,
    homepageUrl: ref?.homepageUrl ?? null,
    employees: ref?.employees ?? null,
    listDate: ref?.listDate ?? null,
    sector: ref?.sector ?? null,
    description: ref?.description ?? null,
    hasLogo: ref?.hasLogo ?? false,
    price: q?.price ?? null,
    change: q?.change ?? null,
    changePercent: q?.changePercent ?? null,
    dayOpen: q?.dayOpen ?? null,
    dayHigh: q?.dayHigh ?? null,
    dayLow: q?.dayLow ?? null,
    dayVolume: q?.dayVolume ?? null,
    prevClose: q?.prevClose ?? null,
  };
}
