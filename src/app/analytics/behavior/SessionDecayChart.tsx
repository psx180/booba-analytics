'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { TOOLTIP_STYLE } from '../types';
import {
  computeDecaySeries,
  type DecayPoint,
  type SessionDecayPosition,
} from './sessionDecay';

export type { SessionDecayPosition } from './sessionDecay';

export interface SessionDecayProps {
  positions: SessionDecayPosition[];
}

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

function DecayTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as DecayPoint;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="text-white font-medium mb-1">Trade #{label}</div>
      <div className="text-[#8b949e]">Avg P&L: ${d?.avgPnl.toFixed(2)}</div>
      <div className="text-white font-medium">{d?.count} sessions</div>
    </div>
  );
}

export default function SessionDecayChart({ positions }: SessionDecayProps) {
  const {
    series,
    optimalStop,
    slope,
    isFatigueSignificant,
  } = computeDecaySeries(positions);

  if (series.length < 2) {
    return (
      <div className="flex flex-col gap-2 h-full">
        <span className="text-xs font-medium text-[#e6edf3]">Performance by Trade # in Session</span>
        <div className="flex-1 flex items-center justify-center text-xs text-[#4a5568] italic">
          Not enough multi-trade session data yet
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-[#e6edf3]">Performance by Trade # in Session</span>

      <ResponsiveContainer width="100%" height={195}>
        <LineChart data={series} margin={{ top: 16, right: 16, left: 0, bottom: 16 }}>
          <CartesianGrid stroke="#21262d" />
          <XAxis
            dataKey="trade"
            {...axisProps}
            label={{ value: 'Trade # in session', position: 'insideBottom', offset: -8, fontSize: 10, fill: '#6e7681' }}
          />
          <YAxis
            {...axisProps}
            tickFormatter={(v) => `$${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(0)}`}
          />
          <Tooltip content={<DecayTip />} />
          <ReferenceLine y={0} stroke="#6e7681" strokeDasharray="3 2" />
          {isFatigueSignificant && optimalStop != null && (
            <ReferenceLine
              x={optimalStop}
              stroke="#f59e0b"
              strokeDasharray="4 2"
              label={{
                value: `Stop: #${optimalStop}`,
                position: 'insideTopRight',
                fontSize: 9,
                fill: '#f59e0b',
              }}
            />
          )}
          <Line
            type="monotone"
            dataKey="avgPnl"
            stroke="#60a5fa"
            strokeWidth={2}
            dot={(props: any) => {
              const r = Math.max(2, Math.min(6, (props.payload?.count ?? 0) / 3));
              return (
                <circle
                  key={`dot-${props.payload?.trade}`}
                  cx={props.cx}
                  cy={props.cy}
                  r={r}
                  fill="#60a5fa"
                />
              );
            }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {isFatigueSignificant && optimalStop != null ? (
        <p className="text-xs text-[#8b949e] leading-relaxed">
          Decision fatigue detected: performance declines by{' '}
          <span className="text-red-400">${Math.abs(slope).toFixed(2)}</span> per additional trade (significant).
          Performance peaks at trade{' '}
          <span className="text-white font-medium">#{optimalStop}</span>.
        </p>
      ) : (
        <p className="text-xs text-[#8b949e] leading-relaxed">
          No significant fatigue pattern detected across{' '}
          <span className="text-white font-medium">{series.length}</span> trade positions.
          Performance is roughly consistent regardless of how many trades you take in a session.
        </p>
      )}
    </div>
  );
}
