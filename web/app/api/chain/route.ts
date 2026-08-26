// GET /api/chain?ticker=XXX — transmite los pasos del proceso por SSE y al final los datos.

import { countExpirations, sortByOpenInterestDesc, toRow } from "@/lib/compute";
import { structureScore } from "@/lib/structure";
import { saveChainSnapshot, type ChainSnapshot } from "@/lib/chainStore";
import { fetchOptionChain, MassiveError } from "@/lib/massive";
import { fetchChainFromTastytrade, fetchChainFromMarketSnack, fetchChainFromSchwab } from "@/lib/chainSources";
import { cachedCompany } from "@/lib/companyStore";
import { tastytradeConfigured } from "@/lib/tastytrade";
import { schwabConfigured } from "@/lib/schwab";
import type { ChainEvent, ChainMeta, RawContract, Row } from "@/lib/types";

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
        // `cachedCompany` sirve la referencia del disco y la cotización de Tastytrade.
        // Antes esto era `fetchCompany` contra Massive y costaba **16,5 s medidos**
        // solo en esperar turno de cuota: más que descargar la cadena entera.
        const company = await cachedCompany(ticker);
        send({ type: "company", company });

        // Cascada: Tastytrade → MarketSnack → Schwab → Massive.
        // Con el plan gratis de Massive (5 peticiones/minuto) la snapshot paginada
        // (~20 páginas para AAPL) no puede terminar, así que Massive es el último recurso.
        let contracts: RawContract[] = [];
        let underlyingPrice: number | null = null;
        let pages = 1;
        let truncated = false;
        let fuente: "tastytrade" | "marketsnack" | "schwab" | "massive" = "tastytrade";

        // 1. Tastytrade
        if (tastytradeConfigured()) {
          send({ type: "step", label: `Descargando cadena de ${ticker} desde Tastytrade…` });
          try {
            const tt = await fetchChainFromTastytrade(ticker);
            if (tt.contracts.length > 0) {
              contracts = tt.contracts;
              underlyingPrice = tt.underlyingPrice;
              send({
                type: "step",
                label: `Cadena de ${ticker} lista (Tastytrade)`,
                detail: `${contracts.length} contratos · ${tt.expirations} vencimientos`,
              });
            }
          } catch {
            send({ type: "step", label: "Tastytrade no respondió; probando MarketSnack…" });
          }
        }

        // 2. MarketSnack
        if (contracts.length === 0) {
          fuente = "marketsnack";
          send({ type: "step", label: `Descargando cadena de ${ticker} desde MarketSnack…` });
          try {
            const ms = await fetchChainFromMarketSnack(ticker);
            if (ms.contracts.length > 0) {
              contracts = ms.contracts;
              underlyingPrice = ms.underlyingPrice;
              send({
                type: "step",
                label: `Cadena de ${ticker} lista (MarketSnack)`,
                detail: `${contracts.length} contratos · ${ms.expirations} vencimientos`,
              });
            } else {
              send({ type: "step", label: "MarketSnack sin contratos; probando Schwab…" });
            }
          } catch {
            send({ type: "step", label: "MarketSnack no respondió; probando Schwab…" });
          }
        }

        // 3. Schwab
        if (contracts.length === 0 && schwabConfigured()) {
          fuente = "schwab";
          send({ type: "step", label: `Descargando cadena de ${ticker} desde Schwab…` });
          try {
            const sw = await fetchChainFromSchwab(ticker);
            if (sw.contracts.length > 0) {
              contracts = sw.contracts;
              underlyingPrice = sw.underlyingPrice;
              send({
                type: "step",
                label: `Cadena de ${ticker} lista (Schwab)`,
                detail: `${contracts.length} contratos · ${sw.expirations} vencimientos`,
              });
            } else {
              send({ type: "step", label: "Schwab sin contratos; probando Massive…" });
            }
          } catch {
            send({ type: "step", label: "Schwab no respondió; probando Massive…" });
          }
        }

        // 4. Massive (último recurso)
        if (contracts.length === 0) {
          fuente = "massive";
          send({ type: "step", label: "Conectando con Massive…" });
          const r = await fetchOptionChain(ticker, {
            onPage: (page, accumulated) => {
              send({
                type: "step",
                label: `Descargando option chain de ${ticker} — página ${page}`,
                detail: `${accumulated} contratos`,
              });
            },
          });
          contracts = r.contracts;
          underlyingPrice = r.underlyingPrice;
          pages = r.pages;
          truncated = r.truncated;
        }

        if (contracts.length === 0) {
          send({ type: "error", message: `Sin contratos para "${ticker}" en ninguna fuente.` });
          controller.close();
          return;
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
            : err instanceof Error
              ? err.message
              : "Error inesperado al cargar la cadena.";
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
