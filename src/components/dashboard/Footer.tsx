"use client";

import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Footer({
  collectorConfigured,
  lastDataAt,
}: {
  collectorConfigured: boolean | null;
  lastDataAt: string | null;
}) {
  const configured = collectorConfigured === true;
  return (
    <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-1.5 px-3 py-4 text-[11px] text-zinc-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                configured ? "bg-emerald-400" : "bg-amber-400"
              )}
            />
            {collectorConfigured === null
              ? "Checking collector..."
              : configured
                ? "Collector connected"
                : "Demo mode"}
          </span>
          <span aria-hidden className="text-zinc-700">
            |
          </span>
          <span>Last data: {fmtDateTime(lastDataAt)}</span>
        </div>
        <p className="text-zinc-600">
          Read-only monitoring - use investor passwords - Not investment advice
        </p>
      </div>
    </footer>
  );
}
