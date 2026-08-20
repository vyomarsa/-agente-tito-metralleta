// Roster fijo del master y parser de sus mensajes. PURO (sin red): fácil de testear.
//
// Cada mañana el master manda ~13 mensajes: uno de noticias generales y uno por cada
// símbolo de una lista FIJA. Como la lista se conoce de antemano, no hace falta adivinar
// el ticker con IA: lo detectamos por símbolo o nombre. Si un mensaje no cae en ningún
// símbolo del roster, se trata como "noticias" (contexto macro, sin cruce de niveles).

export interface RosterEntry {
  ticker: string;
  label: string;
  /** términos que, si aparecen en el texto, identifican a este símbolo. */
  aliases: string[];
}

// Orden = orden de presentación en la sección.
export const ROSTER: RosterEntry[] = [
  { ticker: "QQQ", label: "QQQ · Nasdaq", aliases: ["qqq", "nasdaq"] },
  { ticker: "SPY", label: "SPY · S&P 500", aliases: ["spy", "s&p", "sp500", "s and p"] },
  { ticker: "AAPL", label: "Apple", aliases: ["aapl", "apple"] },
  { ticker: "AMZN", label: "Amazon", aliases: ["amzn", "amazon"] },
  { ticker: "NFLX", label: "Netflix", aliases: ["nflx", "netflix", "netlfix", "netlix"] },
  { ticker: "GOOGL", label: "Google", aliases: ["googl", "goog", "google", "alphabet"] },
  { ticker: "MSFT", label: "Microsoft", aliases: ["msft", "microsoft"] },
  { ticker: "META", label: "Meta", aliases: ["meta", "facebook"] },
  { ticker: "TSLA", label: "Tesla", aliases: ["tsla", "tesla"] },
  { ticker: "NVDA", label: "Nvidia", aliases: ["nvda", "nvidia"] },
  { ticker: "UNH", label: "UnitedHealth", aliases: ["unh", "unitedhealth", "united health"] },
  { ticker: "SOXX", label: "SOXX · Semis", aliases: ["soxx", "semiconduct", "semis"] },
];

const BY_TICKER = new Map(ROSTER.map((r) => [r.ticker, r]));
export function rosterEntry(ticker: string): RosterEntry | undefined {
  return BY_TICKER.get(ticker.toUpperCase());
}

/**
 * Detecta a qué símbolo del roster pertenece un mensaje. Devuelve el ticker cuyo alias
 * aparece ANTES en el texto (el master suele nombrar el símbolo al inicio). null si
 * ninguno casa → mensaje de noticias generales.
 */
export function detectTicker(text: string): string | null {
  // El master nombra el símbolo al INICIO de cada mensaje ("⚠️Microsoft 4H…"),
  // siempre como primera palabra. Las noticias generales empiezan con un saludo
  // ("Buenos días, team…") y solo mencionan empresas más adentro del cuerpo. Por
  // eso miramos SOLO el arranque del mensaje: así una noticia macro larga no
  // arrastra el primer nombre de empresa que aparezca en mitad del texto.
  const head = text.split(/\r?\n/)[0].slice(0, 30);
  const hay = ` ${head.toLowerCase()} `;
  let best: { ticker: string; at: number } | null = null;
  for (const r of ROSTER) {
    for (const a of r.aliases) {
      // límites laxos: alias rodeado de algo que no sea letra/número (evita "meta"
      // dentro de "metálico", pero permite "meta," "meta:" "$meta").
      const re = new RegExp(`[^a-z0-9]${escapeRe(a)}[^a-z0-9]`, "i");
      const m = hay.match(re);
      if (m && m.index != null) {
        if (best == null || m.index < best.at) best = { ticker: r.ticker, at: m.index };
      }
    }
  }
  return best?.ticker ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Una sección del mensaje del master: su ticker (o null si es noticia) y el texto. */
export interface MasterSegment {
  ticker: string | null;
  text: string;
}

/** Un encabezado de análisis "‹alias› 4H" hallado en el texto: su posición y su ticker. */
interface Header {
  index: number;
  ticker: string;
}

/**
 * Halla los encabezados de análisis del master dentro de un texto. El master rotula CADA
 * análisis con la temporalidad "4H" pegada al nombre ("Netflix 4H", "SPY 4H.", "QQQ 4H"),
 * incluso cuando lo introduce a media frase ("…Comenzando con el QQQ 4H"). Ese "‹alias› 4H"
 * es un delimitador mucho más fiable que el ⚠️ (que a veces falta o decora noticias).
 *
 * Exige el "4H" para NO confundir menciones sueltas ("a diferencia del QQQ el spy…", que no
 * llevan 4H) con un encabezado de análisis real.
 */
function findHeaders(text: string): Header[] {
  const found: Header[] = [];
  for (const r of ROSTER) {
    for (const a of r.aliases) {
      // alias con frontera por delante, luego espacio(s) y "4h", sin letra pegada detrás.
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(a)}\\s+4\\s*h(?![a-z0-9])`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        found.push({ index: m.index + m[1].length, ticker: r.ticker });
        if (re.lastIndex === m.index) re.lastIndex++; // evita bucle en match vacío
      }
    }
  }
  found.sort((a, b) => a.index - b.index);
  // Si dos alias casan en la MISMA posición (p. ej. solapes del roster), gana el primero.
  const out: Header[] = [];
  let lastIndex = -1;
  for (const h of found) {
    if (h.index !== lastIndex) {
      out.push(h);
      lastIndex = h.index;
    }
  }
  return out;
}

/**
 * Trocea un fragmento por sus encabezados "‹alias› 4H". Lo normal es que un fragmento sea
 * UNA compañía (encabezado al inicio) → una sección. Pero el brief matutino trae el análisis
 * del QQQ incrustado al final ("…Comenzando con el QQQ 4H…"): en ese caso el texto ANTES del
 * encabezado (las noticias) sale como sección de noticias, y el QQQ como su propia sección.
 */
function segmentsFromChunk(chunk: string): MasterSegment[] {
  const heads = findHeaders(chunk);
  if (heads.length === 0) return [{ ticker: null, text: chunk.trim() }]; // sin 4H → noticia
  const segs: MasterSegment[] = [];
  const pre = chunk.slice(0, heads[0].index).trim();
  if (pre) segs.push({ ticker: null, text: pre });
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].index : chunk.length;
    segs.push({ ticker: heads[i].ticker, text: chunk.slice(heads[i].index, end).trim() });
  }
  return segs;
}

/**
 * Parte un ÚNICO mensaje del master en secciones por compañía.
 *
 * Dos delimitadores combinados: (1) el emoji ⚠️ con que el master separa bloques, y (2) el
 * encabezado "‹Compañía› 4H" que rotula cada análisis (más fiable que el ⚠️, que a veces
 * falta —QQQ va incrustado en el brief— o decora noticias —"⚠️Irán…"—).
 *
 * - Un mensaje de una sola compañía produce UNA sección → retrocompatible.
 * - El QQQ que el master introduce a media frase en el brief ("Comenzando con el QQQ 4H…")
 *   se extrae como su propia sección; el resto del brief queda como noticias.
 * - Todo lo que no casa con un símbolo (la noticia geopolítica, el resumen de fin de semana
 *   —párrafos con ⚠️ pero sin "4H"—) se funde en UNA entrada de noticias, en orden.
 *
 * PURA: sin red, fácil de testear.
 */
export function splitMasterMessage(text: string): MasterSegment[] {
  const raw = (text ?? "").replace(/\r\n/g, "\n");
  // Corta en cada ⚠️ (con o sin selector de variación U+FE0F); es solo una viñeta → se cae.
  const chunks = raw.split(/⚠️?/g).map((s) => s.trim()).filter(Boolean);

  const companies: MasterSegment[] = [];
  const newsParts: string[] = [];
  for (const chunk of chunks) {
    for (const seg of segmentsFromChunk(chunk)) {
      if (seg.ticker) companies.push(seg);
      else if (seg.text) newsParts.push(seg.text);
    }
  }

  const out = [...companies];
  if (newsParts.length > 0) out.push({ ticker: null, text: newsParts.join("\n\n") });
  return out;
}

/**
 * Extrae los niveles de precio citados: números de 2-5 dígitos (con hasta 2 decimales).
 * Descarta porcentajes y años sueltos evidentes. Devuelve únicos, en orden de aparición.
 * El cruce con el precio real (y el descarte de números fuera de rango) se hace después.
 */
export function extractLevels(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const re = /(?<![\w.])(\d{2,5}(?:\.\d{1,2})?)(?![\w%])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (n >= 1900 && n <= 2100 && Number.isInteger(n)) continue; // año suelto
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

export type Bias = "alcista" | "bajista" | "lateral";

const BULL = ["alcista", "recuperación", "recuperacion", "rebote", "rompe", "ruptura", "sube", "soporte", "compra", "long", "impulso"];
const BEAR = ["bajista", "cae", "caída", "caida", "corrección", "correccion", "techo", "resistencia", "venta", "short", "débil", "debil", "rechazo"];

/**
 * Sesgo aproximado por conteo de palabras clave. Es una PISTA, no un veredicto: el texto
 * completo del master se muestra tal cual, así que el matiz nunca se pierde.
 */
export function detectBias(text: string): Bias {
  const t = text.toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const w of BULL) if (t.includes(w)) bull++;
  for (const w of BEAR) if (t.includes(w)) bear++;
  if (bull > bear) return "alcista";
  if (bear > bull) return "bajista";
  return "lateral";
}
