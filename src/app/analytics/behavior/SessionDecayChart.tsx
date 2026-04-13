'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { TOOLTIP_STYLE } from '../types';

export interface SessionDecayPosition {
  kind: string;
  pnl: number | null;
  firstEntryTime: string | null;
}

export interface SessionDecayProps {
  positions: SessionDecayPosition[];
}

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

interface DecayPoint {
  trade: number;
  avgPnl: number;
  count: number;
}

function computeDecaySeries(positions: SessionDecayPosition[]): {
  series: DecayPoint[];
  optimalStop: number | null;
  avgDeclineAfter: number;
  savingsPerSession: number;
} {
  const valid = positions.filter(
    (p) => p.kind === 'position' && p.pnl != null && p.firstEntryTime != null,
  );
  if (valid.length < 10) return { series: [], optimalStop: null, avgDeclineAfter: 0, savingsPerSession: 0 };

  // Group by trading day (UTC date string YYYY-MM-DD)
  const byDay = new Map<string, { pnl: number; time: number }[]>();
  for (const p of valid) {
    const day = p.firstEntryTime!.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push({ pnl: p.pnl!, time: new Date(p.firstEntryTime!).getTime() });
    byDay.set(day, arr);
  }

  // Sort each day chronologically
  for (const arr of byDay.values()) arr.sort((a, b) => a.time - b.time);

  // Accumulate avg P&L per intra-day trade number (1-indexed)
  const byTradeNum = new Map<number, number[]>();
  for (const arr of byDay.values()) {
    arr.forEach(({ pnl }, idx) => {
      const n = idx + 1;
      const existing = byTradeNum.get(n) ?? [];
      existing.push(pnl);
      byTradeNum.set(n, existing);
    });
  }

  // Require ≥3 samples per trade number for statistical stability
  const series: DecayPoint[] = Array.from(byTradeNum.entries())
    .filter(([, pnls]) => pnls.length >= 3)
    .sort(([a], [b]) => a - b)
    .map(([n, pnls]) => ({
      trade: n,
      avgPnl: pnls.reduce((s, v) => s + v, 0) / pnls.length,
      count: pnls.length,
    }));

  if (series.length < 2) return { series, optimalStop: null, avgDeclineAfter: 0, savingsPerSession: 0 };

  // Optimal stop = trade number with peak avg P&L
  let maxAvg = -Infinity;
  let optimalStop = series[0].trade;
  for (const pt of series) {
    if (pt.avgPnl > maxAvg) { maxAvg = pt.avgPnl; optimalStop = pt.trade; }
  }

  const afterOptimal = series.filter((pt) => pt.trade > optimalStop);
  const avgDeclineAfter = afterOptimal.length > 0
    ? afterOptimal.reduce((s, pt) => s + pt.avgPnl, 0) / afterOptimal.length
    : 0;

  // Rough savings estimate: avg P&L decline * avg trades taken after optimal stop
  const savingsPerSession = avgDeclineAfter < 0 ? Math.abs(avgDeclineAfter) * afterOptimal.length : 0;

  return { series, optimalStop, avgDeclineAfter, savingsPerSession };
}

function DecayTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as DecayPoint;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="text-white font-medium mb-1">Trade #{label}</div>
      <div className="text-[#8b949e]">Avg P&L: ${d?.avgPnl.toFixed(2)}</div>
      <div className="text-[#6e7681] text-[10px]">{d?.count} sessions</div>
    </div>
  );
}

export default function SessionDecayChart({ positions }: SessionDecayProps) {
  const { series, optimalStop, avgDeclineAfter, savingsPerSession } = computeDecaySeries(positions);

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
          {optimalStop != null && (
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
            dot={{ r: 3, fill: '#60a5fa', strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {optimalStop != null && (
        <p className="text-xs text-[#8b949e] leading-relaxed">
          Performance peaks at trade{' '}
          <span className="text-white font-medium">#{optimalStop}</span>.
          {avgDeclineAfter < 0 && (
            <>
              {' '}Avg P&L drops to{' '}
              <span className="text-red-400">${avgDeclineAfter.toFixed(2)}</span> per trade after that
              {savingsPerSession > 0 && (
                <> — estimated{' '}
                  <span className="text-amber-400">${savingsPerSession.toFixed(0)}/session</span>{' '}
                  savings from stopping earlier
                </>
              )}.
            </>
          )}
        </p>
      )}
    </div>
  );
}
