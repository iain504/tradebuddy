"use client";

import type { SymbolStatDTO } from "@/lib/types";
import { fmtNum, fmtPct, fmtSigned } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Per-symbol net performance with a magnitude bar. */
export function SymbolBreakdown({
  bySymbol,
  currency,
}: {
  bySymbol: SymbolStatDTO[];
  currency: string;
}) {
  const maxAbs = Math.max(...bySymbol.map((s) => Math.abs(s.net)), 1);

  if (bySymbol.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-zinc-500">
        No symbols traded in this range
      </p>
    );
  }

  return (
    <div className="ts-scroll max-h-72 space-y-3 overflow-y-auto pr-1">
      {bySymbol.map((s) => {
        const width = (Math.abs(s.net) / maxAbs) * 100;
        const positive = s.net >= 0;
        return (
          <div key={s.symbol}>
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="font-mono text-xs font-semibold text-zinc-100">
                  {s.symbol}
                </span>
                <span className="truncate text-[10px] text-zinc-500">
                  {s.trades} {s.trades === 1 ? "trade" : "trades"} ·{" "}
                  {fmtPct(s.winRate, 0)} win · {fmtNum(s.volume)} lots
                </span>
              </div>
              <span
                className={cn(
                  "shrink-0 font-mono text-xs tabular-nums",
                  positive ? "text-emerald-400" : "text-rose-400"
                )}
              >
                {fmtSigned(s.net, currency)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800/70">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-300",
                  positive ? "bg-emerald-400" : "bg-rose-400"
                )}
                style={{ width: `${Math.max(width, 1.5)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
