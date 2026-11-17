"use client";

import type { PositionDTO } from "@/lib/types";
import { SideBadge } from "@/components/dashboard/ui-bits";
import { fmtDateTimeShort, fmtMoney, fmtNum, fmtPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

const NUM = "px-3 py-2 text-right font-mono tabular-nums";
const HEAD = "px-3 py-2 font-medium";

/** Sticky-header table of currently open positions. */
export function PositionsTable({
  positions,
  currency,
}: {
  positions: PositionDTO[];
  currency: string;
}) {
  return (
    <div className="ts-scroll max-h-[420px] overflow-auto rounded-lg border border-zinc-800">
      <table className="w-full min-w-[760px] border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
          <tr className="border-b border-zinc-800">
            <th className={cn(HEAD, "text-left")}>Symbol</th>
            <th className={cn(HEAD, "text-left")}>Side</th>
            <th className={cn(HEAD, "text-right")}>Volume</th>
            <th className={cn(HEAD, "text-right")}>Open price</th>
            <th className={cn(HEAD, "text-right")}>Current</th>
            <th className={cn(HEAD, "text-left")}>Open time</th>
            <th className={cn(HEAD, "text-right")}>Swap</th>
            <th className={cn(HEAD, "text-right")}>Profit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70 text-zinc-300">
          {positions.length === 0 ? (
            <tr>
              <td
                colSpan={8}
                className="px-3 py-10 text-center text-zinc-500"
              >
                No open positions
              </td>
            </tr>
          ) : (
            positions.map((p) => (
              <tr
                key={p.positionId}
                className="transition-colors hover:bg-zinc-800/30"
              >
                <td className="px-3 py-2 font-mono font-medium text-zinc-100">
                  {p.symbol}
                </td>
                <td className="px-3 py-2">
                  <SideBadge side={p.side} />
                </td>
                <td className={NUM}>{fmtNum(p.volume)}</td>
                <td className={NUM}>{fmtPrice(p.openPrice)}</td>
                <td className={NUM}>{fmtPrice(p.currentPrice)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-400">
                  {fmtDateTimeShort(p.openTime)}
                </td>
                <td
                  className={cn(
                    NUM,
                    p.swap < 0 ? "text-rose-400" : "text-zinc-400"
                  )}
                >
                  {fmtMoney(p.swap, currency)}
                </td>
                <td
                  className={cn(
                    NUM,
                    "font-medium",
                    p.profit >= 0 ? "text-emerald-400" : "text-rose-400"
                  )}
                >
                  {fmtMoney(p.profit, currency)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
