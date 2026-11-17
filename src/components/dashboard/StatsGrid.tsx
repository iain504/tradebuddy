"use client";

import type { ReactNode } from "react";
import type { StatsDTO } from "@/lib/types";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

interface StatItem {
  label: string;
  value: ReactNode;
  valueClass?: string;
  sub?: ReactNode;
  extra?: string;
}

/** Compact definition cards for the report's StatsDTO. */
export function StatsGrid({
  stats,
  currency,
}: {
  stats: StatsDTO;
  currency: string;
}) {
  const items: StatItem[] = [
    {
      label: "Win rate",
      value: fmtPct(stats.winRate, 1),
      sub: (
        <span>
          <span className="text-emerald-400">{stats.winTrades}W</span>
          {" · "}
          <span className="text-rose-400">{stats.lossTrades}L</span>
        </span>
      ),
    },
    {
      label: "Profit factor",
      value: stats.profitFactor === null ? "n/a" : fmtNum(stats.profitFactor),
      sub: `${stats.totalTrades} trades`,
    },
    {
      label: "Expectancy",
      value: fmtMoney(stats.expectancy, currency),
      valueClass: cn(stats.expectancy >= 0 ? "text-emerald-400" : "text-rose-400"),
      sub: "per trade",
    },
    {
      label: "Sharpe",
      value: stats.sharpe === null ? "n/a" : fmtNum(stats.sharpe),
      sub: "annualized, rf=0",
    },
    {
      label: "Max drawdown",
      value: fmtPct(stats.maxDrawdownPct),
      valueClass: "text-rose-400",
      sub: fmtMoney(stats.maxDrawdownAbs, currency),
    },
    {
      label: "Recovery factor",
      value:
        stats.recoveryFactor === null
          ? "n/a"
          : fmtNum(stats.recoveryFactor),
    },
    {
      label: "Avg win / loss",
      value: <span className="text-emerald-400">{fmtMoney(stats.avgWin, currency)}</span>,
      sub: <span className="text-rose-400">{fmtMoney(stats.avgLoss, currency)}</span>,
    },
    {
      label: "Largest win / loss",
      value: (
        <span className="text-emerald-400">{fmtMoney(stats.largestWin, currency)}</span>
      ),
      sub: (
        <span className="text-rose-400">{fmtMoney(stats.largestLoss, currency)}</span>
      ),
    },
    {
      label: "Max consec. W / L",
      value: <span className="text-emerald-400">{stats.maxConsecWins}W</span>,
      sub: <span className="text-rose-400">{stats.maxConsecLosses}L</span>,
    },
    {
      label: "Long / short net",
      value: (
        <span className={stats.longNet >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {fmtMoney(stats.longNet, currency)}
        </span>
      ),
      sub: (
        <span className={stats.shortNet >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {fmtMoney(stats.shortNet, currency)} short
        </span>
      ),
      extra: `${stats.longTrades} long · ${stats.shortTrades} short`,
    },
    {
      label: "Total volume",
      value: `${fmtNum(stats.totalVolume)} lots`,
      sub: `${stats.totalTrades} trades`,
    },
    {
      label: "Commission",
      value: fmtMoney(stats.commissionTotal, currency),
      valueClass: "text-rose-400",
    },
    {
      label: "Swap",
      value: fmtMoney(stats.swapTotal, currency),
      valueClass: cn(stats.swapTotal >= 0 ? "text-zinc-100" : "text-rose-400"),
    },
    {
      label: "Best / worst trade",
      value: (
        <span className="text-emerald-400">{fmtMoney(stats.bestTrade, currency)}</span>
      ),
      sub: (
        <span className="text-rose-400">{fmtMoney(stats.worstTrade, currency)}</span>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
      {items.map((item) => (
        <StatCard key={item.label} item={item} />
      ))}
    </div>
  );
}

function StatCard({ item }: { item: StatItem }) {
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {item.label}
      </p>
      <p
        className={cn(
          "mt-1.5 truncate font-mono text-sm font-medium tabular-nums text-zinc-100",
          item.valueClass
        )}
      >
        {item.value}
      </p>
      {item.extra !== undefined ? (
        <p className="mt-0.5 truncate text-[10px] text-zinc-600">{item.extra}</p>
      ) : null}
      {item.sub !== undefined && (
        <p className="mt-0.5 truncate font-mono text-[11px] tabular-nums">
          {item.sub}
        </p>
      )}
    </div>
  );
}
