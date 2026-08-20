// GET /api/chain?ticker=XXX — transmite los pasos del proceso por SSE y al final los datos.

import { countExpirations, sortByOpenInterestDesc, toRow } from "@/lib/compute";
import { structureScore } from "@/lib/structure";
import { saveChainSnapshot, type ChainSnapshot } from "@/lib/chainStore";
import { fetchCompany, fetchOptionChain, MassiveError } from "@/lib/massive";
import { fetchExpirations, fetchOptionChain2 } from "@/lib/marketsnack";
import { normalizeChain2, nearestExpirations } from "@/lib/optionChain2";
import { estimateSpotFromChain } from "@/lib/zerodte";
import type { ChainEvent, ChainMeta, Row } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: ChainEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChainEvent) =>
        controller.enqueue(encoder.encode(sse(event)));

      try {
        if (!ticker) {
          send({ type: "error", message: "Escribe un ticker (p. ej. AAPL)." });
          controller.close();
          return;
        }

        send({ type: "step", label: `Buscando información de ${ticker}…` });
        const company = await fetchCompany(ticker);
        send({ type: "company", company });

        send({ type: "step", label: "Conectando con Massive…" });

        const { contracts, underlyingPrice: massivePrice, pages, truncated } =
          await fetchOptionChain(ticker, {
            onPage: (page, accumulated) => {
              send({
                type: "step",
                label: `Descargando option chain de ${ticker} — página ${page}`,
                detail: `${accumulated} contratos`,
              });
            },
          });

        if (contracts.length === 0) {
          send({ type: "error", message: `Sin contratos para "${ticker}".` });
          controller.close();
          return;
        }

        // Índices como SPX: Massive no cotiza el subyacente (necesitaría `I:SPX`,
        // fuera del plan). Derivamos el spot por paridad put-call de la cadena de
        // MarketSnack, igual que la vista 0DTE. Degrada con gracia: sin cookie o si
        // MarketSnack falla, queda null y el dashboard sigue como hasta ahora.
        let underlyingPrice = massivePrice;
        if (underlyingPrice == null) {
          send({ type: "step", label: `Massive no cotiza ${ticker}; derivando spot de MarketSnack…` });
          try {
            const exps = await fetchExpirations(ticker);
            const front = nearestExpirations(exps.map((e) => e.date), 1, new Date())[0];
            if (front) {
              const ms = normalizeChain2(await fetchOptionChain2(ticker, front));
              const spot = estimateSpotFromChain(ms);
              if (spot && spot > 0) {
                underlyingPrice = spot;
                send({ type: "step", label: `Spot de ${ticker} por paridad: ${spot.toFixed(2)}` });
              }
            }
          } catch {
            // sin cookie o fallo de MarketSnack → seguimos sin spot
          }
        }

        let rows: Row[] = contracts.map(toRow);
        const expirations = countExpirations(rows);
        send({
          type: "step",
          label: `Consolidando ${rows.length} contratos en ${expirations} vencimientos…`,
        });

        send({ type: "step", label: "Calculando Open Premium por strike…" });
        send({ type: "step", label: "Calculando Valor Nocional…" });

        send({ type: "step", label: "Ordenando por Open Interest (mayor → menor)…" });
        rows = sortByOpenInterestDesc(rows);

        send({ type: "step", label: "Analizando acumulación por strike y vencimiento…" });
        const structure = structureScore(rows);

        // Foto diaria de la cadena: el historial de 45 días se acumula hacia adelante.
        send({ type: "step", label: "Guardando foto diaria de la cadena…" });
        let history: ChainSnapshot[] = [];
        try {
          history = (await saveChainSnapshot(ticker, structure)).snapshots;
        } catch {
          // el guardado no debe romper el reporte
        }

        const meta: ChainMeta = {
          ticker,
          underlyingPrice,
          contractCount: rows.length,
          expirationCount: expirations,
          pages,
          truncated,
        };
        send({ type: "done", rows, meta, structure, history });
      } catch (err) {
        const message =
          err instanceof MassiveError
            ? err.message
            : "Error inesperado al consultar Massive.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
