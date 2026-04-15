'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

export interface UnderwaterPoint {
  date: string;
  underwater: number;
  underwaterPct: number;
}

interface Props {
  series: UnderwaterPoint[];
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatPct(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatDollar(value: number) {
  return `$${value.toFixed(2)}`;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as UnderwaterPoint;
  return (
    <div className="bg-[#1c2128] border border-[#30363d] rounded px-3 py-2 text-xs">
      <div className="text-[#8b949e] mb-1">{formatDate(point.date)}</div>
      <div className="text-red-400">
        {formatPct(point.underwaterPct)} ({formatDollar(point.underwater)})
      </div>
    </div>
  );
};

export default function UnderwaterCurve({ series }: Props) {
  if (series.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[#6e7681] text-xs">
        No drawdown data yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={140}>
      <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id="underwaterGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#ef4444" stopOpacity={0} />
            <stop offset="100%" stopColor="#ef4444" stopOpacity={0.45} />
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
          tickFormatter={(value) => `${value.toFixed(0)}%`}
          tick={{ fill: '#6e7681', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={48}
          domain={['dataMin', 0]}
        />

        <Tooltip content={<CustomTooltip />} />

        <Area
          type="monotone"
          dataKey="underwaterPct"
          stroke="#ef4444"
          strokeWidth={1.5}
          fill="url(#underwaterGradient)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
