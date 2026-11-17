import { json, collectorConfigured } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// GET /api/health
export async function GET() {
  return json({
    ok: true,
    service: "mt-monitor",
    time: new Date().toISOString(),
    collectorConfigured: collectorConfigured(),
    ingestTokenRequired: Boolean(process.env.INGEST_TOKEN),
  });
}
