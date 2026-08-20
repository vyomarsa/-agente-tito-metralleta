// GET  /api/telegram/token  → estado del bot (fuente, cuándo, si vive, @usuario).
// POST /api/telegram/token  → { token } : valida con getMe y, solo si sirve, lo guarda.

import { saveToken, tokenStatus } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await tokenStatus());
}

export async function POST(request: Request) {
  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Cuerpo JSON inválido." }, { status: 400 });
  }
  const raw = typeof body.token === "string" ? body.token : "";
  const result = await saveToken(raw);
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
