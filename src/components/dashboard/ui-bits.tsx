"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import type { AccountStatus, Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Subtle mount animation used across dashboard sections. */
export function FadeIn({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Standard dashboard surface panel. */
export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-zinc-800 bg-zinc-900/60",
        className
      )}
    >
      {children}
    </div>
  );
}

export function PlatformBadge({
  platform,
  className,
}: {
  platform: Platform;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] font-semibold tracking-widest",
        platform === "MT5"
          ? "border-teal-400/30 bg-teal-400/10 text-teal-300"
          : "border-amber-400/30 bg-amber-400/10 text-amber-300",
        className
      )}
    >
      {platform}
    </span>
  );
}

export function DemoChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-zinc-700/70 bg-zinc-800/60 px-1.5 py-px text-[10px] font-medium tracking-widest text-zinc-400",
        className
      )}
    >
      DEMO
    </span>
  );
}

export const STATUS_META: Record<
  AccountStatus,
  { label: string; dot: string; badge: string }
> = {
  ACTIVE: {
    label: "Active",
    dot: "bg-emerald-400",
    badge: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  },
  PENDING: {
    label: "Pending",
    dot: "bg-amber-400",
    badge: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  },
  ERROR: {
    label: "Error",
    dot: "bg-rose-400",
    badge: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  },
  PAUSED: {
    label: "Paused",
    dot: "bg-zinc-400",
    badge: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  },
};

export function StatusDot({
  status,
  className,
}: {
  status: AccountStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        meta.dot,
        status === "ACTIVE" && "animate-pulse",
        className
      )}
    />
  );
}

export function SideBadge({ side }: { side: "BUY" | "SELL" }) {
  return (
    <span
      className={cn(
        "inline-flex w-[3.1rem] justify-center rounded border px-1.5 py-px text-[10px] font-semibold tracking-wider",
        side === "BUY"
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
          : "border-rose-400/30 bg-rose-400/10 text-rose-300"
      )}
    >
      {side}
    </span>
  );
}

/** Text tone for signed monetary figures. */
export function pnlClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-zinc-400";
}
