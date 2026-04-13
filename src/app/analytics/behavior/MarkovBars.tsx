'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Cell, ReferenceLine, LabelList, ResponsiveContainer,
} from 'recharts';
import { TOOLTIP_STYLE } from '../types';

export interface MarkovBarsProps {
  winAfterWin: number;
  winAfterLoss: number;
  overallWinRate: number;
  pValue: number | null;
  isSignificant: boolean;
}

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

function BarTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="text-white font-medium mb-1">{label}</div>
      <div className="text-[#8b949e]">Win rate: {(payload[0].value * 100).toFixed(1)}%</div>
    </div>
  );
}

export default function MarkovBars({
  winAfterWin, winAfterLoss, overallWinRate, pValue, isSignificant,
}: MarkovBarsProps) {
  const data = [
    { name: 'After Win',  value: winAfterWin,    color: '#3b82f6' },
    { name: 'After Loss', value: winAfterLoss,   color: '#f97316' },
    { name: 'Baseline',   value: overallWinRate, color: '#6b7280' },
  ];

  const belowBaseline = winAfterLoss < overallWinRate - 0.05;
  const interpretation = belowBaseline
    ? 'You perform worse after losses — consider pausing after a losing trade.'
    : 'Your outcomes are approximately independent — no significant serial dependency.';

  const pStr = pValue != null
    ? (pValue < 0.001 ? 'p<0.001' : `p=${pValue.toFixed(3)}`)
    : null;

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-[#e6edf3]">Win Rate by Prior Outcome</span>
        {isSignificant && pStr && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400">
            Significant · {pStr}
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={190}>
        <BarChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#21262d" />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis
            {...axisProps}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
          />
          <Tooltip content={<BarTip />} />
          <ReferenceLine
            y={0.5}
            stroke="#6e7681"
            strokeDasharray="4 2"
            label={{ value: '50%', position: 'right', fontSize: 9, fill: '#6e7681' }}
          />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={40}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color} fillOpacity={0.8} />
            ))}
            <LabelList
              dataKey="value"
              position="top"
              formatter={(v: any) => `${(Number(v) * 100).toFixed(1)}%`}
              style={{ fill: '#8b949e', fontSize: 10 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <p className="text-xs text-[#8b949e] leading-relaxed">{interpretation}</p>
    </div>
  );
}
