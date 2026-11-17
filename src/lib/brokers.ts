import type { BrokerSearchItem, Platform, ResolvedEndpoint, ResolutionResult } from "./types";

/**
 * Broker server resolution layer.
 *
 * MT4/MT5 terminals only display a broker LABEL; real endpoints live in
 * `<server>.srv` files (binary, lightly obfuscated, community-documented format)
 * and in MetaQuotes' public broker index that terminals use to download those
 * .srv files by name.
 *
 * This module implements:
 *  1. .srv decoding (MT5 layout and the MT4 variant, auto-detected + validated)
 *  2. MetaQuotes public index lookup (best-effort, cached, fails gracefully
 *     when the host is unreachable - e.g. blocked networks)
 *  3. Manual host:port normalization fallback
 */

const MQ_LIST_URLS: Record<Platform, string[]> = {
  MT5: [
    "https://download.mql5.com/cdn/metaquotes/software/mt5/mt5browserserverslist.txt",
    "https://download.mql5.com/metaquotes/term_servers/mt5serverslist.txt",
  ],
  MT4: [
    "https://download.mql5.com/cdn/metaquotes/software/mt4/mt4browserserverslist.txt",
    "https://download.mql5.com/metaquotes/term_servers/mt4serverslist.txt",
  ],
};

const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  at: number;
  items: BrokerSearchItem[];
}
const listCache = new Map<Platform, CacheEntry>();
const inFlight = new Map<Platform, Promise<BrokerSearchItem[]>>();

// ---------------------------------------------------------------- .srv decode

const XOR_KEYS = [Buffer.from("MT5"), Buffer.from("MT4")];

function xorBuffer(buf: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}

function isPrintableHost(s: string): boolean {
  if (!s || s.length < 3) return false;
  return /^[\x21-\x7e\.\-a-zA-Z0-9_]+$/.test(s);
}

function plausibleEndpoints(entries: ResolvedEndpoint[]): boolean {
  if (entries.length === 0 || entries.length > 512) return false;
  return entries.every(
    (e) =>
      isPrintableHost(e.host) &&
      Number.isInteger(e.port) &&
      e.port > 0 &&
      e.port <= 65535
  );
}

/**
 * Parse an already de-obfuscated .srv payload:
 * [64B name][u32 count]{ [64B host][u32 port] }...
 */
function parseSrvLayout(payload: Buffer): { name: string; endpoints: ResolvedEndpoint[] } | null {
  try {
    if (payload.length < 68) return null;
    const name = payload.subarray(0, 64).toString("ascii").replace(/\0+$/g, "").trim();
    const count = payload.readUInt32LE(64);
    if (!isPrintableHost(name) || count === 0 || count > 512) return null;
    const need = 64 + 4 + count * 68;
    if (payload.length < need) return null;
    const endpoints: ResolvedEndpoint[] = [];
    let off = 68;
    for (let i = 0; i < count; i++) {
      const host = payload.subarray(off, off + 64).toString("ascii").replace(/\0+$/g, "").trim();
      const port = payload.readUInt32LE(off + 64);
      off += 68;
      if (!isPrintableHost(host) || port <= 0 || port > 65535) return null;
      endpoints.push({ host, port });
    }
    return { name, endpoints };
  } catch {
    return null;
  }
}

/** Decode a .srv file buffer. Tries known obfuscation schemes and validates plausibility. */
export function decodeSrv(buf: Buffer): { name: string; endpoints: ResolvedEndpoint[] } | null {
  const candidates: Buffer[] = [];
  // 1) [u32 size][xored payload] variants
  if (buf.length > 4) {
    const declared = buf.readUInt32LE(0);
    const body = buf.subarray(4);
    const sized = declared > 0 && declared <= body.length ? body.subarray(0, declared) : body;
    for (const key of XOR_KEYS) candidates.push(xorBuffer(sized, key));
    for (const key of XOR_KEYS) candidates.push(xorBuffer(body, key));
  }
  // 2) plain payload
  candidates.push(buf);

  for (const c of candidates) {
    const parsed = parseSrvLayout(c);
    if (parsed && plausibleEndpoints(parsed.endpoints)) return parsed;
  }
  return null;
}

// ------------------------------------------------------- MetaQuotes index lookup

interface MqEntry {
  name: string;
  srvUrl?: string;
}

function parseIndexText(text: string): MqEntry[] {
  const out: MqEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[\t;|]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0];
    const srvUrl = parts.find((p) => /^https?:\/\//i.test(p) && /\.srv(\?|$)/i.test(p));
    if (name) out.push({ name, srvUrl });
  }
  return out;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchBrokerIndex(platform: Platform): Promise<BrokerSearchItem[]> {
  const cached = listCache.get(platform);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;
  const existing = inFlight.get(platform);
  if (existing) return existing;

  const job = (async (): Promise<BrokerSearchItem[]> => {
    for (const url of MQ_LIST_URLS[platform]) {
      const text = await fetchText(url);
      if (!text) continue;
      const entries = parseIndexText(text);
      if (entries.length > 0) {
        const items = entries.slice(0, 5000).map((e) => ({
          name: e.name,
          platform,
          detail: e.srvUrl,
        }));
        listCache.set(platform, { at: Date.now(), items });
        return items;
      }
    }
    return [];
  })();

  inFlight.set(platform, job);
  try {
    return await job;
  } finally {
    inFlight.delete(platform);
  }
}

export async function searchBrokers(
  q: string,
  platform: Platform
): Promise<{ items: BrokerSearchItem[]; reachable: boolean }> {
  const items = await fetchBrokerIndex(platform);
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? items.filter((i) => i.name.toLowerCase().includes(needle)).slice(0, 25)
    : items.slice(0, 25);
  return { items: filtered, reachable: items.length > 0 };
}

/** Given an index detail URL, download + decode the .srv to concrete endpoints. */
export async function resolveEndpointsFromIndex(
  name: string,
  platform: Platform
): Promise<ResolvedEndpoint[]> {
  const items = await fetchBrokerIndex(platform);
  const entry = items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  if (!entry?.detail) return [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(entry.detail, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    const decoded = decodeSrv(buf);
    return decoded?.endpoints ?? [];
  } catch {
    return [];
  }
}

/** Normalize manual input: "1.2.3.4:443" or "host" (+optional port). */
export function parseManualEndpoint(input: string, port?: number | null): ResolvedEndpoint | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/^([\w\.\-]+):(\d{1,5})$/);
  if (m) {
    const host = m[1];
    const p = parseInt(m[2], 10);
    if (!isPrintableHost(host) || p <= 0 || p > 65535) return null;
    return { host, port: p };
  }
  if (!isPrintableHost(s)) return null;
  if (port && port > 0 && port <= 65535) return { host: s, port };
  return { host: s, port: 443 };
}

/**
 * Full resolution used when an account is added:
 * 1) explicit host:port (manual)  2) MetaQuotes index by name  3) none (MT5 can
 * still connect by server label alone inside the Wine terminal container).
 */
export async function resolveAccountEndpoints(opts: {
  platform: Platform;
  serverName?: string | null;
  serverHost?: string | null;
  serverPort?: number | null;
}): Promise<ResolutionResult> {
  if (opts.serverHost) {
    const ep = parseManualEndpoint(opts.serverHost, opts.serverPort);
    if (ep) return { source: "manual", endpoints: [ep] };
  }
  if (opts.serverName) {
    const eps = await resolveEndpointsFromIndex(opts.serverName, opts.platform);
    if (eps.length > 0) return { source: "metaquotes", endpoints: eps };
    return {
      source: "none",
      endpoints: [],
      note:
        "Broker not found in the public MetaQuotes index (or index unreachable). " +
        "MT5 accounts connect by server label inside the terminal gateway; " +
        "for MT4, provide host:port manually or upload the broker .srv file.",
    };
  }
  return {
    source: "none",
    endpoints: [],
    note: "No server information provided. MT5 can connect by label; MT4 needs host:port or a .srv file.",
  };
}
