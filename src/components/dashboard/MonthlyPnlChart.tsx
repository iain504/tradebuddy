"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import type { MonthStatDTO } from "@/lib/types";
import {
  fmtMonthLabel,
  fmtMonthLong,
  fmtMoney,
  fmtMoneyCompact,
} from "@/lib/format";

interface MonthlyPnlChartProps {
  data: MonthStatDTO[];
  currency: string;
  height?: number;
}

type BarTooltipInput = TooltipProps<number, string> & { currency: string };

function MonthlyTooltip({ active, label, payload, currency }: BarTooltipInput) {
  if (!active || !payload || payload.length === 0) return null;
  const net = typeof payload[0].value === "number" ? payload[0].value : 0;
  const raw = payload[0].payload;
  const trades =
    raw && typeof raw === "object" && "trades" in raw &&
    typeof raw.trades === "number"
      ? raw.trades
      : 0;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl">
      <p className="font-medium text-zinc-300">
        {typeof label === "string" ? fmtMonthLong(label) : ""}
      </p>
      <p
        className={`mt-1 font-mono tabular-nums ${
          net >= 0 ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {fmtMoney(net, currency)} net
      </p>
      <p className="mt-0.5 text-[11px] text-zinc-500">
        {trades} {trades === 1 ? "trade" : "trades"}
      </p>
    </div>
  );
}

/** Green/red monthly net P&L bars, shared by aggregate and detail views. */
export function MonthlyPnlChart({
  data,
  currency,
  height = 240,
}: MonthlyPnlChartProps) {
  const tooltip = useMemo(
    () => (props: TooltipProps<number, string>) => (
      <MonthlyTooltip {...props} currency={currency} />
    ),
    [currency]
  );

  if (data.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-xs text-zinc-500"
      >
        No closed trades in this range yet
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={fmtMonthLabel}
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={{ stroke: "#3f3f46" }}
            tickLine={false}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={(v: number) => fmtMoneyCompact(v, currency)}
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={58}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={tooltip}
          />
          <Bar dataKey="net" radius={[3, 3, 0, 0]} maxBarSize={44}>
            {data.map((d) => (
              <Cell
                key={d.month}
                fill={d.net >= 0 ? "#34d399" : "#fb7185"}
                fillOpacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Merge per-account byMonth stats into a summed union. */
export function mergeMonthly(
  reports: Array<{ stats: { byMonth: MonthStatDTO[] } } | null>
): MonthStatDTO[] {
  const map = new Map<string, MonthStatDTO>();
  for (const r of reports) {
    if (!r) continue;
    for (const m of r.stats.byMonth) {
      const cur = map.get(m.month) ?? { month: m.month, net: 0, trades: 0 };
      cur.net += m.net;
      cur.trades += m.trades;
      map.set(m.month, cur);
    }
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}
