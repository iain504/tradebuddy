import { searchBrokers } from "@/lib/brokers";
import { json } from "@/lib/api-helpers";
import type { Platform } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/brokers/search?q=icm&platform=MT5
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  const platform = (url.searchParams.get("platform") || "MT5").toUpperCase() as Platform;
  if (platform !== "MT4" && platform !== "MT5") {
    return json({ error: "platform must be MT4 or MT5" }, 400);
  }
  const { items, reachable } = await searchBrokers(q, platform);
  return json({
    reachable,
    items,
    note: reachable
      ? undefined
      : "MetaQuotes public index unreachable from this host - use manual server entry or upload a .srv file.",
  });
}
