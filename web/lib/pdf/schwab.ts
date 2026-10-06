// Cliente de Schwab Trader API — producto "Market Data Production". Solo servidor.
// OAuth2: refresh_token dura 7 días, access_token 30 min. El par se persiste en
// data/schwab-token.json (gitignored) y se refresca solo cuando hace falta.
// Autorización inicial (una vez, o cuando el refresh_token de 7 días caduque):
//   cd web && node --env-file=.env.local scripts/schwab-auth.mjs

import { promises as fs } from "fs";
import path from "path";
import { parseSchwabChain, type ParsedSchwabChain } from "./schwabParse";
import { getAccessToken as titoAccessToken } from "@/lib/schwab";

const AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const API_BASE = "https://api.schwabapi.com/marketdata/v1";
const TOKEN_FILE = path.join(process.cwd(), "data", "pdf", "schwab-token.json");

export class SchwabError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SchwabError";
    this.status = status;
  }
}

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

function clientId(): string {
  const v = process.env.SCHWAB_CLIENT_ID;
  if (!v) throw new SchwabError("Falta SCHWAB_CLIENT_ID en .env.local.");
  return v;
}

function clientSecret(): string {
  const v = process.env.SCHWAB_CLIENT_SECRET;
  if (!v) throw new SchwabError("Falta SCHWAB_CLIENT_SECRET en .env.local.");
  return v;
}

function redirectUri(): string {
  return process.env.SCHWAB_REDIRECT_URI ?? "https://127.0.0.1";
}

function basicAuth(): string {
  return Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
}

/** URL de autorización para el flujo manual (ver scripts/schwab-auth.mjs). */
export function getAuthorizeUrl(): string {
  const params = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri() });
  return `${AUTH_URL}?${params.toString()}`;
}

async function loadToken(): Promise<StoredToken | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

async function saveToken(t: StoredToken): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
}

async function refresh(refreshToken: string): Promise<StoredToken> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SchwabError(
      `No se pudo refrescar el token de Schwab (${res.status}). El refresh_token dura 7 días — puede que haga falta re-autorizar con "node --env-file=.env.local scripts/schwab-auth.mjs". ${text.slice(0, 200)}`,
      res.status,
    );
  }
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const t: StoredToken = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? refreshToken, // Schwab no siempre rota el refresh_token
    expires_at: Date.now() + json.expires_in * 1000,
  };
  await saveToken(t);
  return t;
}

/** Access token válido, refrescando si está por vencer (margen de 60s). */
export async function getAccessToken(): Promise<string> {
  // Integrado en Tito: usa el token OAuth que Tito ya mantiene (data/schwab-tokens.json,
  // se autoriza en /schwab) en vez de un token propio de esta sección.
  try {
    return await titoAccessToken();
  } catch (err) {
    throw new SchwabError(err instanceof Error ? err.message : String(err));
  }
}

export interface OptionChainParams {
  contractType?: "CALL" | "PUT" | "ALL";
  strikeCount?: number;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;
}

/**
 * Option chain de Schwab con griegos (delta/gamma/theta/vega) e IV reales por contrato
 * — lo que Massive no expone. GET /chains. Devuelve el JSON crudo de Schwab; el mapeo
 * a los tipos internos del proyecto (RawContract) se hace en el llamador cuando se
 * integre con el resto del scorecard.
 */
export async function fetchOptionChain(
  ticker: string,
  opts: OptionChainParams = {},
): Promise<unknown> {
  const token = await getAccessToken();
  const params = new URLSearchParams({ symbol: ticker.trim().toUpperCase() });
  if (opts.contractType) params.set("contractType", opts.contractType);
  if (opts.strikeCount) params.set("strikeCount", String(opts.strikeCount));
  if (opts.fromDate) params.set("fromDate", opts.fromDate);
  if (opts.toDate) params.set("toDate", opts.toDate);

  const res = await fetch(`${API_BASE}/chains?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SchwabError(`Schwab respondió ${res.status} en /chains. ${text.slice(0, 300)}`, res.status);
  }
  return res.json();
}

/**
 * Igual que `fetchOptionChain` pero ya parseado a un mapa de griegos reales por
 * strike+vencimiento+tipo (ver lib/schwabParse.ts). Es lo que consumen gex.ts y
 * wheel.ts para reemplazar la estimación por Black-Scholes.
 */
export async function fetchGreeksMap(
  ticker: string,
  opts: OptionChainParams = {},
): Promise<ParsedSchwabChain> {
  const raw = await fetchOptionChain(ticker, opts);
  return parseSchwabChain(raw);
}
