"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, pnlClass } from "@/components/dashboard/ui-bits";
import {
  MonthlyPnlChart,
  mergeMonthly,
} from "@/components/dashboard/MonthlyPnlChart";
import type { AccountSummary, ReportDTO } from "@/lib/types";
import { fmtMoney, fmtNum, fmtSigned } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Segment palette - no blue/indigo tones. */
const SEGMENT_COLORS = [
  "#34d399",
  "#2dd4bf",
  "#fbbf24",
  "#fb7185",
  "#a1a1aa",
  "#a3e635",
];

export function AggregateView({
  accounts,
  reports,
  loading,
}: {
  accounts: AccountSummary[];
  reports: Array<ReportDTO | null> | null;
  loading: boolean;
}) {
  const totalEquity = accounts.reduce(
    (s, a) => s + (a.latest?.equity ?? 0),
    0
  );
  const totalFloating = accounts.reduce(
    (s, a) => s + (a.latest?.floatingPnL ?? 0),
    0
  );
  const activeCount = accounts.filter((a) => a.status === "ACTIVE").length;

  const netProfit = useMemo(() => {
    if (!reports) return null;
    return reports.reduce((s, r) => s + (r?.stats.netProfit ?? 0), 0);
  }, [reports]);

  const monthly = useMemo(
    () => (reports ? mergeMonthly(reports) : []),
    [reports]
  );

  const currency = accounts[0]?.currency ?? "USD";

  const allocation = useMemo(() => {
    return accounts
      .map((a, i) => {
        const equity = a.latest?.equity ?? 0;
        const pct = totalEquity > 0 ? (equity / totalEquity) * 100 : 0;
        return {
          id: a.id,
          name: a.brokerName,
          platform: a.platform,
          equity,
          pct,
          color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
        };
      })
      .sort((x, y) => y.pct - x.pct);
  }, [accounts, totalEquity]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Total equity"
          value={fmtMoney(totalEquity, currency)}
          sub={`${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`}
        />
        <KpiCard
          label="Floating P&L"
          value={fmtSigned(totalFloating, currency)}
          valueClass={cn("font-mono tabular-nums", pnlClass(totalFloating))}
          sub="across open positions"
        />
        <KpiCard
          label="Net profit (all time)"
          value={
            loading || netProfit === null ? (
              <Skeleton className="h-7 w-28" />
            ) : (
              fmtSigned(netProfit, currency)
            )
          }
          valueClass={cn(
            "font-mono tabular-nums",
            netProfit === null ? "text-zinc-100" : pnlClass(netProfit)
          )}
          sub="sum of account reports"
        />
        <KpiCard
          label="Active accounts"
          value={`${activeCount}/${accounts.length}`}
          valueClass="font-mono tabular-nums text-zinc-100"
          sub="status Active"
        />
      </div>

      <Panel className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium tracking-tight text-zinc-200">
            Equity allocation
          </h3>
          <span className="text-[11px] text-zinc-500">
            share of total equity
          </span>
        </div>
        <div className="mt-3 flex h-3 w-full gap-px overflow-hidden rounded-full bg-zinc-800/60">
          {allocation.map((seg) => (
            <div
              key={seg.id}
              className="h-full transition-all first:rounded-l-full last:rounded-r-full"
              style={{ width: `${seg.pct}%`, backgroundColor: seg.color }}
              title={`${seg.name} - ${fmtNum(seg.pct, 1)}%`}
            />
          ))}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {allocation.map((seg) => (
            <li
              key={seg.id}
              className="flex items-center gap-1.5 text-xs text-zinc-400"
            >
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: seg.color }}
              />
              <span className="max-w-[10rem] truncate">{seg.name}</span>
              <span className="font-mono tabular-nums text-zinc-500">
                {fmtNum(seg.pct, 1)}%
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium tracking-tight text-zinc-200">
            Monthly P&L - all accounts
          </h3>
          <span className="text-[11px] text-zinc-500">
            union of account months, summed
          </span>
        </div>
        <div className="mt-3">
          {reports === null && loading ? (
            <Skeleton className="h-[240px] w-full" />
          ) : (
            <MonthlyPnlChart data={monthly} currency={currency} height={240} />
          )}
        </div>
      </Panel>
    </div>
  );
}

function KpiCard({
  label,
  value,
  valueClass,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
  sub?: string;
}) {
  return (
    <Panel className="px-3.5 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <div
        className={cn(
          "mt-1.5 whitespace-nowrap text-lg font-semibold text-zinc-100 xl:text-xl",
          valueClass ?? "font-mono tabular-nums"
        )}
      >
        {value}
      </div>
      {sub && <p className="mt-1 text-[11px] text-zinc-500">{sub}</p>}
    </Panel>
  );
}
