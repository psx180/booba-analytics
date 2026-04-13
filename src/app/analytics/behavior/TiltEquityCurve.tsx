'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceArea, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { TOOLTIP_STYLE } from '../types';

export interface TiltEpisode {
  id: string;
  startDate: string | null;
  endDate: string | null;
  tradeCount: number;
  totalPnl: number;
}

export interface TiltEquityCurveProps {
  /** Series from GET /api/analytics/equity-curve — each point has a date ISO string and cumulativePnl. */
  series: { date: string; cumulativePnl: number }[];
  episodes: TiltEpisode[];
  totalEpisodes: number;
  /** counterfactualImprovement from the tilt-episodes insight: how much P&L would improve if you paused during episodes. */
  counterfactualImprovement: number;
}

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function CurveTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const pnl = payload[0]?.value as number;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="text-[#8b949e] mb-1">{fmtDate(label)}</div>
      <div className={pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
        ${pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
      </div>
    </div>
  );
}

export default function TiltEquityCurve({
  series, episodes, totalEpisodes, counterfactualImprovement,
}: TiltEquityCurveProps) {
  if (series.length < 5) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-[#e6edf3]">Equity Curve with Tilt Episodes</span>
        <div className="flex items-center justify-center h-[220px] text-xs text-[#4a5568] italic">
          Not enough equity curve data yet
        </div>
      </div>
    );
  }

  // Convert date strings to numeric timestamps for a proper numeric XAxis,
  // so ReferenceArea x1/x2 (episode boundaries) don't need exact data-key matches.
  const tseries = series.map((pt) => ({ ...pt, ts: new Date(pt.date).getTime() }));
  const lastPnl = tseries[tseries.length - 1].cumulativePnl;
  const lineColor = lastPnl >= 0 ? '#22c55e' : '#ef4444';

  const validEpisodes = episodes.filter((ep) => ep.startDate != null && ep.endDate != null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium text-[#e6edf3]">Equity Curve with Tilt Episodes</span>
        {validEpisodes.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-[#6e7681]">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'rgba(239,68,68,0.35)' }} />
            Tilt episode
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={tseries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="tiltCurveGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={lineColor} stopOpacity={0.25} />
              <stop offset="95%" stopColor={lineColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="#21262d" />

          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={fmtDate}
            {...axisProps}
            minTickGap={60}
          />
          <YAxis
            {...axisProps}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
          />

          <Tooltip content={<CurveTip />} />
          <ReferenceLine y={0} stroke="#6e7681" strokeDasharray="3 2" />

          {/* Tilt episode shading */}
          {validEpisodes.map((ep) => (
            <ReferenceArea
              key={ep.id}
              x1={new Date(ep.startDate!).getTime()}
              x2={new Date(ep.endDate!).getTime()}
              fill="rgba(239,68,68,0.22)"
              strokeOpacity={0}
            />
          ))}

          <Area
            type="monotone"
            dataKey="cumulativePnl"
            stroke={lineColor}
            strokeWidth={1.5}
            fill="url(#tiltCurveGrad)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>

      <p className="text-xs text-[#8b949e] leading-relaxed">
        {totalEpisodes === 0 ? (
          'No tilt episodes detected — good discipline!'
        ) : (
          <>
            <span className="text-white font-medium">
              {totalEpisodes} tilt episode{totalEpisodes !== 1 ? 's' : ''}
            </span>{' '}
            detected (shaded red).
            {counterfactualImprovement > 0 && (
              <>
                {' '}Estimated cost:{' '}
                <span className="text-red-400">
                  ${Math.abs(Math.round(counterfactualImprovement)).toLocaleString()}
                </span>{' '}
                — pausing during these periods would have improved your P&L by that amount.
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}
