'use client';

import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import type { AnalyticsChartProps, PerformanceStats } from './types';
import { buildParams, TOOLTIP_STYLE } from './types';
import { useAuthFetch } from '@/lib/api-client';

type Breakdown = Record<string, PerformanceStats>;

const DOW_LABELS: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

function buildHourData(breakdown: Breakdown) {
  return Array.from({ length: 24 }, (_, h) => {
    const d = breakdown[String(h)];
    return {
      name: `${String(h).padStart(2, '0')}:00`,
      pnl: d?.totalPnl ?? 0,
      trades: d?.tradeCount ?? 0,
      winRate: d?.winRate ?? 0,
    };
  });
}

function buildDowData(breakdown: Breakdown) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = breakdown[String(i)];
    return {
      name: DOW_LABELS[i],
      pnl: d?.totalPnl ?? 0,
      trades: d?.tradeCount ?? 0,
      winRate: d?.winRate ?? 0,
    };
  });
}

function PnlTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const { pnl, trades, winRate } = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <div className="font-medium text-white mb-1">{label}</div>
      <div className={pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
        P&L: {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
      </div>
      {trades > 0 && (
        <>
          <div className="text-[#8b949e]">Trades: {trades}</div>
          <div className="text-[#8b949e]">Win rate: {(winRate * 100).toFixed(0)}%</div>
        </>
      )}
    </div>
  );
}

function generateSummary(hourData: ReturnType<typeof buildHourData>, dowData: ReturnType<typeof buildDowData>) {
  const activeHours = hourData.filter((h) => h.trades > 0);
  const activeDows = dowData.filter((d) => d.trades > 0);
  if (activeHours.length === 0) return null;

  const bestHour = activeHours.reduce((a, b) => (a.pnl > b.pnl ? a : b));
  const worstHour = activeHours.reduce((a, b) => (a.pnl < b.pnl ? a : b));
  const bestDow = activeDows.length > 0 ? activeDows.reduce((a, b) => (a.pnl > b.pnl ? a : b)) : null;

  const parts: string[] = [];
  parts.push(`Your best hour is ${bestHour.name} with avg P&L of $${(bestHour.pnl / bestHour.trades).toFixed(2)}.`);
  if (worstHour.name !== bestHour.name) {
    parts.push(`Your worst hour is ${worstHour.name} ($${(worstHour.pnl / worstHour.trades).toFixed(2)} avg).`);
  }
  if (bestDow) {
    parts.push(`You're most profitable on ${bestDow.name} ($${bestDow.pnl.toFixed(2)} total).`);
  }
  return parts.join(' ');
}

export default function TimeAnalysis({ filters, journalId }: AnalyticsChartProps) {
  const authFetch = useAuthFetch();
  const [hourBreakdown, setHourBreakdown] = useState<Breakdown>({});
  const [dowBreakdown, setDowBreakdown] = useState<Breakdown>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const base = buildParams(filters, journalId);

    const hourP = new URLSearchParams(base);
    hourP.set('groupBy', 'entryHour');
    const dowP = new URLSearchParams(base);
    dowP.set('groupBy', 'entryDayOfWeek');

    Promise.all([
      authFetch(`/api/analytics/breakdown?${hourP}`).then((r) => r.json()),
      authFetch(`/api/analytics/breakdown?${dowP}`).then((r) => r.json()),
    ])
      .then(([hourRes, dowRes]) => {
        setHourBreakdown(hourRes.breakdowns?.entryHour ?? {});
        setDowBreakdown(dowRes.breakdowns?.entryDayOfWeek ?? {});
      })
      .finally(() => setLoading(false));
  }, [filters, journalId, authFetch]);

  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm animate-pulse">
        Loading time analysis…
      </div>
    );
  }

  const hourData = buildHourData(hourBreakdown);
  const dowData = buildDowData(dowBreakdown);
  const hasData = hourData.some((d) => d.trades > 0);

  if (!hasData) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
        No trade timing data yet. Compute analytics to populate entry-hour and day-of-week metrics.
      </div>
    );
  }

  const summary = generateSummary(hourData, dowData);

  const axisProps = {
    tick: { fill: '#6e7681', fontSize: 11 },
    axisLine: { stroke: '#21262d' },
    tickLine: false,
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hour of day */}
        <div>
          <p className="text-xs text-[#6e7681] mb-3">P&L by Hour of Day (UTC)</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={hourData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
              <XAxis dataKey="name" {...axisProps} interval={3} />
              <YAxis {...axisProps} width={55} tickFormatter={(v) => `$${v >= 0 ? '' : ''}${v.toFixed(0)}`} />
              <Tooltip content={<PnlTooltip />} cursor={TOOLTIP_STYLE.cursor} />
              <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                {hourData.map((entry, i) => (
                  <Cell key={i} fill={entry.pnl >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={entry.trades === 0 ? 0.15 : 0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Day of week */}
        <div>
          <p className="text-xs text-[#6e7681] mb-3">P&L by Day of Week (UTC)</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dowData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
              <XAxis dataKey="name" {...axisProps} />
              <YAxis {...axisProps} width={55} tickFormatter={(v) => `$${v.toFixed(0)}`} />
              <Tooltip content={<PnlTooltip />} cursor={TOOLTIP_STYLE.cursor} />
              <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                {dowData.map((entry, i) => (
                  <Cell key={i} fill={entry.pnl >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={entry.trades === 0 ? 0.15 : 0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {summary && (
        <p className="text-sm text-[#8b949e] bg-[#0d1117] rounded-lg px-4 py-3 border border-[#21262d]">
          {summary}
        </p>
      )}
    </div>
  );
}
