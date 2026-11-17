"use client";

import { useId, useMemo } from "react";
import { format } from "date-fns";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import type { EquityPointDTO } from "@/lib/types";
import { fmtMoney, fmtMoneyCompact } from "@/lib/format";

interface EquityCurveProps {
  data: EquityPointDTO[];
  currency: string;
}

type CurveTooltipInput = TooltipProps<number, string> & { currency: string };

function CurveTooltip({ active, label, payload, currency }: CurveTooltipInput) {
  if (!active || !payload || payload.length === 0) return null;
  const ts = typeof label === "string" ? label : String(label);
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl">
      <p className="font-medium text-zinc-300">
        {ts && !Number.isNaN(new Date(ts).getTime())
          ? format(new Date(ts), "d MMM yyyy")
          : ""}
      </p>
      {payload.map((item) => {
        const value = typeof item.value === "number" ? item.value : 0;
        const isEquity = item.dataKey === "equity";
        return (
          <p
            key={String(item.dataKey)}
            className={`mt-1 flex items-center justify-between gap-4 font-mono tabular-nums ${
              isEquity ? "text-emerald-400" : "text-zinc-300"
            }`}
          >
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              {isEquity ? "Equity" : "Balance"}
            </span>
            {fmtMoney(value, currency)}
          </p>
        );
      })}
    </div>
  );
}

/** Equity area with emerald gradient + dashed balance line. */
export function EquityCurve({ data, currency }: EquityCurveProps) {
  const gradId = useId();

  const tooltip = useMemo(
    () => (props: TooltipProps<number, string>) => (
      <CurveTooltip {...props} currency={currency} />
    ),
    [currency]
  );

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient
              id={gradId}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.32} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="#27272a"
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            dataKey="ts"
            tickFormatter={(v: string) => {
              const d = new Date(v);
              return Number.isNaN(d.getTime()) ? "" : format(d, "d MMM");
            }}
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={{ stroke: "#3f3f46" }}
            tickLine={false}
            minTickGap={48}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => fmtMoneyCompact(v, currency)}
            tick={{ fill: "#71717a", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={62}
          />
          <Tooltip
            cursor={{ stroke: "#52525b", strokeDasharray: "4 4" }}
            content={tooltip}
          />
          <Area
            type="monotone"
            dataKey="equity"
            name="Equity"
            stroke="#34d399"
            strokeWidth={1.8}
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={{ r: 3, fill: "#34d399", stroke: "#022c22" }}
          />
          <Line
            type="monotone"
            dataKey="balance"
            name="Balance"
            stroke="#71717a"
            strokeWidth={1.4}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 3, fill: "#71717a", stroke: "#18181b" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
