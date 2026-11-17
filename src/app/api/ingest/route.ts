import { db } from "@/lib/db";
import { checkIngestToken, err, json } from "@/lib/api-helpers";
import type { IngestPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/ingest   (X-Ingest-Token header)
 *
 * Called by:
 *  - the Python collector (pull mode), which knows the internal accountId;
 *  - push agents (TradeBuddy EA / MT5 python agent), which address the
 *    account by { login, platform?, server? } instead.
 *
 * Upserts account state:
 *  - accountInfo  -> new Snapshot (unique per account+ts, 1s resolution)
 *  - positions    -> replace full open-position set
 *  - trades       -> upsert by (accountId, positionId)
 */
async function resolveAccountId(body: IngestPayload): Promise<{ id: string } | { error: string; status: number }> {
  if (body.accountId) return { id: body.accountId };
  if (!body.login || String(body.login).trim() === "") {
    return { error: "accountId or login is required", status: 400 };
  }

  const where: { login: string; platform?: string } = { login: String(body.login).trim() };
  if (body.platform === "MT4" || body.platform === "MT5") where.platform = body.platform;
  const matches = await db.account.findMany({ where });

  let narrowed = matches;
  if (matches.length > 1 && body.server) {
    const s = String(body.server).trim().toLowerCase();
    const byServer = matches.filter(
      (a) =>
        (a.serverName ?? "").toLowerCase() === s ||
        (a.serverHost ?? "").toLowerCase() === s
    );
    if (byServer.length > 0) narrowed = byServer;
  }

  if (narrowed.length === 0) {
    return {
      error: `No account matches login ${body.login}${body.platform ? ` (${body.platform})` : ""}. Add the account in the dashboard first (Add account), then retry.`,
      status: 404,
    };
  }
  if (narrowed.length > 1) {
    return {
      error: `Login ${body.login} matches ${narrowed.length} accounts (${narrowed
        .map((a) => `${a.brokerName}/${a.platform}`)
        .join(", ")}). Include a distinct "server" field or use accountId.`,
      status: 409,
    };
  }
  return { id: narrowed[0].id };
}

export async function POST(req: Request) {
  if (!checkIngestToken(req)) return err("Unauthorized", 401);

  let body: IngestPayload;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON");
  }
  const { accountInfo, positions = [], trades = [] } = body || {};
  if (!accountInfo || typeof accountInfo.balance !== "number") {
    return err("accountInfo.balance is required");
  }

  const resolved = await resolveAccountId(body);
  if ("error" in resolved) return err(resolved.error, resolved.status);
  const accountId = resolved.id;

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account) return err("Account not found", 404);

  const ts = body.ts ? new Date(body.ts) : new Date();
  // normalize to second precision for the unique key
  ts.setMilliseconds(0);

  try {
    await db.$transaction(async (tx) => {
      await tx.snapshot.upsert({
        where: { accountId_ts: { accountId, ts } },
        update: {
          balance: accountInfo.balance,
          equity: accountInfo.equity,
          margin: accountInfo.margin ?? 0,
          freeMargin: accountInfo.freeMargin ?? 0,
          marginLevel: accountInfo.marginLevel ?? null,
          floatingPnL: accountInfo.equity - accountInfo.balance,
          openPositions: positions.length,
        },
        create: {
          accountId,
          ts,
          balance: accountInfo.balance,
          equity: accountInfo.equity,
          margin: accountInfo.margin ?? 0,
          freeMargin: accountInfo.freeMargin ?? 0,
          marginLevel: accountInfo.marginLevel ?? null,
          floatingPnL: accountInfo.equity - accountInfo.balance,
          openPositions: positions.length,
        },
      });

      await tx.position.deleteMany({ where: { accountId } });
      if (positions.length > 0) {
        await tx.position.createMany({
          data: positions.slice(0, 500).map((p) => ({
            accountId,
            positionId: String(p.positionId),
            symbol: p.symbol,
            side: p.side === "SELL" ? "SELL" : "BUY",
            volume: p.volume,
            openPrice: p.openPrice,
            currentPrice: p.currentPrice,
            openTime: new Date(p.openTime),
            profit: p.profit,
            swap: p.swap ?? 0,
            comment: p.comment ?? null,
          })),
        });
      }

      for (const t of trades.slice(0, 5000)) {
        await tx.trade.upsert({
          where: { accountId_positionId: { accountId, positionId: String(t.positionId) } },
          update: {
            closePrice: t.closePrice,
            closeTime: new Date(t.closeTime),
            profit: t.profit,
            commission: t.commission ?? 0,
            swap: t.swap ?? 0,
            net: t.profit + (t.commission ?? 0) + (t.swap ?? 0),
          },
          create: {
            accountId,
            positionId: String(t.positionId),
            symbol: t.symbol,
            side: t.side === "SELL" ? "SELL" : "BUY",
            volume: t.volume,
            openPrice: t.openPrice,
            closePrice: t.closePrice,
            openTime: new Date(t.openTime),
            closeTime: new Date(t.closeTime),
            profit: t.profit,
            commission: t.commission ?? 0,
            swap: t.swap ?? 0,
            net: t.profit + (t.commission ?? 0) + (t.swap ?? 0),
            comment: t.comment ?? null,
          },
        });
      }

      await tx.account.update({
        where: { id: accountId },
        data: {
          status: body.status ?? "ACTIVE",
          lastError: body.error ?? null,
          lastSyncAt: ts,
          currency: accountInfo.currency ?? account.currency,
          leverage: accountInfo.leverage ?? account.leverage,
          // Agents teach us the broker server label when it was left blank.
          serverName:
            !account.serverName && body.server ? String(body.server).trim() : undefined,
        },
      });
    });
  } catch (e) {
    console.error("[ingest]", e);
    return err("Ingest failed", 500);
  }

  return json({
    ok: true,
    accountId,
    addedTrades: trades.length,
    positions: positions.length,
    ts: ts.toISOString(),
  });
}
