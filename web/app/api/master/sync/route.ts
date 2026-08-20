// POST /api/master/sync → jala los mensajes nuevos reenviados al bot de Telegram, los
// clasifica por el roster fijo, extrae niveles/sesgo, guarda la imagen del chart y los
// mezcla en el día de hoy. Idempotente: el offset de Telegram evita reprocesar.

import { pullMessages, downloadPhoto, telegramConfigured } from "@/lib/telegram";
import { splitMasterMessage, extractLevels, detectBias } from "@/lib/masterRoster";
import { mergeEntries, saveImage, todayKey, type MasterEntry } from "@/lib/masterStore";

export const runtime = "nodejs";

export async function POST() {
  if (!(await telegramConfigured())) {
    return Response.json(
      { ok: false, error: "Falta el token del bot de Telegram. Pégalo arriba primero." },
      { status: 422 },
    );
  }

  const messages = await pullMessages();
  if (messages.length === 0) {
    return Response.json({ ok: true, added: 0, date: todayKey() });
  }

  const entries: MasterEntry[] = [];
  for (const m of messages) {
    let image: string | null = null;
    if (m.photoFileId) {
      const bytes = await downloadPhoto(m.photoFileId);
      if (bytes) image = await saveImage(m.messageId, bytes);
    }
    // Un mensaje puede traer VARIAS compañías (el master a veces las manda todas juntas).
    // Lo partimos por el marcador ⚠️ → una entrada por compañía + una de noticias.
    const segments = splitMasterMessage(m.text);
    segments.forEach((seg, i) => {
      entries.push({
        // id estable y único por segmento (message_id ×1000 + índice). Deja hueco de
        // sobra (<1000 secciones por mensaje) para no colisionar entre mensajes.
        id: m.messageId * 1000 + i,
        ticker: seg.ticker,
        kind: seg.ticker ? "ticker" : "news",
        text: seg.text,
        levels: seg.ticker ? extractLevels(seg.text) : [],
        bias: detectBias(seg.text),
        // El chart (si el mensaje trae uno) se asocia a la primera sección.
        image: i === 0 ? image : null,
        receivedAt: m.date * 1000 + i, // +i mantiene un orden estable dentro del mensaje
      });
    });
  }

  const { changed, day } = await mergeEntries(todayKey(), entries);
  return Response.json({ ok: true, added: changed, date: day.date });
}
