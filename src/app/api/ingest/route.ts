import { db } from "@/lib/db";
import { checkIngestToken, err, json } from "@/lib/api-helpers";
import type { IngestPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/ingest   (called by the Python collector, X-Ingest-Token header)
 *
 * Upserts account state:
 *  - accountInfo  -> new Snapshot (unique per account+ts, 1s resolution)
 *  - positions    -> replace full open-position set
 *  - trades       -> upsert by (accountId, positionId)
 */
export async function POST(req: Request) {
  if (!checkIngestToken(req)) return err("Unauthorized", 401);

  let body: IngestPayload;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON");
  }
  const { accountId, accountInfo, positions = [], trades = [] } = body || {};
  if (!accountId || !accountInfo || typeof accountInfo.balance !== "number") {
    return err("accountId and accountInfo.balance are required");
  }

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
        },
      });
    });
  } catch (e) {
    console.error("[ingest]", e);
    return err("Ingest failed", 500);
  }

  return json({ ok: true, addedTrades: trades.length, positions: positions.length, ts: ts.toISOString() });
}
