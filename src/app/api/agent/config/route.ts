import { db } from "@/lib/db";
import { json } from "@/lib/api-helpers";
import type { AgentAccountDTO, AgentConfigDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/config
 *
 * Setup helper for push agents (TradeBuddy EA / MT5 python agent):
 *  - ingestUrl: absolute URL agents should POST snapshots to (respects
 *    PUBLIC_APP_URL, then proxy headers, then the request origin);
 *  - token: only included when EXPOSE_INGEST_TOKEN=1 - enable it on private
 *    instances so the dashboard can show copy-paste ready agent inputs;
 *  - accounts: non-demo accounts agents can push to.
 *
 * Read-only, no credentials are returned (investor passwords never leave the
 * server); the ingest token is a shared push secret, not an account credential.
 */
export async function GET(req: Request) {
  const token = process.env.INGEST_TOKEN || "";
  const expose = process.env.EXPOSE_INGEST_TOKEN === "1";

  const accounts = await db.account.findMany({
    where: { demo: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      login: true,
      platform: true,
      brokerName: true,
      serverName: true,
      status: true,
      lastSyncAt: true,
    },
  });

  const payload: AgentConfigDTO = {
    ok: true,
    ingestUrl: `${deriveOrigin(req)}/api/ingest`,
    tokenRequired: Boolean(token),
    ...(expose && token ? { token } : {}),
    accounts: accounts.map<AgentAccountDTO>((a) => ({
      id: a.id,
      login: a.login,
      platform: a.platform === "MT4" ? "MT4" : "MT5",
      brokerName: a.brokerName,
      serverName: a.serverName,
      status: a.status as AgentAccountDTO["status"],
      lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
    })),
  };

  return json(payload);
}

function deriveOrigin(req: Request): string {
  const override = process.env.PUBLIC_APP_URL?.trim();
  if (override) return override.replace(/\/+$/, "");

  // Behind a reverse proxy, trust the forwarded host/proto headers first so
  // the URL the agent copies matches what the browser actually uses.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}
