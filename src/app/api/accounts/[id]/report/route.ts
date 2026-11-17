import { db } from "@/lib/db";
import { err, json, toAccountSummary } from "@/lib/api-helpers";
import { computeStats } from "@/lib/stats";
import type { EquityPointDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

const RANGES: Record<string, number> = {
  "1M": 30,
  "3M": 91,
  "6M": 182,
  "1Y": 365,
  ALL: 100000,
};

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const step = arr.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

// GET /api/accounts/:id/report?range=1M|3M|6M|1Y|ALL
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const range = (url.searchParams.get("range") || "ALL").toUpperCase();
  if (!RANGES[range]) return err("range must be one of 1M,3M,6M,1Y,ALL");
  const sinceDays = RANGES[range];
  const since = new Date(Date.now() - sinceDays * 86400e3);

  const account = await db.account.findUnique({
    where: { id },
    include: { user: true, snapshots: { orderBy: { ts: "desc" }, take: 1 } },
  });
  if (!account) return err("Account not found", 404);

  const [snapshots, trades, positions] = await Promise.all([
    db.snapshot.findMany({
      where: { accountId: id, ts: { gte: since } },
      orderBy: { ts: "asc" },
    }),
    db.trade.findMany({
      where: { accountId: id, closeTime: { gte: since } },
      orderBy: { closeTime: "desc" },
      take: 2000,
    }),
    db.position.findMany({ where: { accountId: id }, orderBy: { openTime: "desc" } }),
  ]);

  const latest = account.snapshots[0];
  const equityCurve: EquityPointDTO[] = downsample(
    snapshots.map((s) => ({
      ts: s.ts.toISOString(),
      balance: s.balance,
      equity: s.equity,
    })),
    400
  );

  const stats = computeStats(
    trades.map((t) => ({
      positionId: t.positionId,
      symbol: t.symbol,
      side: t.side as "BUY" | "SELL",
      volume: t.volume,
      openPrice: t.openPrice,
      closePrice: t.closePrice,
      openTime: t.openTime.toISOString(),
      closeTime: t.closeTime.toISOString(),
      profit: t.profit,
      commission: t.commission,
      swap: t.swap,
      net: t.net,
      comment: t.comment,
    })),
    equityCurve,
    {
      balance: latest?.balance ?? 0,
      equity: latest?.equity ?? 0,
      floatingPnL: latest?.floatingPnL ?? 0,
    }
  );

  return json({
    account: toAccountSummary(account),
    equityCurve,
    stats,
    positions: positions.map((p) => ({
      positionId: p.positionId,
      symbol: p.symbol,
      side: p.side as "BUY" | "SELL",
      volume: p.volume,
      openPrice: p.openPrice,
      currentPrice: p.currentPrice,
      openTime: p.openTime.toISOString(),
      profit: p.profit,
      swap: p.swap,
      comment: p.comment,
    })),
    trades: trades.slice(0, 200).map((t) => ({
      positionId: t.positionId,
      symbol: t.symbol,
      side: t.side as "BUY" | "SELL",
      volume: t.volume,
      openPrice: t.openPrice,
      closePrice: t.closePrice,
      openTime: t.openTime.toISOString(),
      closeTime: t.closeTime.toISOString(),
      profit: t.profit,
      commission: t.commission,
      swap: t.swap,
      net: t.net,
      comment: t.comment,
    })),
  });
}
