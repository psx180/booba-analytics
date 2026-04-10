'use client';

import { useState, useEffect } from 'react';
import type { AnalyticsChartProps, PerformanceStats } from './types';
import { buildParams } from './types';

type DayBreakdown = PerformanceStats;
type DayMap = Record<string, DayBreakdown>;

const MONTHS_BACK = 6;
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function calColor(pnl: number, maxPos: number, maxNeg: number): string {
  if (pnl === 0) return '#161b22';
  if (pnl > 0 && maxPos > 0) {
    const t = pnl / maxPos;
    if (t < 0.25) return '#0e4429';
    if (t < 0.5)  return '#006d32';
    if (t < 0.75) return '#26a641';
    return '#39d353';
  }
  if (pnl < 0 && maxNeg > 0) {
    const t = Math.abs(pnl) / maxNeg;
    if (t < 0.25) return '#3f0000';
    if (t < 0.5)  return '#7f1d1d';
    if (t < 0.75) return '#b91c1c';
    return '#ef4444';
  }
  return '#161b22';
}

/** Build the full week-column grid from startSunday to today (inclusive). */
function buildWeeks(startSunday: Date, today: Date): Date[][] {
  const weeks: Date[][] = [];
  const cursor = new Date(startSunday);
  let week: Date[] = [];
  while (cursor <= today) {
    week.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) { week.push(new Date(cursor)); cursor.setDate(cursor.getDate() + 1); }
    weeks.push(week);
  }
  return weeks;
}

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface TooltipState {
  date: string;
  data: DayBreakdown;
  x: number;
  y: number;
}

export default function CalendarHeatmap({ walletAddress, filters }: AnalyticsChartProps) {
  const [dayMap, setDayMap] = useState<DayMap>({});
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    setLoading(true);
    const p = buildParams(walletAddress, filters);
    p.set('groupBy', 'date');
    fetch(`/api/analytics/breakdown?${p}`)
      .then((r) => r.json())
      .then((d) => setDayMap(d.breakdowns?.date ?? {}))
      .finally(() => setLoading(false));
  }, [walletAddress, filters]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startMonth = new Date(today);
  startMonth.setMonth(startMonth.getMonth() - MONTHS_BACK);
  startMonth.setDate(1);
  const startSunday = new Date(startMonth);
  startSunday.setDate(startSunday.getDate() - startSunday.getDay());

  const weeks = buildWeeks(startSunday, today);

  const pnlValues = Object.values(dayMap).map((d) => d.totalPnl).filter((v) => v !== 0);
  const maxPos = Math.max(0, ...pnlValues.filter((v) => v > 0));
  const maxNeg = Math.max(0, ...pnlValues.filter((v) => v < 0).map((v) => Math.abs(v)));

  // Month label positions: one label per distinct month, at the first week of that month
  const monthLabels: { label: string; colIndex: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, ci) => {
    const firstDay = week[0];
    if (firstDay.getMonth() !== lastMonth && firstDay >= startMonth) {
      monthLabels.push({ label: MONTH_NAMES[firstDay.getMonth()], colIndex: ci });
      lastMonth = firstDay.getMonth();
    }
  });

  if (loading) {
    return (
      <div className="h-32 flex items-center justify-center text-[#6e7681] text-sm animate-pulse">
        Loading calendar…
      </div>
    );
  }

  const hasTrades = Object.keys(dayMap).length > 0;

  if (!hasTrades) {
    return (
      <div className="h-32 flex items-center justify-center text-[#6e7681] text-sm">
        No closed trades yet. Import trades and run analytics to see the calendar.
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Month labels */}
      <div className="flex mb-1 ml-6">
        {weeks.map((_, ci) => {
          const label = monthLabels.find((m) => m.colIndex === ci);
          return (
            <div key={ci} className="w-4 shrink-0 mr-0.5 text-[10px] text-[#6e7681]">
              {label ? label.label : ''}
            </div>
          );
        })}
      </div>

      <div className="flex">
        {/* Day-of-week labels */}
        <div className="flex flex-col mr-1.5 mt-0.5">
          {DAY_LABELS.map((d, i) => (
            <div key={i} className="h-4 mb-0.5 text-[10px] text-[#6e7681] leading-4 w-4 text-right pr-0.5">
              {i % 2 === 1 ? d : ''}
            </div>
          ))}
        </div>

        {/* Calendar grid — overflow scrolls horizontally */}
        <div className="flex overflow-x-auto pb-1">
          {weeks.map((week, ci) => (
            <div key={ci} className="flex flex-col mr-0.5">
              {week.map((day, ri) => {
                const key = toKey(day);
                const data = dayMap[key];
                const isFuture = day > today;
                const isOutOfRange = day < startMonth;
                const pnl = data?.totalPnl ?? 0;
                const bg = isFuture || isOutOfRange ? 'transparent' : calColor(pnl, maxPos, maxNeg);

                return (
                  <div
                    key={ri}
                    className="w-4 h-4 rounded-sm mb-0.5 cursor-default"
                    style={{ background: bg }}
                    onMouseEnter={(e) => {
                      if (!data || isFuture || isOutOfRange) return;
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setTooltip({ date: key, data, x: rect.left + window.scrollX, y: rect.top + window.scrollY });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 mt-2 text-[10px] text-[#6e7681]">
        <span>Less</span>
        {['#0e4429', '#006d32', '#26a641', '#39d353'].map((c) => (
          <div key={c} className="w-4 h-4 rounded-sm" style={{ background: c }} />
        ))}
        <span>More (profit)</span>
        <span className="ml-3">Less</span>
        {['#3f0000', '#7f1d1d', '#b91c1c', '#ef4444'].map((c) => (
          <div key={c} className="w-4 h-4 rounded-sm" style={{ background: c }} />
        ))}
        <span>More (loss)</span>
      </div>

      {/* Hover tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-[#1c2128] border border-[#30363d] rounded-lg px-3 py-2 text-xs shadow-xl"
          style={{ left: tooltip.x + 6, top: tooltip.y - 80 }}
        >
          <div className="text-white font-medium mb-1">{tooltip.date}</div>
          <div className={tooltip.data.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
            P&L: {tooltip.data.totalPnl >= 0 ? '+' : ''}${tooltip.data.totalPnl.toFixed(2)}
          </div>
          <div className="text-[#8b949e]">Trades: {tooltip.data.tradeCount}</div>
          <div className="text-[#8b949e]">Win rate: {(tooltip.data.winRate * 100).toFixed(0)}%</div>
        </div>
      )}
    </div>
  );
}
