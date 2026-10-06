// GET/PUT /api/contract-search/likes — copia en servidor de los "me gusta" de
// Búsqueda de contratos (ver lib/contractSearchLikesStore.ts). El navegador sigue
// siendo la fuente de verdad para la UI; esto existe para que el agente pueda leer
// qué contratos hay que agregar a Robinhood sin acceso al localStorage.

import { loadLikes, saveLikes } from "@/lib/pdf/contractSearchLikesStore";
import { mergeLikes, type LikedContract } from "@/lib/pdf/contractSearchLikes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const entries = await loadLikes();
  return Response.json({ entries });
}

// Merge, no reemplazo: dos navegadores (desktop, celular) mandan cada uno su
// vista completa de localStorage — un reemplazo ciego pisaría los "me gusta"
// hechos desde el otro dispositivo (ver mergeLikes en lib/contractSearchLikes.ts).
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { entries?: LikedContract[] } | null;
  if (!body || !Array.isArray(body.entries)) {
    return Response.json({ error: "Se espera { entries: [...] }" }, { status: 400 });
  }
  const merged = mergeLikes(await loadLikes(), body.entries);
  await saveLikes(merged);
  return Response.json({ ok: true, entries: merged });
}
