// GET    /api/schwab/status  → estado de conexión (configurado / conectado / días de refresh)
// DELETE /api/schwab/status  → desconecta (borra los tokens guardados)

import { schwabStatus, schwabDisconnect } from "@/lib/schwab";

export const runtime = "nodejs";

export async function GET() {
  const status = await schwabStatus();
  return Response.json(status);
}

export async function DELETE() {
  await schwabDisconnect();
  return Response.json({ ok: true });
}
