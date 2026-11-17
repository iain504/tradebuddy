"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { SideBadge } from "@/components/dashboard/ui-bits";
import type { TradeDTO } from "@/lib/types";
import {
  fmtDateTimeShort,
  fmtMoney,
  fmtNum,
  fmtPrice,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const NUM = "px-3 py-1.5 text-right font-mono tabular-nums";
const HEAD = "px-3 py-2 font-medium";

/** Sticky-header table of closed trades, newest first, filterable by symbol. */
export function TradesTable({
  trades,
  currency,
}: {
  trades: TradeDTO[];
  currency: string;
}) {
  const [query, setQuery] = useState("");

  const sorted = useMemo(
    () =>
      [...trades].sort(
        (a, b) => Date.parse(b.closeTime) - Date.parse(a.closeTime)
      ),
    [trades]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((t) => t.symbol.toLowerCase().includes(q));
  }, [sorted, query]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by symbol..."
          aria-label="Filter trades by symbol"
          className="h-8 w-full max-w-56 border-zinc-800 bg-zinc-900/70 text-xs"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
          {filtered.length} of {sorted.length} trades
        </span>
      </div>
      <div className="ts-scroll max-h-[420px] overflow-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[820px] border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className={cn(HEAD, "text-left")}>Close time</th>
              <th className={cn(HEAD, "text-left")}>Symbol</th>
              <th className={cn(HEAD, "text-left")}>Side</th>
              <th className={cn(HEAD, "text-right")}>Volume</th>
              <th className={cn(HEAD, "text-right")}>Open &rarr; Close</th>
              <th className={cn(HEAD, "text-right")}>Net</th>
              <th className={cn(HEAD, "text-left")}>Comment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70 text-zinc-300">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-10 text-center text-zinc-500"
                >
                  {sorted.length === 0
                    ? "No closed trades in this range"
                    : "No trades match the filter"}
                </td>
              </tr>
            ) : (
              filtered.map((t) => (
                <tr
                  key={t.positionId}
                  className="transition-colors hover:bg-zinc-800/30"
                >
                  <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">
                    {fmtDateTimeShort(t.closeTime)}
                  </td>
                  <td className="px-3 py-1.5 font-mono font-medium text-zinc-100">
                    {t.symbol}
                  </td>
                  <td className="px-3 py-1.5">
                    <SideBadge side={t.side} />
                  </td>
                  <td className={NUM}>{fmtNum(t.volume)}</td>
                  <td className={cn(NUM, "text-zinc-400")}>
                    {fmtPrice(t.openPrice)} &rarr; {fmtPrice(t.closePrice)}
                  </td>
                  <td className={NUM}>
                    <span
                      className={cn(
                        "font-medium",
                        t.net >= 0 ? "text-emerald-400" : "text-rose-400"
                      )}
                    >
                      {fmtMoney(t.net, currency)}
                    </span>
                    <span className="block text-[10px] font-normal text-zinc-600">
                      comm {fmtMoney(t.commission, currency)} · swap{" "}
                      {fmtMoney(t.swap, currency)}
                    </span>
                  </td>
                  <td className="max-w-[10rem] truncate px-3 py-1.5 text-zinc-500">
                    {t.comment ? (
                      <span title={t.comment}>{t.comment}</span>
                    ) : (
                      <span className="text-zinc-700">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
