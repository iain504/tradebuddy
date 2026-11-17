import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { err, json, toAccountSummary } from "@/lib/api-helpers";
import { resolveAccountEndpoints } from "@/lib/brokers";
import type { Platform } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/accounts - list all accounts with latest snapshot
export async function GET() {
  const accounts = await db.account.findMany({
    include: { user: true, snapshots: { orderBy: { ts: "desc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  return json({ accounts: accounts.map(toAccountSummary) });
}

// POST /api/accounts - add a new trade account
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      ownerName,
      ownerId,
      platform,
      brokerName,
      serverName,
      serverHost,
      serverPort,
      login,
      password,
      testConnection,
    } = body || {};

    if (platform !== "MT4" && platform !== "MT5") return err("platform must be MT4 or MT5");
    if (!brokerName || typeof brokerName !== "string") return err("brokerName is required");
    if (!login || String(login).trim() === "") return err("login is required");
    if (!password || String(password).length < 4) return err("password is required");

    // owner: existing id, or create/find by name, or default single-owner
    let userId = ownerId as string | undefined;
    if (userId) {
      const u = await db.user.findUnique({ where: { id: userId } });
      if (!u) return err("owner not found", 404);
    } else {
      const name = (ownerName && String(ownerName).trim()) || "Main";
      const u = await db.user.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      userId = u.id;
    }

    // duplicate guard: same user + platform + login
    const dup = await db.account.findFirst({
      where: { userId: userId!, platform, login: String(login).trim() },
    });
    if (dup) return err("This login already exists for the owner", 409);

    // server resolution (best-effort, never blocks creation)
    const resolution = await resolveAccountEndpoints({
      platform: platform as Platform,
      serverName: serverName || null,
      serverHost: serverHost || null,
      serverPort: serverPort ? Number(serverPort) : null,
    });

    const account = await db.account.create({
      data: {
        userId: userId!,
        platform,
        brokerName: String(brokerName).trim(),
        serverName: serverName ? String(serverName).trim() : null,
        serverHost: resolution.endpoints[0]?.host ?? (serverHost ? String(serverHost).trim() : null),
        serverPort: resolution.endpoints[0]?.port ?? (serverPort ? Number(serverPort) : null),
        login: String(login).trim(),
        passwordEnc: encrypt(String(password)),
        status: "PENDING",
        backfillFrom: new Date(),
      },
      include: { user: true, snapshots: { orderBy: { ts: "desc" }, take: 1 } },
    });

    // optionally trigger an immediate first sync (collector or demo)
    let syncNote: string | null = null;
    if (testConnection !== false) {
      try {
        const base = process.env.APP_URL || "http://localhost:3000";
        await fetch(`${base}/api/accounts/${account.id}/sync`, { method: "POST" });
        syncNote = "First sync triggered";
      } catch {
        syncNote = "Account saved. First sync will run on the next collector cycle.";
      }
    }

    return json(
      {
        account: toAccountSummary(account),
        resolution: {
          ...resolution,
          note: resolution.note ?? syncNote,
        },
      },
      201
    );
  } catch (e) {
    console.error("[accounts.POST]", e);
    return err("Failed to create account", 500);
  }
}
