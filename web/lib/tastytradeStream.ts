// Cliente DXLink (dxFeed) de Tastytrade — SOLO servidor. Node 24 trae `WebSocket`
// global, así que no hace falta dependencia.
//
// Tastytrade NO entrega greeks/quotes por REST: van por su streamer WebSocket
// (DXLink). Este módulo hace un "snapshot": abre el WS, autentica con el
// api-quote-token, suscribe Greeks+Quote+Summary de una lista de símbolos, recoge
// el primer valor de cada uno y cierra. No mantiene conexión viva.
//
// Protocolo (verificado contra producción):
//   SETUP → AUTH_STATE(UNAUTHORIZED) → AUTH → AUTH_STATE(AUTHORIZED)
//   → CHANNEL_REQUEST(FEED) → CHANNEL_OPENED → FEED_SETUP → FEED_CONFIG
//   → FEED_SUBSCRIPTION → FEED_DATA (formato COMPACT).

export interface DxFields {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  iv?: number; // volatility (decimal)
  bid?: number;
  ask?: number;
  oi?: number; // open interest
  last?: number; // último precio (Trade.price)
  volume?: number; // volumen del día (Trade.dayVolume)
}

// Campos que pedimos por tipo de evento. El ORDEN define cómo se parsea COMPACT.
const GREEKS_FIELDS = ["eventType", "eventSymbol", "delta", "gamma", "theta", "vega", "volatility", "price"];
const QUOTE_FIELDS = ["eventType", "eventSymbol", "bidPrice", "askPrice"];
const SUMMARY_FIELDS = ["eventType", "eventSymbol", "openInterest"];
const TRADE_FIELDS = ["eventType", "eventSymbol", "price", "dayVolume"];

interface SnapshotOpts {
  url: string;
  token: string;
  symbols: string[];
  /** Tope duro de espera (ms). Por defecto 9s. */
  timeoutMs?: number;
  /** Ms sin nuevos greeks tras los cuales se considera "asentado" y se cierra. */
  quietMs?: number;
}

/**
 * Devuelve un Map { streamerSymbol -> DxFields } con lo que llegó dentro del
 * presupuesto de tiempo. Resuelve antes si TODOS los símbolos ya trajeron greeks,
 * o si pasa `quietMs` sin novedades (útil cuando algunos contratos no tickean).
 */
export function dxlinkSnapshot(opts: SnapshotOpts): Promise<Map<string, DxFields>> {
  const { url, token, symbols } = opts;
  const timeoutMs = opts.timeoutMs ?? 9000;
  const quietMs = opts.quietMs ?? 1200;
  const want = new Set(symbols);

  return new Promise((resolve) => {
    const collected = new Map<string, DxFields>();
    if (symbols.length === 0) return resolve(collected);

    const ws = new WebSocket(url);
    let ka: ReturnType<typeof setInterval> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    let subscribed = false; // suscribir UNA sola vez (llegan varios FEED_CONFIG)

    const finish = () => {
      if (done) return;
      done = true;
      if (ka) clearInterval(ka);
      if (hardTimer) clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      try { ws.close(); } catch { /* noop */ }
      resolve(collected);
    };

    const withGreeks = () => [...collected.values()].filter((v) => v.iv != null).length;
    const bumpQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      // Solo cerramos por silencio si ya tenemos algo; si no, esperamos al tope duro.
      quietTimer = setTimeout(() => { if (withGreeks() > 0) finish(); }, quietMs);
    };

    const send = (o: unknown) => { try { ws.send(JSON.stringify(o)); } catch { /* noop */ } };

    ws.addEventListener("open", () => {
      send({ type: "SETUP", channel: 0, version: "0.1-tito", keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 });
    });

    ws.addEventListener("error", () => finish());
    ws.addEventListener("close", () => finish());

    ws.addEventListener("message", (ev: MessageEvent) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(ev.data as string); } catch { return; }
      switch (m.type) {
        case "AUTH_STATE":
          if (m.state === "UNAUTHORIZED") {
            send({ type: "AUTH", channel: 0, token });
          } else if (m.state === "AUTHORIZED") {
            send({ type: "CHANNEL_REQUEST", channel: 1, service: "FEED", parameters: { contract: "AUTO" } });
            ka = setInterval(() => send({ type: "KEEPALIVE", channel: 0 }), 20000);
          }
          break;
        case "CHANNEL_OPENED":
          send({
            type: "FEED_SETUP", channel: 1, acceptAggregationPeriod: 0.1, acceptDataFormat: "COMPACT",
            acceptEventFields: { Greeks: GREEKS_FIELDS, Quote: QUOTE_FIELDS, Summary: SUMMARY_FIELDS, Trade: TRADE_FIELDS },
          });
          break;
        case "FEED_CONFIG": {
          // Llegan varios FEED_CONFIG (uno por tipo de evento). Suscribir UNA sola
          // vez, y en TANDAS: un `add` de miles de entradas satura el feed y no
          // vuelve nada. 250 símbolos × 3 eventos = 750 entradas por mensaje.
          if (subscribed) break;
          subscribed = true;
          const CHUNK = 250;
          for (let i = 0; i < symbols.length; i += CHUNK) {
            const batch = symbols.slice(i, i + CHUNK);
            send({
              type: "FEED_SUBSCRIPTION", channel: 1,
              add: batch.flatMap((s) => [
                { type: "Greeks", symbol: s },
                { type: "Quote", symbol: s },
                { type: "Summary", symbol: s },
                { type: "Trade", symbol: s },
              ]),
            });
          }
          break;
        }
        case "FEED_DATA": {
          const data = m.data as unknown[];
          if (!Array.isArray(data)) break;
          for (let i = 0; i + 1 < data.length; i += 2) {
            const type = data[i] as string;
            const vals = data[i + 1] as unknown[];
            const n = type === "Greeks" ? GREEKS_FIELDS.length : type === "Quote" ? QUOTE_FIELDS.length : type === "Summary" ? SUMMARY_FIELDS.length : type === "Trade" ? TRADE_FIELDS.length : 0;
            if (n === 0 || !Array.isArray(vals)) continue;
            for (let k = 0; k + n <= vals.length; k += n) {
              const sym = vals[k + 1] as string;
              if (!want.has(sym)) continue;
              const cur = collected.get(sym) ?? {};
              const num = (x: unknown): number | undefined => {
                const v = typeof x === "number" ? x : Number(x);
                return Number.isFinite(v) ? v : undefined;
              };
              if (type === "Greeks") {
                cur.delta = num(vals[k + 2]); cur.gamma = num(vals[k + 3]);
                cur.theta = num(vals[k + 4]); cur.vega = num(vals[k + 5]);
                cur.iv = num(vals[k + 6]);
              } else if (type === "Quote") {
                cur.bid = num(vals[k + 2]); cur.ask = num(vals[k + 3]);
              } else if (type === "Summary") {
                cur.oi = num(vals[k + 2]);
              } else if (type === "Trade") {
                cur.last = num(vals[k + 2]); cur.volume = num(vals[k + 3]);
              }
              collected.set(sym, cur);
            }
          }
          if (withGreeks() >= want.size) return finish(); // todos con greeks → listo
          bumpQuiet();
          break;
        }
      }
    });

    hardTimer = setTimeout(finish, timeoutMs);
  });
}
