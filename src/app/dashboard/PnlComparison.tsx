'use client';

import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// "Actual vs Expected P&L" mini-chart. Rendered below the Account Equity curve
// when the snapshot-twr provider is active — the xPnL comparison lives on a
// 0-based P&L scale, which is incompatible with the equity chart's absolute
// account-equity scale. Keep the two charts separate so neither line is
// misleadingly squashed against the other's scale.

export interface PnlComparisonPoint {
  date: string;
  actualCumPnl: number;
  xpnlCumPnl: number;
}

interface Props {
  series: PnlComparisonPoint[];
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatPnl(value: number) {
  return `$${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

export default function PnlComparison({ series }: Props) {
  if (series.length === 0) return null;

  const last = series[series.length - 1];
  const actualColor = last.actualCumPnl >= last.xpnlCumPnl ? '#22c55e' : '#ef4444';

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload as PnlComparisonPoint;
    const gap = point.actualCumPnl - point.xpnlCumPnl;
    return (
      <div className="bg-[#1c2128] border border-[#30363d] rounded px-3 py-2 text-xs space-y-0.5">
        <div className="text-[#8b949e]">{formatDate(point.date)}</div>
        <div className={point.actualCumPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
          Actual {formatPnl(point.actualCumPnl)}
        </div>
        <div className="text-slate-400">
          xPnL {formatPnl(point.xpnlCumPnl)}
          <span className="ml-2 text-[#6e7681]">
            ({gap >= 0 ? '+' : ''}{gap.toFixed(2)})
          </span>
        </div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={160}>
      <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <defs>
          <linearGradient id="pnlComparisonGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={actualColor} stopOpacity={0.15} />
            <stop offset="95%" stopColor={actualColor} stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />

        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          tick={{ fill: '#6e7681', fontSize: 11 }}
          axisLine={{ stroke: '#30363d' }}
          tickLine={false}
          minTickGap={60}
        />
        <YAxis
          tickFormatter={(v) => `$${v}`}
          tick={{ fill: '#6e7681', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={64}
        />

        <Tooltip content={<CustomTooltip />} />

        <Area
          type="monotone"
          dataKey="actualCumPnl"
          stroke={actualColor}
          strokeWidth={2}
          fill="url(#pnlComparisonGradient)"
          dot={false}
          activeDot={{ r: 3, fill: actualColor, strokeWidth: 0 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="xpnlCumPnl"
          stroke="#94a3b8"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
