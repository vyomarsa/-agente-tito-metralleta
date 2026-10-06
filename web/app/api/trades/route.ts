// /api/trades — bitácora de paper trades (SIMULACIÓN). GET lista + stats; POST muta según
// `action`. Nada de esto ejecuta órdenes reales: solo guarda planes y mide.
//
// Las mutaciones van por POST {action} (no por [id]/PATCH/DELETE) para no lidiar con el
// params-as-Promise de Next 15 y mantener todo en un archivo.

import { randomUUID } from "crypto";
import {
  loadPaperTrades,
  addPaperTrade,
  updatePaperTrade,
  removePaperTrade,
} from "@/lib/paperTradeStore";
import {
  summarize,
  realizedPnl,
  type PaperTrade,
  type OptionType,
  type Direction,
} from "@/lib/paperTrade";
import { commissionOf } from "@/lib/commissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string, status = 400) {
  return Response.json({ ok: false, error }, { status });
}

async function listResponse() {
  const trades = await loadPaperTrades();
  return Response.json({ ok: true, trades, summary: summarize(trades) });
}

export async function GET() {
  return listResponse();
}

// --- Alta de un trade manual -----------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function buildTrade(body: Record<string, unknown>): { trade?: PaperTrade; error?: string } {
  const ticker = String(body.ticker ?? "").trim().toUpperCase();
  if (!ticker) return { error: "Falta el ticker." };

  const optionType = body.optionType === "put" ? "put" : "call";
  const strike = num(body.strike);
  if (strike == null || strike <= 0) return { error: "Strike inválido." };

  const expiration = String(body.expiration ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return { error: "Vencimiento inválido (YYYY-MM-DD)." };

  const trigger = num(body.trigger);
  const target = num(body.target);
  const stop = num(body.stop);
  if (trigger == null || target == null || stop == null) {
    return { error: "Gatillo, objetivo y stop son obligatorios (precio del subyacente)." };
  }

  // Dirección: explícita, o inferida (call→sube, put→baja).
  const direction: Direction =
    body.direction === "up" || body.direction === "down"
      ? body.direction
      : optionType === "put"
        ? "down"
        : "up";

  const contracts = Math.max(1, Math.round(num(body.contracts) ?? 1));
  const probability = num(body.probability); // opcional
  const note = body.note ? String(body.note).slice(0, 40) : null;
  const trailing = body.trailing !== false; // por defecto activado

  const trade: PaperTrade = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: "manual",
    ticker,
    optionType: optionType as OptionType,
    strike,
    expiration,
    direction,
    trigger,
    target,
    stop,
    trailing,
    probability: probability != null ? Math.max(0, Math.min(100, probability)) : null,
    note,
    contracts,
    status: "pendiente",
    entryPrice: null,
    entryAt: null,
    exitPrice: null,
    exitAt: null,
    peakPrice: null,
    currentUnderlying: null,
    currentPrice: null,
    updatedAt: null,
    closeReason: null,
    verdict: null,
  };
  return { trade };
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Cuerpo JSON inválido.");
  }
  const action = String(body.action ?? "create");

  if (action === "create") {
    const { trade, error } = buildTrade(body);
    if (error || !trade) return bad(error ?? "No se pudo crear el trade.");
    await addPaperTrade(trade);
    return listResponse();
  }

  const id = String(body.id ?? "");
  if (!id) return bad("Falta el id del trade.");

  if (action === "setContracts") {
    const contracts = Math.max(1, Math.round(num(body.contracts) ?? 1));
    await updatePaperTrade(id, (t) => ({ ...t, contracts }));
    return listResponse();
  }

  if (action === "close") {
    const now = new Date().toISOString();
    await updatePaperTrade(id, (t) => {
      if (t.status === "pendiente") {
        // Nunca se activó → se cancela (expirada por decisión manual, sin P&L).
        return { ...t, status: "expirada", closeReason: "manual", exitAt: now, updatedAt: now, verdict: "Cancelada antes de activarse." };
      }
      if (t.status === "activa") {
        const exit = t.currentPrice ?? t.entryPrice;
        const closed: PaperTrade = { ...t, exitPrice: exit, exitAt: now, updatedAt: now, closeReason: "manual" };
        const fees = commissionOf(closed.contracts, 1, true);
        const pnl = realizedPnl(closed) - fees;
        return { ...closed, fees, status: pnl >= 0 ? "ganada" : "perdida", verdict: `Cerrada a mano con P&L ${pnl >= 0 ? "+" : ""}$${Math.round(pnl)} (neto de $${fees.toFixed(2)} de comisiones).` };
      }
      return t; // ya cerrada
    });
    return listResponse();
  }

  if (action === "delete") {
    await removePaperTrade(id);
    return listResponse();
  }

  return bad(`Acción desconocida: ${action}`);
}
