import { json, collectorConfigured } from "@/lib/api-helpers";
import { getCollectorHealth } from "@/lib/collector-health";

export const dynamic = "force-dynamic";

// GET /api/health
// collectorConfigured: COLLECTOR_URL is present in the environment.
// collector: live snapshot from the collector's /health (null = unreachable),
//            including per-platform gateway probes (mt4 bridge state, mt5 up).
export async function GET() {
  const collector = await getCollectorHealth();
  return json({
    ok: true,
    service: "mt-monitor",
    time: new Date().toISOString(),
    collectorConfigured: collectorConfigured(),
    ingestTokenRequired: Boolean(process.env.INGEST_TOKEN),
    collector,
  });
}
