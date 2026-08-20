// GET    /api/tastytrade/status  → estado de conexión (configurado / entorno / conectado)
// DELETE /api/tastytrade/status  → borra el access token cacheado (fuerza refresh)

import { tastytradeStatus, tastytradeDisconnect } from "@/lib/tastytrade";

export const runtime = "nodejs";

export async function GET() {
  const status = await tastytradeStatus();
  return Response.json(status);
}

export async function DELETE() {
  await tastytradeDisconnect();
  return Response.json({ ok: true });
}
