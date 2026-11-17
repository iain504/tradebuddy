/**
 * Server-side view of the collector service.
 *
 * The app pings the collector's /health (which itself reports gateway state)
 * and caches the result briefly so the UI can poll /api/health without
 * hammering the collector.
 */

export interface GatewayProbeUrl {
  url: string;
  ok: boolean;
  bridge?: string | null;
  error?: string;
}

export interface GatewayProbe {
  ok: boolean;
  error?: string;
  urls: GatewayProbeUrl[];
}

export interface CollectorHealth {
  ok: boolean;
  accounts: number;
  lastCycle: string | null;
  gateways: {
    mt4: GatewayProbe | null;
    mt5: GatewayProbe | null;
    updatedAt: string | null;
  };
}

const CACHE_TTL_MS = 15_000;
const TIMEOUT_MS = 3_000;

let cache: { at: number; data: CollectorHealth | null } = { at: 0, data: null };

export async function getCollectorHealth(): Promise<CollectorHealth | null> {
  const url = process.env.COLLECTOR_URL;
  if (!url) return null;

  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  let data: CollectorHealth | null = null;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as Partial<CollectorHealth>;
      data = {
        ok: Boolean(body.ok),
        accounts: Number(body.accounts ?? 0),
        lastCycle: body.lastCycle ?? null,
        gateways: {
          mt4: body.gateways?.mt4 ?? null,
          mt5: body.gateways?.mt5 ?? null,
          updatedAt: body.gateways?.updatedAt ?? null,
        },
      };
    }
  } catch {
    data = null; // unreachable -> caller renders "unreachable"
  }

  cache = { at: Date.now(), data };
  return data;
}
