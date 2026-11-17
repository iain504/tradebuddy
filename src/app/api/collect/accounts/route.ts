import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { checkIngestToken, err, json } from "@/lib/api-helpers";
import type { CollectorAccountConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/collect/accounts   (called by the Python collector, X-Ingest-Token header)
 *
 * Returns ACTIVE/PENDING accounts with DECRYPTED investor passwords so the
 * collector can connect. This endpoint must never be exposed publicly -
 * protect the instance (firewall / VPN / reverse-proxy auth).
 */
export async function GET(req: Request) {
  if (!checkIngestToken(req)) return err("Unauthorized", 401);
  const pollMinutes = Number(process.env.POLL_MINUTES || 5);

  const accounts = await db.account.findMany({
    where: { status: { in: ["PENDING", "ACTIVE", "ERROR"] }, demo: false },
    orderBy: { createdAt: "asc" },
  });

  const payload: CollectorAccountConfig[] = accounts.map((a) => ({
    id: a.id,
    platform: a.platform as "MT4" | "MT5",
    brokerName: a.brokerName,
    serverName: a.serverName,
    serverHost: a.serverHost,
    serverPort: a.serverPort,
    login: a.login,
    password: decrypt(a.passwordEnc),
    backfillFrom: (a.lastSyncAt ?? a.backfillFrom ?? a.createdAt).toISOString(),
    pollMinutes,
  }));

  return json({ accounts: payload, serverTime: new Date().toISOString() });
}
