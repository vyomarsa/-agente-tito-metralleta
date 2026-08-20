// POST /api/schwab/exchange — canje manual del code cuando el redirect es
// https://127.0.0.1 (placeholder). El usuario copia de la barra del navegador la
// URL completa a la que Schwab lo redirigió y la pega; aquí extraemos el `code`.
//
// Body JSON: { "url": "https://127.0.0.1/?code=XXXX%40&session=..." }
//        o:  { "code": "XXXX@" }

import { exchangeCode, SchwabError } from "@/lib/schwab";

export const runtime = "nodejs";

function extractCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // ¿Es una URL completa? Sacamos el parámetro code.
  try {
    const u = new URL(s);
    const code = u.searchParams.get("code");
    if (code) return code;
  } catch {
    // no era URL; puede ser el code pelado
  }
  // Fallback: el usuario pegó solo el code.
  if (!s.includes("://") && !s.includes(" ")) return s;
  return null;
}

export async function POST(request: Request) {
  let body: { url?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido." }, { status: 400 });
  }

  const raw = body.code ?? body.url ?? "";
  const code = extractCode(raw);
  if (!code) {
    return Response.json(
      { ok: false, error: "No se encontró el parámetro 'code' en lo que pegaste." },
      { status: 400 },
    );
  }

  try {
    await exchangeCode(code);
    return Response.json({ ok: true });
  } catch (e) {
    const needsAuth = e instanceof SchwabError ? e.needsAuth : false;
    const msg = e instanceof SchwabError ? e.message : "Error canjeando el code.";
    return Response.json({ ok: false, error: msg, needsAuth }, { status: 502 });
  }
}
