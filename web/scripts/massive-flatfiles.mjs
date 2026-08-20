#!/usr/bin/env node
// ============================================================================
// Descarga de FLAT FILES de Massive (OPRA) para backtesting.
//
// Los flat files NO usan la MASSIVE_API_KEY: van por un endpoint S3-compatible
// (files.massive.com) con un Access Key ID + Secret Access Key propios, que se
// sacan del panel de Massive. Aquí se firma con SigV4 usando SOLO módulos nativos
// de Node — nada de aws-cli ni de meter el SDK de AWS en la app Next.
//
// USO
//   node scripts/massive-flatfiles.mjs survey --dataset day_aggs_v1 --from 2024-08-16 --to 2026-08-15
//   node scripts/massive-flatfiles.mjs download --dataset day_aggs_v1 --from … --to … --out D:/flatfiles
//   node scripts/massive-flatfiles.mjs datasets          (qué hay disponible)
//
// `survey` NO descarga: lista y SUMA tamaños para saber en qué te metes antes de
// bajar nada. Con OPRA la diferencia entre datasets es de tres órdenes de magnitud.
//
// CREDENCIALES (en web/.env.local, nunca en el código):
//   MASSIVE_S3_KEY_ID=...
//   MASSIVE_S3_SECRET=...
// ============================================================================

import { createHash, createHmac } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const ENDPOINT = process.env.MASSIVE_S3_ENDPOINT ?? "https://files.massive.com";
const BUCKET = process.env.MASSIVE_S3_BUCKET ?? "flatfiles";
const REGION = "us-east-1"; // los S3 compatibles piden una región cualquiera para firmar
const SERVICE = "s3";

/** Prefijo raíz de las opciones de EE.UU. (OPRA) en el bucket. */
const OPTIONS_PREFIX = "us_options_opra";

// ---------------------------------------------------------------------------
// Credenciales
// ---------------------------------------------------------------------------

async function loadCreds() {
  let keyId = process.env.MASSIVE_S3_KEY_ID;
  let secret = process.env.MASSIVE_S3_SECRET;
  if (!keyId || !secret) {
    // Respaldo: leer .env.local sin arrastrar dependencias.
    try {
      const envPath = path.join(process.cwd(), ".env.local");
      const raw = await readFile(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const v = m[2].replace(/^["']|["']$/g, "");
        if (m[1] === "MASSIVE_S3_KEY_ID") keyId ??= v;
        if (m[1] === "MASSIVE_S3_SECRET") secret ??= v;
      }
    } catch { /* sin .env.local */ }
  }
  if (!keyId || !secret) {
    console.error(
      "Faltan credenciales de flat files.\n" +
      "Sácalas del panel de Massive (sección Flat Files / S3) y ponlas en web/.env.local:\n" +
      "  MASSIVE_S3_KEY_ID=...\n  MASSIVE_S3_SECRET=...\n" +
      "OJO: NO son la MASSIVE_API_KEY; es un par de claves aparte.",
    );
    process.exit(1);
  }
  return { keyId, secret };
}

// ---------------------------------------------------------------------------
// Firma SigV4 (solo lo necesario para GET y ListObjectsV2)
// ---------------------------------------------------------------------------

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

function signedHeaders({ keyId, secret }, method, urlObj) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(""); // GET sin cuerpo

  // La query canónica va ordenada por clave y con cada valor codificado.
  const params = [...urlObj.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = params
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");

  const canonicalHeaders =
    `host:${urlObj.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaderList = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    urlObj.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  let k = hmac(`AWS4${secret}`, dateStamp);
  k = hmac(k, REGION);
  k = hmac(k, SERVICE);
  k = hmac(k, "aws4_request");
  const signature = hmac(k, stringToSign).toString("hex");

  return {
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}

/** S3 exige RFC3986 estricto: encodeURIComponent deja !'()* sin escapar. */
function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function s3Fetch(creds, urlObj, init = {}) {
  const headers = signedHeaders(creds, init.method ?? "GET", urlObj);
  return fetch(urlObj, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
}

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------

/** Parseo mínimo del XML de ListObjectsV2 (sin dependencias). */
function parseListing(xml) {
  const keys = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1];
    const key = body.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const size = Number(body.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
    if (key) keys.push({ key, size });
  }
  const prefixes = [...xml.matchAll(/<CommonPrefixes><Prefix>([\s\S]*?)<\/Prefix><\/CommonPrefixes>/g)]
    .map((m) => m[1]);
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
  return { keys, prefixes, truncated, nextToken };
}

async function listPrefix(creds, prefix, { delimiter } = {}) {
  const out = { keys: [], prefixes: [] };
  let token = null;
  do {
    const u = new URL(`${ENDPOINT}/${BUCKET}`);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix);
    if (delimiter) u.searchParams.set("delimiter", delimiter);
    if (token) u.searchParams.set("continuation-token", token);

    const res = await s3Fetch(creds, u);
    const xml = await res.text();
    if (!res.ok) {
      throw new Error(`S3 ${res.status} al listar "${prefix}": ${xml.slice(0, 300)}`);
    }
    const p = parseListing(xml);
    out.keys.push(...p.keys);
    out.prefixes.push(...p.prefixes);
    token = p.truncated ? p.nextToken : null;
  } while (token);
  return out;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const GB = 1024 ** 3;
function human(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

/** Claves del dataset cuya fecha (del propio nombre) cae en [from, to]. */
function withinRange(keys, from, to) {
  return keys
    .filter(({ key }) => {
      const m = key.match(/(\d{4}-\d{2}-\d{2})/);
      return m && m[1] >= from && m[1] <= to;
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

async function cmdDatasets(creds) {
  const { prefixes } = await listPrefix(creds, `${OPTIONS_PREFIX}/`, { delimiter: "/" });
  if (prefixes.length === 0) {
    console.log(`Sin datasets bajo ${OPTIONS_PREFIX}/ (¿el plan no incluye flat files de opciones?)`);
    return;
  }
  console.log(`Datasets en ${OPTIONS_PREFIX}/:\n`);
  for (const p of prefixes) console.log("  " + p);
  console.log("\nPara medir uno:  node scripts/massive-flatfiles.mjs survey --dataset <nombre> --from YYYY-MM-DD --to YYYY-MM-DD");
}

async function cmdSurvey(creds, args) {
  const { dataset, from, to } = requireRange(args);
  console.log(`Midiendo ${dataset} de ${from} a ${to}…  (esto NO descarga nada)\n`);

  // Se lista año a año: el bucket entero es demasiado grande para un solo barrido.
  const years = yearsBetween(from, to);
  let all = [];
  for (const y of years) {
    process.stdout.write(`  listando ${y}… `);
    const { keys } = await listPrefix(creds, `${OPTIONS_PREFIX}/${dataset}/${y}/`);
    const inRange = withinRange(keys, from, to);
    all.push(...inRange);
    console.log(`${inRange.length} archivos`);
  }

  if (all.length === 0) {
    console.log("\nNo hay archivos en ese rango. Comprueba el nombre del dataset con el comando `datasets`.");
    return;
  }
  const total = all.reduce((s, k) => s + k.size, 0);
  const avg = total / all.length;
  console.log(`\n  Archivos:      ${all.length}`);
  console.log(`  Tamaño total:  ${human(total)}   (comprimido)`);
  console.log(`  Media diaria:  ${human(avg)}`);
  console.log(`  Primero:       ${all[0].key}`);
  console.log(`  Último:        ${all[all.length - 1].key}`);
  console.log(`\n  Descomprimido puede ser 5-15× eso. Comprueba que te cabe ANTES de bajarlo.`);
}

async function cmdDownload(creds, args) {
  const { dataset, from, to } = requireRange(args);
  const outDir = args.out;
  if (!outDir) {
    console.error("Falta --out <carpeta destino>.");
    process.exit(1);
  }

  const years = yearsBetween(from, to);
  let all = [];
  for (const y of years) {
    const { keys } = await listPrefix(creds, `${OPTIONS_PREFIX}/${dataset}/${y}/`);
    all.push(...withinRange(keys, from, to));
  }
  const total = all.reduce((s, k) => s + k.size, 0);
  console.log(`${all.length} archivos · ${human(total)} comprimidos → ${outDir}\n`);

  let done = 0, bytes = 0, skipped = 0;
  const failed = [];
  for (const { key, size } of all) {
    const dest = path.join(outDir, key);
    mkdirSync(path.dirname(dest), { recursive: true });

    // Reanudable: si ya está y pesa lo mismo, no se vuelve a bajar.
    if (existsSync(dest) && statSync(dest).size === size) {
      skipped++; done++; bytes += size;
      continue;
    }

    const ok = await fetchToFile(creds, key, dest, size);
    if (!ok) { failed.push(key); continue; }
    done++; bytes += size;
    const pct = ((bytes / total) * 100).toFixed(1);
    process.stdout.write(`\r  ${done}/${all.length}  ${pct}%  ${human(bytes)}   `);
  }
  console.log(`\n\nListo. ${done} archivos (${skipped} ya estaban) · ${human(bytes)}`);
  if (failed.length) {
    console.log(`\n⚠ ${failed.length} fallaron tras los reintentos. Vuelve a lanzar el mismo`);
    console.log(`  comando: los ya descargados se saltan y solo se reintentan estos.`);
    for (const k of failed.slice(0, 10)) console.log(`    ${k}`);
  }
}

/**
 * Descarga un objeto a disco con reintentos. Devuelve true si quedó completo.
 *
 * Por qué NO se hace streaming siempre: con 500 peticiones seguidas, undici (el
 * cliente HTTP de Node) revienta de vez en cuando con un `assert(!this.paused)`
 * en su parser — un fallo INTERNO que salta fuera del await y se lleva por delante
 * el proceso entero (pasó en el archivo 496 de 500). Para archivos pequeños se usa
 * `arrayBuffer()`, que no pasa por ese camino de streams. Los grandes (otros
 * datasets) sí se streamean, pero ya con reintentos alrededor.
 */
const STREAM_THRESHOLD = 64 * 1024 * 1024;
const MAX_RETRIES = 4;

async function fetchToFile(creds, key, dest, size) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const u = new URL(`${ENDPOINT}/${BUCKET}/${key}`);
      const res = await s3Fetch(creds, u);
      if (!res.ok) {
        // El cuerpo del error importa: un 403 de S3 distingue "no tienes derecho a
        // este dataset" de "la firma está mal", y sin el texto no se puede saber.
        const body = await res.text().catch(() => "");
        const reason = body.match(/<Message>([\s\S]*?)<\/Message>/)?.[1] ?? body.slice(0, 160);
        throw new Error(`HTTP ${res.status}${reason ? ` — ${reason}` : ""}`);
      }

      if (size > 0 && size <= STREAM_THRESHOLD) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== size) throw new Error(`tamaño ${buf.length} != ${size}`);
        writeFileSync(dest, buf);
      } else {
        if (!res.body) throw new Error("respuesta sin cuerpo");
        await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
        // Se verifica el tamaño: un stream cortado a medias deja el archivo corto.
        const got = statSync(dest).size;
        if (size > 0 && got !== size) throw new Error(`tamaño ${got} != ${size}`);
      }
      return true;
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`\n  ✗ ${key}: ${e.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 400 * attempt)); // espera creciente
    }
  }
  return false;
}

function yearsBetween(from, to) {
  const a = Number(from.slice(0, 4)), b = Number(to.slice(0, 4));
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function requireRange(args) {
  const { dataset, from, to } = args;
  if (!dataset || !from || !to) {
    console.error("Faltan --dataset, --from YYYY-MM-DD y --to YYYY-MM-DD.");
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    console.error("Las fechas van en formato YYYY-MM-DD.");
    process.exit(1);
  }
  return { dataset, from, to };
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const creds = await loadCreds();

try {
  if (cmd === "datasets") await cmdDatasets(creds);
  else if (cmd === "survey") await cmdSurvey(creds, args);
  else if (cmd === "download") await cmdDownload(creds, args);
  else {
    console.log("Comandos: datasets | survey | download");
    console.log("  node scripts/massive-flatfiles.mjs datasets");
    console.log("  node scripts/massive-flatfiles.mjs survey   --dataset day_aggs_v1 --from 2024-08-16 --to 2026-08-15");
    console.log("  node scripts/massive-flatfiles.mjs download --dataset day_aggs_v1 --from 2024-08-16 --to 2026-08-15 --out D:/flatfiles");
  }
} catch (e) {
  console.error("\nError:", e.message);
  process.exit(1);
}
