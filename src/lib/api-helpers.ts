import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { Account, User } from "@prisma/client";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Shared ingest token (collector -> app). Allow if unset (development). */
export function checkIngestToken(req: Request): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return true;
  const got = req.headers.get("x-ingest-token");
  return got === expected;
}

export function collectorConfigured(): boolean {
  return Boolean(process.env.COLLECTOR_URL);
}

export async function loadAccountWithLatest(id: string) {
  const account = await db.account.findUnique({
    where: { id },
    include: {
      user: true,
      snapshots: { orderBy: { ts: "desc" }, take: 1 },
    },
  });
  return account;
}

export type AccountWithLatest = Account & { user: User; snapshots: { ts: Date; balance: number; equity: number; margin: number; freeMargin: number; marginLevel: number | null; floatingPnL: number; openPositions: number }[] };

export function toAccountSummary(a: AccountWithLatest) {
  const s = a.snapshots[0];
  return {
    id: a.id,
    owner: { id: a.user.id, name: a.user.name },
    platform: a.platform as "MT4" | "MT5",
    brokerName: a.brokerName,
    serverName: a.serverName,
    serverHost: a.serverHost,
    serverPort: a.serverPort,
    login: a.login,
    currency: a.currency,
    leverage: a.leverage,
    status: a.status as "PENDING" | "ACTIVE" | "ERROR" | "PAUSED",
    lastError: a.lastError,
    lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
    demo: a.demo,
    createdAt: a.createdAt.toISOString(),
    latest: s
      ? {
          ts: s.ts.toISOString(),
          balance: s.balance,
          equity: s.equity,
          margin: s.margin,
          freeMargin: s.freeMargin,
          marginLevel: s.marginLevel,
          floatingPnL: s.floatingPnL,
          openPositions: s.openPositions,
        }
      : null,
  };
}
