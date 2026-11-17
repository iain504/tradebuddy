"use client";

import { useState } from "react";
import { Radio, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSetupDialog } from "@/components/dashboard/AgentSetupDialog";

/**
 * Banner shown when no pull-collector is configured (agent mode instances).
 * Instead of a dead-end warning it opens the agent setup guide.
 */
export function AgentOnboarding({ onDismiss }: { onDismiss: () => void }) {
  const [setupOpen, setSetupOpen] = useState(false);

  return (
    <>
      <div className="border-b border-emerald-400/20 bg-emerald-400/[0.05]">
        <div className="mx-auto flex w-full max-w-[1600px] items-center gap-2.5 px-3 py-2 sm:px-6">
          <span
            aria-hidden
            className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-400"
          />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-emerald-100/90">
            <span className="font-medium text-emerald-200">Agent mode.</span>{" "}
            Connect your MT4/MT5 terminals with a one-time push agent - it sends
            snapshots and full trade history straight to this dashboard. No Wine
            or gateway containers required.
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => setSetupOpen(true)}
            className="h-7 shrink-0 gap-1.5 bg-emerald-500 px-2.5 text-xs text-emerald-950 hover:bg-emerald-400"
          >
            <Radio className="size-3.5" />
            Setup guide
          </Button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss agent mode banner"
            className="rounded p-1 text-emerald-200/60 transition-colors hover:bg-emerald-400/10 hover:text-emerald-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <AgentSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </>
  );
}
