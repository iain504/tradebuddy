"use client";

import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { HealthDTO } from "./api";

type ChipTone = "ok" | "warn" | "down" | "muted";

const TONE_DOT: Record<ChipTone, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  down: "bg-red-400",
  muted: "bg-zinc-600",
};

function Chip({
  tone,
  label,
  title,
}: {
  tone: ChipTone;
  label: string;
  title?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={title}
      aria-label={label}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
      {label}
    </span>
  );
}

/**
 * One chip per pipeline component, driven by the collector's own gateway
 * probes (see collector.py /health). Hidden entirely while the collector is
 * not configured - the demo banner explains that case instead.
 */
export function Footer({
  health,
  lastDataAt,
}: {
  health: HealthDTO | null;
  lastDataAt: string | null;
}) {
  const configured = health?.collectorConfigured === true;
  const collector = health?.collector ?? null;

  // Collector tone: checking / demo mode / unreachable / live
  const collectorChip = !health
    ? { tone: "muted" as ChipTone, label: "Checking collector..." }
    : !configured
      ? { tone: "warn" as ChipTone, label: "Demo mode" }
      : !collector
        ? { tone: "down" as ChipTone, label: "Collector unreachable" }
        : { tone: "ok" as ChipTone, label: "Collector live" };

  // MT4 gateway: service reachability + terminal bridge state.
  const mt4 = collector?.gateways?.mt4 ?? null;
  const mt4Bridge = mt4?.urls?.[0]?.bridge ?? null;
  const mt4Chip = !configured || !collector
    ? null
    : !mt4
      ? { tone: "muted" as ChipTone, label: "MT4 gateway unknown" }
      : !mt4.ok
        ? {
            tone: "warn" as ChipTone,
            label: "MT4 gateway offline",
            title: "The mt4-gateway service is not reachable from the collector.",
          }
        : mt4Bridge === "connected"
          ? { tone: "ok" as ChipTone, label: "MT4 terminal attached" }
          : {
              tone: "warn" as ChipTone,
              label: "MT4 gateway up - terminal not attached",
              title:
                "Gateway service is running, but no MT4 terminal is connected to its ZeroMQ bridge. Complete the first-time MT4 setup (see README.md).",
            };

  // MT5 gateway: the Wine-based service only exists in the Docker deployment.
  const mt5 = collector?.gateways?.mt5 ?? null;
  const mt5Chip = !configured || !collector
    ? null
    : !mt5
      ? { tone: "muted" as ChipTone, label: "MT5 gateway unknown" }
      : mt5.ok
        ? { tone: "ok" as ChipTone, label: "MT5 gateway online" }
        : {
            tone: "warn" as ChipTone,
            label: "MT5 gateway offline",
            title:
              "The MT5 gateway runs under Wine and needs the Docker deployment (deploy.sh).",
          };

  return (
    <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-1.5 px-3 py-4 text-[11px] text-zinc-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Chip tone={collectorChip.tone} label={collectorChip.label} />
          {mt4Chip && (
            <>
              <span aria-hidden className="text-zinc-700">
                |
              </span>
              <Chip tone={mt4Chip.tone} label={mt4Chip.label} title={mt4Chip.title} />
            </>
          )}
          {mt5Chip && (
            <>
              <span aria-hidden className="text-zinc-700">
                |
              </span>
              <Chip tone={mt5Chip.tone} label={mt5Chip.label} title={mt5Chip.title} />
            </>
          )}
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
