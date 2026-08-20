// GET /api/schwab/callback?code=... — pata final del OAuth cuando el redirect
// registrado apunta a esta ruta. Canjea el code por tokens y redirige a /schwab.
//
// Si tu Callback URL en developer.schwab.com es el placeholder https://127.0.0.1
// (sin ruta), esta ruta NO se invoca sola: usa el pegado manual de la URL en la
// página /schwab, que llama a POST /api/schwab/exchange.

import { NextResponse } from "next/server";
import { exchangeCode, SchwabError } from "@/lib/schwab";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    return NextResponse.redirect(
      new URL(`/schwab?error=${encodeURIComponent(err)}`, url.origin),
    );
  }
  if (!code) {
    return NextResponse.redirect(new URL("/schwab?error=sin_code", url.origin));
  }

  try {
    await exchangeCode(code);
    return NextResponse.redirect(new URL("/schwab?connected=1", url.origin));
  } catch (e) {
    const msg = e instanceof SchwabError ? e.message : "Error canjeando el code de Schwab.";
    return NextResponse.redirect(
      new URL(`/schwab?error=${encodeURIComponent(msg)}`, url.origin),
    );
  }
}
