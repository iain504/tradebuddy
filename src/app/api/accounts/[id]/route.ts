import { db } from "@/lib/db";
import { json } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// DELETE /api/accounts/:id
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const account = await db.account.findUnique({ where: { id } });
  if (!account) return json({ error: "Account not found" }, 404);
  await db.account.delete({ where: { id } });
  return json({ ok: true });
}

// PATCH /api/accounts/:id - pause/resume + collector error reporting
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const status = body?.status;
  if (status && !["PENDING", "ACTIVE", "ERROR", "PAUSED"].includes(status)) {
    return json({ error: "invalid status" }, 400);
  }
  const account = await db.account.update({
    where: { id },
    data: {
      status: status ?? undefined,
      lastError: typeof body?.lastError === "string" ? body.lastError.slice(0, 500) : undefined,
      lastSyncAt: body?.markSynced ? new Date() : undefined,
    },
  });
  return json({ account: { id: account.id, status: account.status } });
}
