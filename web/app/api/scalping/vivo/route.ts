// GET /api/scalping/vivo — las fichas de los diez tickers, por SSE.
//
// Va por streaming y no en una respuesta única porque cada ficha cuesta hasta 7
// llamadas a MarketSnack y las cadenas gordas (SPX, SPY) tardan ~20 s: en una
// sola respuesta, la pantalla se quedaría un minuto en blanco para enseñarlo todo
// de golpe. Así aparece la primera tarjeta en un par de segundos.
//
// Un ticker YA ANOTADO no se vuelve a pedir: se manda su fila congelada tal cual.
// Es lo correcto y además es lo barato — dentro de la ventana, los tickers que la
// tarea ya congeló no gastan ni una llamada.

import { MarketSnackError } from "@/lib/marketsnack";
import { bitacora, observarParaVista, SEGUIDOS, ScalpingScanError } from "@/lib/scalpingScan";
import { marketDateStr } from "@/lib/occ";
import type { ScalpingSseEvent } from "@/app/scalping/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cuántas fichas se piden a la vez.
 *
 * Tres y no diez: cada una abre una conexión al streamer de Tastytrade y encadena
 * varias cadenas de MarketSnack, y lanzarlas todas de golpe solo consigue que las
 * diez tarden lo que la más lenta más la cola. Con tres, la primera tarjeta sale
 * en un par de segundos y las demás van cayendo.
 */
const CONCURRENCIA = 3;

function sse(e: ScalpingSseEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

export async function GET() {
  const now = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ScalpingSseEvent) => controller.enqueue(encoder.encode(sse(e)));
      let resueltos = 0;
      let fallidos = 0;

      try {
        const hoy = marketDateStr(now);
        const congeladas = new Map(
          (await bitacora()).filter((o) => o.fecha === hoy).map((o) => [o.ticker, o]),
        );

        let i = 0;
        const carril = async (): Promise<void> => {
          while (i < SEGUIDOS.length) {
            const ticker = SEGUIDOS[i++];

            const ya = congeladas.get(ticker);
            if (ya) {
              send({ type: "obs", observacion: ya, congelada: true });
              resueltos += 1;
              continue;
            }

            try {
              const obs = await observarParaVista(ticker, now);
              send({ type: "obs", observacion: obs, congelada: false });
              resueltos += 1;
            } catch (e) {
              // Un ticker que falla NO tumba la vista: se dice en su tarjeta y los
              // otros nueve siguen. Es el mismo criterio que el escáner de spreads.
              const message =
                e instanceof MarketSnackError || e instanceof ScalpingScanError
                  ? e.message
                  : ((e as Error)?.message ?? "Error inesperado.");
              send({ type: "fallo", ticker, message });
              fallidos += 1;
            }
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCIA, SEGUIDOS.length) }, carril),
        );
        send({ type: "done", resueltos, fallidos });
      } catch (e) {
        send({ type: "error", message: (e as Error)?.message ?? "Error inesperado." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
