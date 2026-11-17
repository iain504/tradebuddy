"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EquityCurve } from "@/components/dashboard/EquityCurve";
import { MonthlyPnlChart } from "@/components/dashboard/MonthlyPnlChart";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { SymbolBreakdown } from "@/components/dashboard/SymbolBreakdown";
import { TradesTable } from "@/components/dashboard/TradesTable";
import {
  DemoChip,
  Panel,
  PlatformBadge,
  StatusDot,
  pnlClass,
} from "@/components/dashboard/ui-bits";
import { RANGES, type ReportRange } from "@/components/dashboard/api";
import type { AccountSummary, ReportDTO } from "@/lib/types";
import {
  fmtDateTime,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtSigned,
  relTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const KPI_NUM = "font-mono tabular-nums";

function statusTone(status: AccountSummary["status"]): string {
  switch (status) {
    case "ACTIVE":
      return "text-emerald-300";
    case "PENDING":
      return "text-amber-300";
    case "PAUSED":
      return "text-zinc-300";
    default:
      return "text-rose-300";
  }
}

export function AccountDetail({
  report,
  range,
  onRangeChange,
  onSync,
  syncing,
}: {
  report: ReportDTO;
  range: ReportRange;
  onRangeChange: (range: ReportRange) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const account: AccountSummary = report.account;
  const { stats, equityCurve, positions, trades } = report;
  const currency = account.currency;
  const marginLevel = account.latest?.marginLevel ?? null;
  const openVolume = positions.reduce((s, p) => s + p.volume, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Account header strip */}
      <Panel className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
              {account.brokerName}
            </h2>
            <PlatformBadge platform={account.platform} />
            {account.demo && <DemoChip />}
          </div>
          <p className="mt-1 truncate text-xs text-zinc-500">
            <span className="font-mono text-zinc-400">#{account.login}</span>
            <span className="mx-1.5 text-zinc-700">·</span>
            {account.owner.name}
            {account.serverName && (
              <>
                <span className="mx-1.5 text-zinc-700">·</span>
                <span className="font-mono">{account.serverName}</span>
              </>
            )}
            {account.leverage !== null && (
              <>
                <span className="mx-1.5 text-zinc-700">·</span>
                1:{account.leverage}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-[11px]",
                statusTone(account.status)
              )}
            >
              <StatusDot status={account.status} />
              {account.status}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={onSync}
              disabled={syncing}
              aria-label={`Fetch fresh data for ${account.brokerName}`}
            >
              <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
              Fetch now
            </Button>
          </div>
          <span className="text-[11px] text-zinc-500">
            Synced {relTime(account.lastSyncAt)}
            {account.lastError ? ` - ${account.lastError}` : ""}
          </span>
        </div>
      </Panel>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Equity"
          value={fmtMoney(stats.equity, currency)}
        />
        <Kpi label="Balance" value={fmtMoney(stats.balance, currency)} />
        <Kpi
          label="Floating P&L"
          value={fmtSigned(stats.floatingPnL, currency)}
          valueClass={pnlClass(stats.floatingPnL)}
          sub={`${positions.length} open`}
        />
        <Kpi
          label="Net profit"
          value={fmtSigned(stats.netProfit, currency)}
          valueClass={pnlClass(stats.netProfit)}
          sub={
            <span className={pnlClass(stats.netProfit)}>
              {fmtPct(stats.returnPct)} return
            </span>
          }
        />
        <Kpi
          label="Margin level"
          value={
            marginLevel === null ? "—" : `${fmtNum(marginLevel, 0)}%`
          }
          sub={`margin ${fmtMoney(account.latest?.margin ?? 0, currency)}`}
        />
        <Kpi
          label="Open positions"
          value={String(positions.length)}
          sub={`volume ${fmtNum(openVolume)} lots`}
        />
      </div>

      {/* Equity curve */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium tracking-tight text-zinc-200">
            Equity curve
          </h3>
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
              <span aria-hidden className="h-0.5 w-4 rounded bg-emerald-400" />
              Equity
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
              <span
                aria-hidden
                className="h-0 w-4 border-t-2 border-dashed border-zinc-500"
              />
              Balance
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={range}
              onValueChange={(v) => {
                if ((RANGES as readonly string[]).includes(v)) {
                  onRangeChange(v as ReportRange);
                }
              }}
              aria-label="Report range"
            >
              {RANGES.map((r) => (
                <ToggleGroupItem
                  key={r}
                  value={r}
                  className="px-2.5 font-mono text-[11px]"
                >
                  {r}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        <div className="mt-3">
          {equityCurve.length === 0 ? (
            <div className="flex h-[320px] items-center justify-center text-xs text-zinc-500">
              No snapshots in this range
            </div>
          ) : (
            <EquityCurve data={equityCurve} currency={currency} />
          )}
        </div>
      </Panel>

      {/* Statistics */}
      <Panel className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium tracking-tight text-zinc-200">
            Statistics
          </h3>
          <span className="text-[11px] text-zinc-500">
            {fmtDateTime(equityCurve[0]?.ts)} &rarr; {fmtDateTime(equityCurve[equityCurve.length - 1]?.ts)}
          </span>
        </div>
        <div className="mt-3">
          <StatsGrid stats={stats} currency={currency} />
        </div>
      </Panel>

      {/* Monthly P&L */}
      <Panel className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium tracking-tight text-zinc-200">
            Monthly P&L
          </h3>
          <span className="text-[11px] text-zinc-500">
            {stats.byMonth.length} months
          </span>
        </div>
        <div className="mt-3">
          <MonthlyPnlChart data={stats.byMonth} currency={currency} height={220} />
        </div>
      </Panel>

      {/* Symbol breakdown */}
      <Panel className="p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium tracking-tight text-zinc-200">
            Symbol breakdown
          </h3>
          <span className="text-[11px] text-zinc-500">
            net by instrument
          </span>
        </div>
        <div className="mt-3">
          <SymbolBreakdown bySymbol={stats.bySymbol} currency={currency} />
        </div>
      </Panel>

      {/* Positions & history */}
      <Tabs defaultValue="positions">
        <TabsList className="bg-zinc-900">
          <TabsTrigger value="positions">
            Open positions ({positions.length})
          </TabsTrigger>
          <TabsTrigger value="history">
            Trade history ({trades.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="positions" className="mt-3">
          <PositionsTable positions={positions} currency={currency} />
        </TabsContent>
        <TabsContent value="history" className="mt-3">
          <TradesTable trades={trades} currency={currency} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Kpi({
  label,
  value,
  valueClass,
  sub,
}: {
  label: string;
  value: string;
  valueClass?: string;
  sub?: React.ReactNode;
}) {
  return (
    <Panel className="px-3.5 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <div
        className={cn(
          "mt-1.5 whitespace-nowrap text-base font-semibold text-zinc-100 xl:text-lg",
          KPI_NUM,
          valueClass
        )}
      >
        {value}
      </div>
      {sub !== undefined && (
        <p className={cn("mt-1 truncate text-[11px] text-zinc-500", KPI_NUM)}>
          {sub}
        </p>
      )}
    </Panel>
  );
}
