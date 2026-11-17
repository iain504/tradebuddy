"use client";

import { CandlestickChart, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Header({
  onAddAccount,
  onRefresh,
  refreshing,
}: {
  onAddAccount: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center justify-between gap-3 px-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10 text-emerald-400"
          >
            <CandlestickChart className="size-5" />
          </span>
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-base font-semibold tracking-tight text-zinc-100">
              TradeScope
            </h1>
            <p className="text-[11px] text-zinc-500">
              MT4 / MT5 Account Monitor
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh all data"
          >
            <RefreshCw
              className={cn("size-4", refreshing && "animate-spin")}
            />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button size="sm" onClick={onAddAccount} aria-label="Add account">
            <Plus className="size-4" />
            <span className="hidden sm:inline">Add account</span>
            <span className="sm:hidden">Add</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
