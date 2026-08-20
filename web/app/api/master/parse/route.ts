// POST /api/master/parse → recibe el texto pegado del master (todas las compañías juntas)
// y lo trocea en secciones con el MISMO parser que usa la sincronización de Telegram, para
// que la UI muestre qué compañías detectó y le puedas adjuntar la gráfica a cada una. No
// escribe nada: es solo el paso de "previsualizar" antes de guardar en /api/master/paste.

import { splitMasterMessage, rosterEntry } from "@/lib/masterRoster";

export const runtime = "nodejs";

export interface ParsedSegment {
  index: number;
  ticker: string | null;
  label: string; // "QQQ · Nasdaq" o "Noticias del día"
  preview: string; // primeras líneas, para reconocer la sección
}

export interface ParseResult {
  segments: ParsedSegment[];
}

function preview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

export async function POST(request: Request) {
  const { text } = (await request.json().catch(() => ({}))) as { text?: string };
  if (!text || !text.trim()) {
    return Response.json({ error: "Pega primero el texto del master." }, { status: 422 });
  }

  const segments: ParsedSegment[] = splitMasterMessage(text).map((seg, index) => ({
    index,
    ticker: seg.ticker,
    label: seg.ticker ? rosterEntry(seg.ticker)?.label ?? seg.ticker : "Noticias del día",
    preview: preview(seg.text),
  }));

  return Response.json({ segments } satisfies ParseResult);
}
