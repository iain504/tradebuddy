import { db } from "@/lib/db";
import { collectorConfigured, err, json } from "@/lib/api-helpers";
import { advanceDemo } from "@/lib/simulator";

export const dynamic = "force-dynamic";

/**
 * POST /api/accounts/:id/sync
 * - demo accounts: advance the local simulator
 * - live accounts: ask the Python collector to poll this account now
 *   (no-op success if collector isn't configured yet - PENDING until next cycle)
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const account = await db.account.findUnique({ where: { id } });
  if (!account) return err("Account not found", 404);
  if (account.status === "PAUSED") return err("Account is paused", 409);

  if (account.demo) {
    await advanceDemo(id);
    const fresh = await db.account.findUnique({ where: { id } });
    return json({ ok: true, mode: "demo", lastSyncAt: fresh?.lastSyncAt });
  }

  if (!collectorConfigured()) {
    return json({
      ok: true,
      mode: "queued",
      message:
        "Collector is not configured on this instance. The account is stored and will be polled as soon as the collector service runs (see DEPLOY.md).",
    });
  }

  try {
    const collectorUrl = process.env.COLLECTOR_URL!;
    const token = process.env.INGEST_TOKEN || "";
    const res = await fetch(`${collectorUrl.replace(/\/$/, "")}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": token },
      body: JSON.stringify({ accountId: id }),
      // The collector may wait for a restarting terminal bridge before
      // answering - allow more than the gateway's own bridge timeout.
      signal: AbortSignal.timeout(35000),
    });
    const data = await res.json().catch(() => ({}));
    return json({ ok: res.ok, mode: "collector", collector: data }, res.ok ? 200 : 502);
  } catch (e) {
    console.error("[sync] collector error", e);
    return json({ ok: false, mode: "collector", error: "Collector unreachable" }, 502);
  }
}
