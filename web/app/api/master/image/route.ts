// GET /api/master/image?name=<id>.jpg → sirve la imagen del chart guardada bajo data/
// (que no está en /public). basename() en el store evita path traversal.

import { readImage } from "@/lib/masterStore";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "";
  if (!name) return new Response("missing name", { status: 400 });
  const bytes = await readImage(name);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}
