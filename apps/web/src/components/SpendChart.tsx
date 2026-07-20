import type { DaySummaryRow } from "@ziplyne/core/browser";
import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrencyExact, shortDate } from "../lib/format.js";

interface SpendChartProps {
  days: DaySummaryRow[];
}

interface TipPayload {
  active?: boolean;
  payload?: Array<{ value?: number | string }>;
  label?: string;
}

function ChartTip({ active, payload, label }: TipPayload) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const value = Number(payload[0]?.value ?? 0);
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{label}</div>
      <div className="chart-tip-value tnum">{formatCurrencyExact(value)}</div>
    </div>
  );
}

// Daily spend area chart — brand gradient, hairline grid, no axes chrome.
// Fills its parent; the parent must have an explicit size (panel body).
export function SpendChart({ days }: SpendChartProps) {
  const gradientId = useId();
  if (days.length === 0) {
    return <div className="center-muted">No spend recorded yet.</div>;
  }
  const data = days.map((day) => ({
    day: shortDate(day.day),
    cost: day.costUsd,
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={data}
        margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--brand)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          vertical={false}
          stroke="var(--line)"
          strokeDasharray="0"
        />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--t3)", fontSize: 11 }}
          tickMargin={8}
          minTickGap={48}
        />
        <YAxis hide domain={[0, "dataMax"]} />
        <Tooltip
          cursor={{ stroke: "var(--line-strong)", strokeDasharray: "3 3" }}
          content={<ChartTip />}
        />
        <Area
          type="monotone"
          dataKey="cost"
          stroke="var(--brand)"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{
            r: 4,
            fill: "var(--brand)",
            stroke: "var(--bg1)",
            strokeWidth: 2,
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
