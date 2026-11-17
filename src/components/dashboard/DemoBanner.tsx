"use client";

import { X } from "lucide-react";

export type DemoBannerVariant = "not-configured" | "unreachable";

const COPY: Record<DemoBannerVariant, string> = {
  "not-configured":
    "Collector not configured - running in demo mode. Live accounts will sync automatically once the collector service is running (see DEPLOY.md).",
  unreachable:
    "Collector is configured but not reachable - live accounts will queue until it responds. Check the collector service (docker compose logs collector).",
};

export function DemoBanner({
  variant = "not-configured",
  onDismiss,
}: {
  variant?: DemoBannerVariant;
  onDismiss: () => void;
}) {
  return (
    <div className="border-b border-amber-400/20 bg-amber-400/[0.06]">
      <div className="mx-auto flex w-full max-w-[1600px] items-center gap-2.5 px-3 py-2 sm:px-6">
        <span
          aria-hidden
          className="size-2 shrink-0 animate-pulse rounded-full bg-amber-300"
        />
        <p className="flex-1 text-xs leading-relaxed text-amber-200/90">
          {COPY[variant]}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss demo mode banner"
          className="rounded p-1 text-amber-200/60 transition-colors hover:bg-amber-400/10 hover:text-amber-100"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
