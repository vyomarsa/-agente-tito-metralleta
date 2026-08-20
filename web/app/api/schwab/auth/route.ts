// GET /api/schwab/auth — inicia el flujo OAuth: redirige al login/consentimiento de Schwab.
//
// Tras aprobar, Schwab redirige de vuelta a SCHWAB_REDIRECT_URI con ?code=...
// Ese callback lo maneja /api/schwab/callback.

import { NextResponse } from "next/server";
import { buildAuthorizeUrl, SchwabError } from "@/lib/schwab";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.redirect(buildAuthorizeUrl());
  } catch (e) {
    const msg = e instanceof SchwabError ? e.message : "Error iniciando OAuth de Schwab.";
    return new Response(msg, { status: 500 });
  }
}
