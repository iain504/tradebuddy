import { ensureDemoData } from "@/lib/simulator";
import { json } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// POST /api/demo/seed - create demo accounts with full history (idempotent)
export async function POST() {
  try {
    const result = await ensureDemoData();
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("[demo.seed]", e);
    return json({ error: "Seed failed" }, 500);
  }
}
