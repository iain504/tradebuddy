"use client";

import { CandlestickChart, Database, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RailSkeleton } from "@/components/dashboard/Skeletons";

export function EmptyState({
  onSeed,
  onAdd,
  seeding,
}: {
  onSeed: () => void;
  onAdd: () => void;
  seeding: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-10 sm:py-16">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/60 text-zinc-400"
      >
        <CandlestickChart className="size-6" />
      </span>
      <h2 className="mt-4 text-lg font-semibold tracking-tight text-zinc-100">
        No accounts yet
      </h2>
      <p className="mt-1.5 text-center text-sm leading-relaxed text-zinc-500">
        Connect a MetaTrader 4 or 5 account with its investor password to start
        tracking equity, drawdown and trade statistics.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <Button onClick={onSeed} disabled={seeding}>
          <Database className="size-4" />
          {seeding ? "Loading demo accounts..." : "Load demo accounts"}
        </Button>
        <Button variant="outline" onClick={onAdd} disabled={seeding}>
          <Plus className="size-4" />
          Add account
        </Button>
      </div>
      {seeding && (
        <div className="mt-8 w-full">
          <RailSkeleton cards={3} />
        </div>
      )}
    </div>
  );
}
