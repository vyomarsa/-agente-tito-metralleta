// Puente con Telegram para ingerir el análisis de pre-market del "master". Solo servidor.
//
// Por qué Telegram y no WhatsApp: la API oficial de WhatsApp no deja leer los chats
// que TÚ recibes (solo un número de negocio al que la gente escribe), y los bots no
// oficiales van contra sus términos (riesgo de baneo) y exigen un proceso 24/7. Con
// Telegram reenvías los mensajes del master a un bot y el agente los JALA cuando abres
// la sección (getUpdates), sin proceso permanente y con la imagen incluida.
//
// El token vive en data/telegram.json (gitignored, no sale del equipo) y se lee en cada
// petición; .env.local sirve de respaldo. Guardar un token nuevo surte efecto sin
// reiniciar. El "offset" de getUpdates se persiste para no reprocesar mensajes.

import { promises as fs } from "fs";
import path from "path";
import { splitForTelegram } from "./alertText";

const TOKEN_FILE = path.join(process.cwd(), "data", "telegram.json");
const API = "https://api.telegram.org";

interface StoredToken {
  token: string;
  updatedAt: number;
  /** último update_id procesado (+1) para no repetir mensajes en getUpdates. */
  offset: number;
  /**
   * A dónde ENVIAR las alertas. Separado del token a propósito: el bot puede
   * estar configurado (para la ingesta del master, que solo RECIBE) sin que las
   * alertas estén activadas. Sin esto, no se manda nada.
   */
  alertChatId?: string;
}

export type TokenSource = "file" | "env" | "none";

export interface TokenStatus {
  source: TokenSource;
  updatedAt: number | null;
  /** ¿responde getMe con OK? */
  live: boolean;
  /** @usuario del bot (si vive), para reconocerlo. */
  botUsername: string | null;
}

/** Un mensaje reenviado al bot, ya normalizado a lo que nos importa. */
export interface TelegramMessage {
  messageId: number;
  date: number; // epoch segundos
  text: string; // texto o caption (lo que traiga)
  photoFileId: string | null; // la foto de mayor resolución, si hay
}

// ---------------------------------------------------------------------------
// Archivo del token (data/telegram.json)
// ---------------------------------------------------------------------------

async function readStored(): Promise<StoredToken | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredToken;
    if (parsed && typeof parsed.token === "string" && parsed.token.trim()) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function writeStored(rec: StoredToken): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(rec, null, 2), "utf8");
}

/** Normaliza lo pegado: quita espacios y un prefijo "token:" o "bot" accidental. */
export function normalizeToken(raw: string): string {
  return (raw ?? "").trim().replace(/^token:\s*/i, "").replace(/^bot/i, "").trim();
}

/** Token a usar AHORA: archivo → .env.local (TELEGRAM_BOT_TOKEN). null si no hay. */
export async function getToken(): Promise<string | null> {
  const stored = await readStored();
  if (stored) return stored.token;
  const env = process.env.TELEGRAM_BOT_TOKEN;
  return env && env.trim() ? normalizeToken(env) : null;
}

export async function telegramConfigured(): Promise<boolean> {
  return (await getToken()) != null;
}

// ---------------------------------------------------------------------------
// Llamadas a la API de Telegram
// ---------------------------------------------------------------------------

interface TgChat {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}
interface TgUpdate {
  update_id: number;
  message?: { chat?: TgChat };
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function tgCall<T>(token: string, method: string, params?: Record<string, string>): Promise<T | null> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
  try {
    const res = await fetch(`${API}/bot${token}/${method}${qs}`, { cache: "no-store" });
    const json = (await res.json()) as TgResponse<T>;
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

/** getMe: valida el token y devuelve el @usuario del bot. */
async function getMe(token: string): Promise<{ username: string | null } | null> {
  const me = await tgCall<{ username?: string }>(token, "getMe");
  if (!me) return null;
  return { username: me.username ?? null };
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface SaveTokenResult {
  ok: boolean;
  error?: string;
  status?: TokenStatus;
}

/** Valida el token con getMe y (solo si sirve) lo guarda sin pisar el offset previo. */
export async function saveToken(raw: string): Promise<SaveTokenResult> {
  const token = normalizeToken(raw);
  if (!token) return { ok: false, error: "No pegaste ningún token." };
  if (!/^\d+:[\w-]+$/.test(token)) {
    return { ok: false, error: "Ese token no tiene el formato de Telegram (123456789:AA...)." };
  }
  const me = await getMe(token);
  if (!me) return { ok: false, error: "Telegram rechazó ese token. Revísalo con @BotFather." };
  const prev = await readStored();
  await writeStored({ token, updatedAt: Date.now(), offset: prev?.offset ?? 0 });
  return { ok: true, status: await tokenStatus() };
}

export async function tokenStatus(): Promise<TokenStatus> {
  const stored = await readStored();
  const env = process.env.TELEGRAM_BOT_TOKEN;
  let source: TokenSource;
  let token: string | null;
  let updatedAt: number | null = null;
  if (stored) {
    source = "file";
    token = stored.token;
    updatedAt = stored.updatedAt;
  } else if (env && env.trim()) {
    source = "env";
    token = normalizeToken(env);
  } else {
    return { source: "none", updatedAt: null, live: false, botUsername: null };
  }
  const me = await getMe(token);
  return { source, updatedAt, live: me != null, botUsername: me?.username ?? null };
}

/**
 * Jala los mensajes nuevos reenviados al bot desde el último offset. Toma texto o
 * caption y la foto de mayor resolución. Avanza y persiste el offset SOLO si el token
 * vive (así no perdemos mensajes ante un fallo de red). Devuelve [] si no hay token.
 */
export async function pullMessages(): Promise<TelegramMessage[]> {
  const stored = await readStored();
  const token = stored?.token ?? (process.env.TELEGRAM_BOT_TOKEN ? normalizeToken(process.env.TELEGRAM_BOT_TOKEN) : null);
  if (!token) return [];
  const offset = stored?.offset ?? 0;

  interface Update {
    update_id: number;
    message?: {
      message_id: number;
      date: number;
      text?: string;
      caption?: string;
      photo?: { file_id: string; width: number; height: number }[];
    };
    channel_post?: Update["message"];
  }
  const updates = await tgCall<Update[]>(token, "getUpdates", {
    offset: String(offset),
    timeout: "0",
    allowed_updates: JSON.stringify(["message", "channel_post"]),
  });
  if (updates == null) return []; // fallo: no tocamos el offset, reintentaremos

  const out: TelegramMessage[] = [];
  let maxUpdateId = offset - 1;
  for (const u of updates) {
    if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
    const m = u.message ?? u.channel_post;
    if (!m) continue;
    const text = (m.caption ?? m.text ?? "").trim();
    // La foto llega en varias resoluciones; la última es la mayor.
    const photoFileId = m.photo && m.photo.length > 0 ? m.photo[m.photo.length - 1].file_id : null;
    if (!text && !photoFileId) continue; // nada útil (p. ej. un sticker)
    out.push({ messageId: m.message_id, date: m.date, text, photoFileId });
  }

  // Persistimos el nuevo offset para no reprocesar estos mensajes.
  if (stored && maxUpdateId >= offset) {
    await writeStored({ ...stored, offset: maxUpdateId + 1 });
  }
  return out;
}

/** Descarga los bytes de una foto por su file_id (getFile → /file/bot<token>/<path>). */
export async function downloadPhoto(fileId: string): Promise<Buffer | null> {
  const token = await getToken();
  if (!token) return null;
  const file = await tgCall<{ file_path?: string }>(token, "getFile", { file_id: fileId });
  if (!file?.file_path) return null;
  try {
    const res = await fetch(`${API}/file/bot${token}/${file.file_path}`, { cache: "no-store" });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ALERTAS SALIENTES
//
// Hasta 2026-08-24 el bot solo RECIBÍA (ingesta del master). Esto añade el envío,
// que el dueño pidió para enterarse de las posiciones que abre el agente sin
// tener que mirar la pantalla.
//
// Va con chat de destino EXPLÍCITO y guardado aparte del token: tener el bot
// configurado no debe implicar que empiece a escribirle a alguien. Mientras no
// haya `alertChatId`, `sendAlert` no manda nada y lo dice.
// ---------------------------------------------------------------------------

/** Chat al que van las alertas, o null si no se ha conectado. */
export async function getAlertChatId(): Promise<string | null> {
  const rec = await readStored();
  return rec?.alertChatId ?? null;
}

export async function saveAlertChatId(chatId: string | null): Promise<void> {
  const rec = await readStored();
  if (!rec) throw new Error("No hay bot de Telegram configurado.");
  await writeStored({ ...rec, alertChatId: chatId ?? undefined, updatedAt: Date.now() });
}

export interface DiscoveredChat {
  chatId: string;
  name: string;
}

/**
 * Busca a quién escribirle, leyendo los mensajes pendientes del bot.
 *
 * OJO — usa el offset GUARDADO y NO lo avanza. `getUpdates?offset=N` confirma
 * (y borra) todo lo anterior a N, así que pasar el offset ya almacenado no
 * destruye nada nuevo; guardar uno mayor sí se comería mensajes que la ingesta
 * del master todavía no ha procesado.
 */
export async function discoverChats(): Promise<DiscoveredChat[]> {
  const token = await getToken();
  if (!token) return [];
  const rec = await readStored();
  const updates = await tgCall<TgUpdate[]>(token, "getUpdates", {
    offset: String(rec?.offset ?? 0),
    limit: "100",
  });
  if (!updates) return [];

  const vistos = new Map<string, string>();
  for (const u of updates) {
    const chat = u.message?.chat;
    if (!chat?.id) continue;
    const nombre = [chat.first_name, chat.last_name].filter(Boolean).join(" ")
      || chat.username || chat.title || String(chat.id);
    vistos.set(String(chat.id), nombre);
  }
  return [...vistos.entries()].map(([chatId, name]) => ({ chatId, name }));
}

export interface SendResult {
  ok: boolean;
  /** Por qué no se mandó (vacío si se mandó). */
  reason: string;
}

/**
 * Manda una alerta. Best-effort a propósito: NUNCA debe tumbar al que la llama.
 * Una posición que se abre bien pero cuya notificación falla sigue siendo una
 * posición abierta bien.
 */
export async function sendAlert(text: string): Promise<SendResult> {
  try {
    const token = await getToken();
    if (!token) return { ok: false, reason: "sin token de Telegram" };
    const chatId = await getAlertChatId();
    if (!chatId) return { ok: false, reason: "alertas sin conectar (falta chat de destino)" };
    // Telegram RECHAZA por encima de 4096 caracteres, y como esto es best-effort
    // un aviso largo no fallaba ruidosamente: desaparecía. Con la venta de prima
    // mandando hasta 5 órdenes completas en una tanda, trocear deja de ser opcional.
    const trozos = splitForTelegram(text);
    for (const trozo of trozos) {
      const res = await tgCall<unknown>(token, "sendMessage", {
        chat_id: chatId,
        text: trozo,
        parse_mode: "HTML",
        disable_web_page_preview: "true",
      });
      // Si un trozo falla se corta: seguir mandando los siguientes dejaría un
      // mensaje con un agujero en medio, que se lee peor que uno que no llegó.
      if (res == null) return { ok: false, reason: "Telegram rechazó el envío" };
    }
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "error inesperado" };
  }
}
