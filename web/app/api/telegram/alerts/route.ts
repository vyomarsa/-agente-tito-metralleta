// /api/telegram/alerts — conectar y probar las alertas del agente.
//
//   GET                      → estado (¿bot configurado? ¿chat vinculado?)
//   POST {action:"discover"} → busca a quién escribirle en los mensajes pendientes
//   POST {action:"link", chatId}
//   POST {action:"test"}     → manda un mensaje de prueba al chat vinculado
//   POST {action:"unlink"}   → deja de mandar alertas
//
// El chat va SEPARADO del token a propósito: el bot lleva tiempo configurado para
// la ingesta del master, que solo RECIBE. Tenerlo configurado no debe implicar que
// empiece a escribirle a nadie — hace falta vincular el destino a mano.

import {
  discoverChats, getAlertChatId, saveAlertChatId, sendAlert, telegramConfigured,
} from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [configured, chatId] = await Promise.all([telegramConfigured(), getAlertChatId()]);
  return Response.json({ configured, chatId, alertsOn: Boolean(configured && chatId) });
}

export async function POST(request: Request) {
  let body: { action?: string; chatId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Cuerpo JSON inválido." }, { status: 400 });
  }

  if (!(await telegramConfigured())) {
    return Response.json(
      { ok: false, error: "No hay bot de Telegram configurado. Pega el token en /ajustes." },
      { status: 400 },
    );
  }

  if (body.action === "discover") {
    const chats = await discoverChats();
    return Response.json({
      ok: true,
      chats,
      note: chats.length === 0
        ? "No hay mensajes pendientes del bot. Escríbele algo por Telegram (un simple 'hola') y vuelve a buscar."
        : "",
    });
  }

  if (body.action === "link") {
    const chatId = (body.chatId ?? "").trim();
    if (!/^-?\d+$/.test(chatId)) {
      return Response.json({ ok: false, error: "chatId debe ser numérico." }, { status: 400 });
    }
    await saveAlertChatId(chatId);
    const r = await sendAlert(
      "✅ <b>Alertas conectadas.</b>\n\nA partir de ahora te aviso cuando los agentes abran o cierren posiciones.\n<i>Todo es simulación (paper).</i>",
    );
    return Response.json({ ok: true, chatId, delivered: r.ok, reason: r.reason });
  }

  if (body.action === "test") {
    const r = await sendAlert("🔔 Prueba de alertas de Tito. Si lees esto, funciona.");
    return Response.json({ ok: r.ok, reason: r.reason });
  }

  if (body.action === "unlink") {
    await saveAlertChatId(null);
    return Response.json({ ok: true });
  }

  return Response.json(
    { ok: false, error: "action debe ser 'discover', 'link', 'test' o 'unlink'." },
    { status: 400 },
  );
}
