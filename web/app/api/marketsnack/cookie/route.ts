// GET  /api/marketsnack/cookie  → estado de la cookie (fuente, cuándo se actualizó,
//                                  huella parcial y si responde en vivo). NUNCA la
//                                  cookie completa.
// POST /api/marketsnack/cookie  → { cookie } : normaliza, prueba contra MarketSnack y,
//                                  solo si sirve, la guarda. Si falla, no pisa la buena.

import { cookieStatus, saveCookie } from "@/lib/marketsnackCookie";

export const runtime = "nodejs";

export async function GET() {
  const status = await cookieStatus();
  return Response.json(status);
}

export async function POST(request: Request) {
  let body: { cookie?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Cuerpo JSON inválido." }, { status: 400 });
  }
  const raw = typeof body.cookie === "string" ? body.cookie : "";
  const result = await saveCookie(raw);
  // 200 si se guardó; 422 si la cookie no sirve (rechazo esperado, no error del server).
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
