// POST /api/master/paste (multipart/form-data) → ingiere el análisis del master pegándolo
// DIRECTO en Tito, sin pasar por Telegram. El campo `text` trae todo el mensaje del master
// (varias compañías juntas, como lo copias de WhatsApp) y cada archivo `img_<index>` es la
// gráfica de la sección con ese índice (el mismo índice que devolvió /api/master/parse).
//
// Reusa el parser del roster (splitMasterMessage/extractLevels/detectBias) y el mismo
// almacén por día que la sincronización de Telegram, así el resultado se ve idéntico.

import { splitMasterMessage, extractLevels, detectBias, ROSTER, type MasterSegment } from "@/lib/masterRoster";
import { mergeEntries, saveImage, loadDay, todayKey, type MasterEntry } from "@/lib/masterStore";

export const runtime = "nodejs";

// Rango de ids propio del flujo "pegar", MUY por encima de los de Telegram (message_id×1000)
// para no colisionar. Deterministas por ticker → volver a pegar CORRIGE la sección, no la
// duplica (mergeEntries deduplica por id). La sección de noticias es siempre una sola.
const PASTE_BASE = 9_000_000_000;
const NEWS_ID = PASTE_BASE + 900;

function idForSegment(seg: MasterSegment): number {
  if (!seg.ticker) return NEWS_ID;
  const idx = ROSTER.findIndex((r) => r.ticker === seg.ticker);
  return PASTE_BASE + (idx >= 0 ? idx : 100);
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "Envío inválido (esperaba un formulario)." }, { status: 400 });
  }

  const text = String(form.get("text") ?? "");
  if (!text.trim()) {
    return Response.json({ ok: false, error: "Pega primero el texto del master." }, { status: 422 });
  }

  const segments = splitMasterMessage(text);

  // Conserva la gráfica ya guardada si en este envío no adjuntas una nueva para esa sección
  // (p. ej. re-pegas el texto para corregir un typo sin volver a subir los charts).
  const prev = await loadDay(todayKey());
  const prevImage = new Map((prev?.entries ?? []).map((e) => [e.id, e.image]));

  const now = Date.now();
  const entries: MasterEntry[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const id = idForSegment(seg);

    let image: string | null = prevImage.get(id) ?? null;
    const file = form.get(`img_${i}`);
    if (file && typeof file !== "string" && file.size > 0) {
      const bytes = Buffer.from(await file.arrayBuffer());
      image = await saveImage(id, bytes);
    }

    entries.push({
      id,
      ticker: seg.ticker,
      kind: seg.ticker ? "ticker" : "news",
      text: seg.text,
      levels: seg.ticker ? extractLevels(seg.text) : [],
      bias: detectBias(seg.text),
      image,
      receivedAt: now + i, // +i mantiene el orden de aparición dentro del mensaje
    });
  }

  const { changed, day } = await mergeEntries(todayKey(), entries);
  return Response.json({ ok: true, added: changed, date: day.date });
}
