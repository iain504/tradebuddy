/**
 * mt4-gateway
 * -----------
 * Express service (default :8001) that talks to a MetaTrader 4 TERMINAL
 * running inside this same container (under Wine) via the ZeroMQ bridge EA
 * from the `metatrader4` npm package.
 *
 * IMPORTANT ARCHITECTURE FACTS (verified against metatrader4@1.0.5 source and
 * the MetaTrader4Bridge.mq4 EA source):
 *
 *  1. The bridge EA binds ZMQ REP on REQ_PORT (5555) and ZMQ PUSH on
 *     PULL_PORT (5556) INSIDE the MT4 terminal process. The Node client
 *     connects to both. If the terminal/EA is down, requests fail - we then
 *     answer HTTP 503 { ok:false } and never crash.
 *
 *  2. The EA implements exactly these commands (command ids):
 *       1 PING | 31 RATES | 41 ACCOUNT | 51 ORDERS | 11..23 trading |
 *       61..66 subscriptions | 71 CHART
 *     THERE IS NO HISTORY COMMAND. `ORDERS` (51) iterates OrdersTotal(),
 *     i.e. OPEN market + pending orders only. Closed-order history lives in
 *     the separate history pool (OrdersHistoryTotal()) which the stock EA
 *     never reads.
 *     => Closed-trade backfill for MT4 is NOT possible with the stock bridge.
 *        This gateway therefore returns trades: [] unless you patch the EA
 *        and enable MT4_HISTORY_CMD (see CONFIG below and README.md).
 *
 *  3. The terminal logs into ONE account (configured in the terminal itself,
 *     not via this API). One gateway instance serves one MT4 account.
 *     Set GATEWAY_LOGIN so /whoami can advertise it and /snapshot,/test can
 *     reject mismatches. For several MT4 accounts run several gateway
 *     containers (see DEPLOY.md - the collector supports comma-separated
 *     MT4_GATEWAY_URL lists and matches logins via /whoami).
 *
 *  4. Order timestamps come from the EA as "yyyy.mm.dd hh:mi" in BROKER
 *     SERVER time. We treat them as UTC (documented approximation; MT4
 *     timestamps may be off by the broker's GMT offset, usually 0..+3h).
 *
 *  5. Open orders carry no current price -> the gateway fetches RATES (31)
 *     per symbol and uses bid (BUY) / ask (SELL) as currentPrice, falling
 *     back to the open price if a quote is unavailable.
 */

"use strict";

const express = require("express");
const MetaTrader4 = require("metatrader4").default;

// --------------------------------------------------------------------------- //
// CONFIG - all terminal-bridge specifics in one place
// --------------------------------------------------------------------------- //

const CONFIG = {
  apiKey: process.env.BRIDGE_API_KEY || "change-me",
  reqUrl: `tcp://127.0.0.1:${process.env.REQ_PORT || 5555}`,
  pullUrl: `tcp://127.0.0.1:${process.env.PULL_PORT || 5556}`,
  port: Number(process.env.PORT || 8001),
  // Declared login of the account the terminal is logged into (optional but
  // strongly recommended - enables /whoami and mismatch rejection).
  gatewayLogin: process.env.GATEWAY_LOGIN || null,
  // Max time to wait for the ZMQ sockets to (re)connect before giving up.
  bridgeConnectTimeoutMs: Number(process.env.BRIDGE_CONNECT_TIMEOUT_MS || 10000),
  // Price cache TTL for RATES lookups (ms).
  ratesCacheTtlMs: Number(process.env.RATES_CACHE_TTL_MS || 5000),
  // COMMAND IDS as implemented by MetaTrader4Bridge.mq4 (keep in sync with the
  // EA source if you modify it).
  commands: {
    PING: 1,
    RATES: 31,
    ACCOUNT: 41,
    ORDERS: 51,
    // NOT part of the stock EA. If you patch MetaTrader4Bridge.mq4 to expose
    // closed orders, set MT4_HISTORY_CMD to your command id (e.g. 81) and make
    // the EA accept one ISO date argument, replying with a JSON array:
    //   [{ "order":123, "symbol":"EURUSD", "type":0, "volume":0.10,
    //      "open_time":"2024.05.01 10:00", "open_price":1.07123,
    //      "close_time":"2024.05.02 15:30", "close_price":1.07890,
    //      "profit":76.70, "commission":-0.70, "swap":0.00,
    //      "comment":"..." }, ...]
    HISTORY: Number(process.env.MT4_HISTORY_CMD || 0) || null,
  },
  // MT4 order type mapping.
  orderType: { 0: "BUY", 1: "SELL" },
};

const app = express();
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------------------------------- //
// Bridge client (single terminal connection, "pool" keyed by login)
// --------------------------------------------------------------------------- //

/**
 * The container runs exactly ONE MT4 terminal, so the pool always resolves to
 * one shared bridge client. The Map is kept because the natural extension is
 * one terminal per login (multi-container), and callers below are written
 * against the pool shape already.
 */
const pool = new Map(); // login -> { client, ready, connectedAt }
let ready = false;
let connectedSince = null;
// Whether the ZeroMQ bridge has EVER connected in this process lifetime.
// Used to fail fast when the terminal was clearly never set up (full wait
// only makes sense while a known-good terminal restarts).
let everConnected = false;

function bridgeClient() {
  const key = CONFIG.gatewayLogin || "__terminal__";
  let entry = pool.get(key);
  if (!entry) {
    const client = new MetaTrader4({
      apiKey: CONFIG.apiKey,
      reqUrl: CONFIG.reqUrl,
      pullUrl: CONFIG.pullUrl,
    });
    client.onConnect(() => {
      ready = true;
      everConnected = true;
      connectedSince = new Date().toISOString();
      console.log(`[bridge] connected ${CONFIG.reqUrl} / ${CONFIG.pullUrl}`);
    });
    client.onDisconnect(() => {
      ready = false;
      console.warn("[bridge] disconnected (terminal down or restarting); " +
                   "ZeroMQ will keep retrying in the background");
    });
    client.connect(); // sockets auto-(re)connect; requests fail until ready
    entry = { client, key };
    pool.set(key, entry);
  }
  return entry.client;
}

function bridgeReady() {
  try {
    const client = bridgeClient();
    // MetaTrader4Connection exposes these flags publicly at runtime.
    return Boolean(client.reqConnected && client.pullConnected);
  } catch {
    return false;
  }
}

async function waitForBridge(timeoutMs = CONFIG.bridgeConnectTimeoutMs) {
  // Terminal never attached in this process lifetime -> short fail-fast so
  // callers get the setup hint quickly instead of a long hang.
  const effective = everConnected ? timeoutMs : Math.min(timeoutMs, 2500);
  const deadline = Date.now() + effective;
  while (Date.now() < deadline) {
    if (bridgeReady()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return bridgeReady();
}

/**
 * Raw request through the bridge: sends `apiKey|reqId|cmdId|args...`.
 * Returns the parsed JSON payload.
 *
 * QUIRK (verified in metatrader4@1.0.5 + EA source): when the EA answers
 * FAILED (e.g. API key mismatch, unknown command), the client library RESOLVES
 * with null instead of rejecting - so null here means the terminal refused
 * the command and we convert it to a proper error.
 */
async function rawRequest(cmdId, ...args) {
  const client = bridgeClient();
  if (!bridgeReady()) {
    const ok = await waitForBridge();
    if (!ok) throw new Error("MT4 terminal bridge not reachable (is the terminal running with the bridge EA attached and AutoTrading enabled?)");
  }
  // `request()` is a public method of MetaTrader4Connection (not in the .d.ts).
  const result = await client.request(cmdId, ...args);
  if (result === null || result === undefined) {
    throw new Error("MT4 bridge request failed: the terminal rejected the command " +
                    "(check that BRIDGE_API_KEY matches the APIKEY compiled into the EA, " +
                    "and that the terminal is connected to the broker)");
  }
  return result;
}

/** True when an error looks like bridge/terminal unavailability -> HTTP 503. */
function isBridgeError(err) {
  const msg = String((err && err.message) || err || "");
  return /ZMQ|bridge|terminal/i.test(msg);
}

// --------------------------------------------------------------------------- //
// Normalization helpers
// --------------------------------------------------------------------------- //

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse MT4 EA time strings ("yyyy.mm.dd hh:mi" or with ":ss") into ISO.
 * Broker-server time is treated as UTC - see header note 4.
 */
function mt4TimeToIso(value) {
  if (!value) return null;
  const m = /^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(value).trim()
  );
  if (!m) {
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))).toISOString();
}

// --------------------------------------------------------------------------- //
// Data fetching
// --------------------------------------------------------------------------- //

const ratesCache = new Map(); // symbol -> { expires, bid, ask }

async function fetchRate(symbol) {
  const now = Date.now();
  const cached = ratesCache.get(symbol);
  if (cached && cached.expires > now) return cached;
  try {
    const rate = await rawRequest(CONFIG.commands.RATES, symbol);
    const entry = {
      expires: now + CONFIG.ratesCacheTtlMs,
      bid: num(rate && rate.bid),
      ask: num(rate && rate.ask),
    };
    ratesCache.set(symbol, entry);
    return entry;
  } catch (err) {
    console.warn(`[bridge] rates lookup failed for ${symbol}: ${err}`);
    return null;
  }
}

async function getAccountInfo() {
  const info = await rawRequest(CONFIG.commands.ACCOUNT);
  const marginLevel = num(info.margin_level);
  return {
    balance: num(info.balance),
    equity: num(info.equity),
    margin: num(info.margin),
    freeMargin: num(info.margin_free),
    marginLevel: marginLevel > 0 ? marginLevel : null,
    leverage: Math.trunc(num(info.leverage)),
    currency: String(info.currency || ""),
  };
}

/**
 * ORDERS (51) -> open positions. Returns an ARRAY (the EA serializes an
 * array; the npm Order interface claiming a single object is inaccurate).
 * Only market orders (type 0/1) map to positions; pending orders (2..5)
 * are skipped.
 */
async function getPositions() {
  const orders = await rawRequest(CONFIG.commands.ORDERS);
  const list = Array.isArray(orders) ? orders : orders ? [orders] : [];

  const market = list.filter(
    (o) => o && Number(o.type) in CONFIG.orderType
  );

  // currentPrice needs quotes; fetch unique symbols (sequential, small N).
  const symbols = [...new Set(market.map((o) => String(o.symbol)))];
  const rates = {};
  for (const sym of symbols) rates[sym] = await fetchRate(sym);

  return market.map((o) => {
    const side = CONFIG.orderType[Number(o.type)];
    const rate = rates[String(o.symbol)];
    const currentPrice = rate
      ? side === "BUY" ? rate.bid : rate.ask
      : num(o.price); // fallback: open price when no quote is available
    return {
      positionId: String(o.order),
      symbol: String(o.symbol || ""),
      side,
      volume: num(o.volume),
      openPrice: num(o.price),
      currentPrice,
      openTime: mt4TimeToIso(o.open_time) || new Date(0).toISOString(),
      profit: num(o.profit),
      swap: num(o.swap),
      comment: o.comment ? String(o.comment) : null,
    };
  });
}

/**
 * History: NOT supported by the stock bridge EA (see header note 2).
 * If MT4_HISTORY_CMD is configured we issue the raw command and map the
 * result defensively (field-name variants accepted). Failure of this optional
 * command degrades to trades: [] + a note - it must never break the snapshot.
 */
async function getClosedTrades(historyFromIso) {
  if (!CONFIG.commands.HISTORY) {
    return { trades: [], note: "MT4 closed-trade history requires a patched bridge EA (set MT4_HISTORY_CMD); returning no trades." };
  }
  let raw;
  try {
    raw = await rawRequest(CONFIG.commands.HISTORY,
      historyFromIso || "1970-01-01T00:00:00Z");
  } catch (err) {
    console.warn(`[bridge] history command ${CONFIG.commands.HISTORY} failed:`, err);
    return { trades: [], note: `history command failed: ${String((err && err.message) || err)}` };
  }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.trades) ? raw.trades : [];
  const sinceMs = Date.parse(historyFromIso || "");

  const trades = list
    .map((t) => {
      const ticket = t.order ?? t.ticket ?? t.order_ticket;
      const type = Number(t.type ?? t.order_type);
      const openTime = mt4TimeToIso(t.open_time ?? t.openTime ?? t.open);
      const closeTime = mt4TimeToIso(t.close_time ?? t.closeTime ?? t.close);
      return {
        positionId: String(ticket ?? ""),
        symbol: String(t.symbol || ""),
        side: CONFIG.orderType[type] || (type === 1 ? "SELL" : "BUY"),
        volume: num(t.volume),
        openPrice: num(t.open_price ?? t.price_open ?? t.openPrice ?? t.price),
        closePrice: num(t.close_price ?? t.price_close ?? t.closePrice),
        openTime: openTime || new Date(0).toISOString(),
        closeTime: closeTime || new Date(0).toISOString(),
        profit: num(t.profit),
        commission: num(t.commission),
        swap: num(t.swap),
        comment: t.comment ? String(t.comment) : null,
        _closeMs: closeTime ? Date.parse(closeTime) : 0,
      };
    })
    .filter((t) => t.positionId)
    .filter((t) => !Number.isFinite(sinceMs) || !t._closeMs || t._closeMs >= sinceMs)
    .map(({ _closeMs, ...t }) => t);

  return { trades, note: null };
}

// --------------------------------------------------------------------------- //
// HTTP API
// --------------------------------------------------------------------------- //

/** Wrap handlers; bridge problems -> 503, everything else -> 500. Never crash. */
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[http] ${req.method} ${req.path} failed:`, err);
      const status = isBridgeError(err) ? 503 : 500;
      res.status(status).json({ ok: false, error: String((err && err.message) || err) });
    }
  };
}

function loginMatches(login) {
  return !CONFIG.gatewayLogin || String(login) === String(CONFIG.gatewayLogin);
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    bridge: ready ? "connected" : "disconnected",
    historyCmd: CONFIG.commands.HISTORY ? CONFIG.commands.HISTORY : null,
    uptimeS: Math.round(process.uptime()),
  });
});

/** Advertises the configured terminal login for the collector's routing. */
app.get("/whoami", (req, res) => {
  res.json({ ok: true, login: CONFIG.gatewayLogin });
});

/**
 * POST /test { serverHost, serverPort, login, password }
 *
 * Honest contract: MT4 credentials CANNOT be applied through the bridge - the
 * terminal logs in itself (start flags / manual login, see README). This
 * endpoint therefore verifies BRIDGE + TERMINAL health (PING command 1), and
 * rejects an obvious login mismatch when GATEWAY_LOGIN is set.
 */
app.post("/test", wrap(async (req, res) => {
  const { login } = req.body || {};
  if (login && !loginMatches(login)) {
    return res.json({
      ok: false,
      message: `This gateway's MT4 terminal is designated for login ${CONFIG.gatewayLogin}; ` +
               `the requested login is ${login}. Run a separate mt4-gateway container for each MT4 account.`,
    });
  }
  const up = await waitForBridge();
  if (!up) {
    return res.json({
      ok: false,
      message: "MT4 terminal bridge not reachable. Check: terminal running, " +
               "bridge EA attached to a chart, AutoTrading ON, DLL imports allowed, " +
               `ports ${CONFIG.reqUrl}/${CONFIG.pullUrl}, BRIDGE_API_KEY matches the EA.`,
    });
  }
  await rawRequest(CONFIG.commands.PING); // terminal-level round trip
  res.json({
    ok: true,
    message: "Bridge OK: MT4 terminal is up and responding. Note: login/password are " +
             "managed in the terminal itself, this check does not validate broker credentials.",
  });
}));

/**
 * POST /snapshot { serverHost, serverPort, login, password, historyFrom }
 * -> { ok, accountInfo, positions, trades, meta? }
 */
app.post("/snapshot", wrap(async (req, res) => {
  const { login, historyFrom } = req.body || {};
  if (login && !loginMatches(login)) {
    return res.status(409).json({
      ok: false,
      error: `This gateway's MT4 terminal is designated for login ${CONFIG.gatewayLogin}, not ${login}.`,
    });
  }

  const accountInfo = await getAccountInfo();
  const positions = await getPositions();
  const history = await getClosedTrades(historyFrom);

  const payload = {
    ok: true,
    accountInfo,
    positions,
    trades: history.trades,
  };
  if (history.note) payload.meta = { note: history.note };
  res.json(payload);
}));

// Process-level safety nets: a gateway must degrade, not die.
process.on("uncaughtException", (err) => console.error("[fatal] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[fatal] unhandledRejection:", err));

const server = app.listen(CONFIG.port, () => {
  console.log(`[mt4-gateway] listening on :${CONFIG.port}`);
  console.log(`[mt4-gateway] bridge: req=${CONFIG.reqUrl} pull=${CONFIG.pullUrl} ` +
              `apiKey=${CONFIG.apiKey ? "***set***" : "(empty)"} gatewayLogin=${CONFIG.gatewayLogin || "(unset)"}`);
  console.log(`[mt4-gateway] history command: ${CONFIG.commands.HISTORY ? CONFIG.commands.HISTORY : "disabled (stock EA has no history support)"}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[mt4-gateway] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
