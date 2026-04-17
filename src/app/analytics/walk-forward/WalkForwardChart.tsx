'use client';

import { useState, useEffect } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import { useAuthFetch } from '@/lib/api-client';
import { windowLabel } from '@/services/analytics/walk-forward';
import type { WalkForwardResult, WindowMetrics } from '@/services/analytics/walk-forward';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDollar(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

function fmtPf(v: number): string {
  return v >= 99 ? '—' : v.toFixed(2);
}

function trendIcon(t: 'improving' | 'declining' | 'stable'): string {
  if (t === 'improving') return '↑';
  if (t === 'declining') return '↓';
  return '→';
}

function trendColor(t: 'improving' | 'declining' | 'stable'): string {
  if (t === 'improving') return 'text-green-400';
  if (t === 'declining') return 'text-red-400';
  return 'text-[#8b949e]';
}

/** OLS slope for y = a + b*x, x = [0, 1, …, n-1]. */
function olsSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const sumX  = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY  = ys.reduce((a, v) => a + v, 0);
  const sumXY = ys.reduce((a, v, i) => a + i * v, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/** Compute regression line values to overlay on the chart. */
function trendLine(ys: number[]): number[] {
  const n = ys.length;
  const slope = olsSlope(ys);
  const mean  = ys.reduce((a, v) => a + v, 0) / n;
  const midX  = (n - 1) / 2;
  const intercept = mean - slope * midX;
  return ys.map((_, i) => intercept + slope * i);
}

// ── Chart data ────────────────────────────────────────────────────────────────

interface ChartRow {
  label: string;
  winRatePct: number;       // 0–100 for left Y-axis
  expectancy: number;       // $ for right Y-axis
  winRateTrend: number;     // regression line, left Y-axis
  expectancyTrend: number;  // regression line, right Y-axis
  aboveAvgWinRate: boolean;
}

function buildChartRows(windows: WindowMetrics[]): ChartRow[] {
  const winRatePcts  = windows.map((w) => w.winRate * 100);
  const expectancies = windows.map((w) => w.expectancy);
  const avgWinRate   = winRatePcts.reduce((a, v) => a + v, 0) / winRatePcts.length;
  const wrTrend      = trendLine(winRatePcts);
  const exTrend      = trendLine(expectancies);

  return windows.map((w, i) => ({
    label:            windowLabel(w.windowStart, w.windowEnd),
    winRatePct:       winRatePcts[i],
    expectancy:       w.expectancy,
    winRateTrend:     wrTrend[i],
    expectancyTrend:  exTrend[i],
    aboveAvgWinRate:  winRatePcts[i] >= avgWinRate,
  }));
}

// ── Recharts style atoms ──────────────────────────────────────────────────────

const axisStyle = {
  tick:     { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false as const,
};

function CustomTooltip({ active, label, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#161b22', border: '1px solid #30363d',
      borderRadius: 6, padding: '8px 12px', fontSize: 12, lineHeight: 1.8,
    }}>
      <div style={{ color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload
        .filter((e: any) => !e.name.includes('Trend'))
        .map((e: any) => (
          <div key={e.dataKey} style={{ color: e.color }}>
            {e.name}:{' '}
            <span style={{ color: '#e6edf3' }}>
              {e.dataKey === 'winRatePct'
                ? e.value.toFixed(1) + '%'
                : fmtDollar(e.value)}
            </span>
          </div>
        ))}
    </div>
  );
}

// ── Window detail table ───────────────────────────────────────────────────────

function WindowTable({ windows }: { windows: WindowMetrics[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-[#21262d]">
            {['Window', 'Trades', 'Win Rate', 'Expectancy', 'Profit Factor', 'Total P&L', 'Sortino'].map(
              (h) => (
                <th
                  key={h}
                  className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-[#6e7681] font-medium whitespace-nowrap"
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {windows.map((w, i) => {
            const isPositive = w.expectancy >= 0;
            const rowBg      = isPositive
              ? 'bg-green-500/5 hover:bg-green-500/10'
              : 'bg-red-500/5 hover:bg-red-500/10';
            const pnlColor   = isPositive ? 'text-green-400' : 'text-red-400';
            const sortinoColor =
              w.sortino >= 1 ? 'text-green-400' : w.sortino >= 0.5 ? 'text-amber-400' : 'text-red-400';
            return (
              <tr key={i} className={`border-b border-[#21262d]/50 transition-colors ${rowBg}`}>
                <td className="px-3 py-2 font-medium text-[#e6edf3] whitespace-nowrap">
                  {windowLabel(w.windowStart, w.windowEnd)}
                </td>
                <td className="px-3 py-2 text-[#8b949e] tabular-nums">{w.tradeCount}</td>
                <td className="px-3 py-2 tabular-nums text-[#e6edf3]">{fmtPct(w.winRate)}</td>
                <td className={`px-3 py-2 tabular-nums font-medium ${pnlColor}`}>
                  {fmtDollar(w.expectancy)}
                </td>
                <td className="px-3 py-2 tabular-nums text-[#8b949e]">{fmtPf(w.profitFactor)}</td>
                <td className={`px-3 py-2 tabular-nums font-medium ${pnlColor}`}>
                  {fmtDollar(w.totalPnl)}
                </td>
                <td className={`px-3 py-2 tabular-nums font-medium ${sortinoColor}`}>
                  {w.sortino.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface WalkForwardChartProps {
  journalId?: string;
}

export default function WalkForwardChart({ journalId }: WalkForwardChartProps) {
  const authFetch = useAuthFetch();
  const [data, setData]       = useState<WalkForwardResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!journalId) return;
    setLoading(true);
    setData(null);
    setError(null);

    authFetch(`/api/analytics/walk-forward?journalId=${encodeURIComponent(journalId)}`)
      .then((r) => r.json())
      .then((d: any) => {
        if (d.error) setError(d.error as string);
        else setData(d as WalkForwardResult);
      })
      .catch(() => setError('Failed to load Edge Persistence analysis.'))
      .finally(() => setLoading(false));
  }, [journalId, authFetch]);

  // ── Loading ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6">
        <div className="h-5 w-56 bg-[#21262d] rounded animate-pulse mb-4" />
        <div className="h-48 bg-[#0d1117] rounded animate-pulse" />
      </div>
    );
  }

  // ── Insufficient data / error ────────────────────────────────────────────
  if (error) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6">
        <h2 className="text-sm font-semibold text-white mb-1">Edge Persistence</h2>
        <p className="text-xs text-[#6e7681]">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  // ── Chart data ──────────────────────────────────────────────────────────
  const chartRows  = buildChartRows(data.windows);
  const numWindows = data.windows.length;
  const compareN   = numWindows >= 4 ? 2 : 1;

  // Degradation percentage for the warning card
  const firstAvg =
    data.windows.slice(0, compareN).reduce((a, w) => a + w.expectancy, 0) / compareN;
  const lastAvg  =
    data.windows.slice(-compareN).reduce((a, w) => a + w.expectancy, 0) / compareN;
  const degradePct =
    firstAvg !== 0
      ? Math.round(Math.abs((lastAvg - firstAvg) / Math.abs(firstAvg)) * 100)
      : null;

  // Y-axis domain padding
  const winRates  = chartRows.map((r) => r.winRatePct);
  const wrMin     = Math.max(0,   Math.min(...winRates) - 5);
  const wrMax     = Math.min(100, Math.max(...winRates) + 5);

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
      {/* ── Header banner ─────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-[#21262d]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Edge Persistence</h2>
            <p className="text-xs text-[#6e7681] mt-0.5">
              Performance stability across 6 time windows
            </p>
          </div>
          {/* Trend indicators */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-[#6e7681]">Win Rate</div>
              <div className={`text-sm font-semibold ${trendColor(data.winRateTrend)}`}>
                {trendIcon(data.winRateTrend)} {data.winRateTrend}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-[#6e7681]">Expectancy</div>
              <div className={`text-sm font-semibold ${trendColor(data.expectancyTrend)}`}>
                {trendIcon(data.expectancyTrend)} {data.expectancyTrend}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-[#6e7681]">Edge</div>
              <div className={`text-sm font-semibold ${
                data.degradationDetected ? 'text-red-400' :
                data.edgePersistent ? 'text-green-400' : 'text-amber-400'
              }`}>
                {data.degradationDetected ? '⚠ Declining' :
                 data.edgePersistent      ? '✓ Persistent' : '~ Uncertain'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 py-4 space-y-5">
        {/* ── ComposedChart ──────────────────────────────────────────────── */}
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartRows} margin={{ top: 4, right: 60, left: 8, bottom: 4 }}>
            <CartesianGrid stroke="#21262d" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" {...axisStyle} />

            {/* Left Y-axis: win rate (%) */}
            <YAxis
              yAxisId="left"
              {...axisStyle}
              domain={[wrMin, wrMax]}
              tickFormatter={(v: number) => v.toFixed(0) + '%'}
              width={40}
            />

            {/* Right Y-axis: expectancy ($) */}
            <YAxis
              yAxisId="right"
              orientation="right"
              {...axisStyle}
              tickFormatter={(v: number) =>
                v === 0 ? '$0' : `${v >= 0 ? '+' : '-'}$${Math.abs(Math.round(v))}`
              }
              width={56}
            />

            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine yAxisId="right" y={0} stroke="#30363d" strokeDasharray="4 2" />

            {/* Win rate bars, colored vs overall average */}
            <Bar yAxisId="left" dataKey="winRatePct" name="Win Rate" maxBarSize={48}>
              {chartRows.map((row, i) => (
                <Cell
                  key={i}
                  fill={row.aboveAvgWinRate ? '#22c55e' : '#ef4444'}
                  fillOpacity={0.65}
                />
              ))}
            </Bar>

            {/* Expectancy line */}
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="expectancy"
              name="Expectancy"
              stroke="#34d399"
              strokeWidth={2}
              dot={{ r: 3, fill: '#34d399' }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />

            {/* Win rate trend (dashed) */}
            <Line
              yAxisId="left"
              type="linear"
              dataKey="winRateTrend"
              name="Win Rate Trend"
              stroke="#60a5fa"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
              legendType="none"
            />

            {/* Expectancy trend (dashed) */}
            <Line
              yAxisId="right"
              type="linear"
              dataKey="expectancyTrend"
              name="Expectancy Trend"
              stroke="#6ee7b7"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
              legendType="none"
            />

            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(value) => <span style={{ color: '#8b949e' }}>{value}</span>}
            />
          </ComposedChart>
        </ResponsiveContainer>

        {/* ── Window detail table ────────────────────────────────────────── */}
        <WindowTable windows={data.windows} />

        {/* ── Summary section ───────────────────────────────────────────── */}
        <div className="space-y-3 border-t border-[#21262d] pt-4">
          <p className="text-xs text-[#8b949e] leading-relaxed">{data.summary}</p>

          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-[#6e7681]">Best period:</span>
              <span className="text-xs font-medium text-green-400">{data.bestWindow.label}</span>
              <span className="text-xs text-[#8b949e]">with {fmtDollar(data.bestWindow.expectancy)} expectancy</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-[#6e7681]">Worst period:</span>
              <span className="text-xs font-medium text-red-400">{data.worstWindow.label}</span>
              <span className="text-xs text-[#8b949e]">with {fmtDollar(data.worstWindow.expectancy)} expectancy</span>
            </div>
          </div>

          {/* Degradation warning card */}
          {data.degradationDetected && (
            <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg px-4 py-3">
              <div className="flex items-start gap-2">
                <span className="text-amber-400 text-base leading-none mt-0.5">⚠</span>
                <div>
                  <p className="text-xs font-semibold text-amber-300 mb-0.5">
                    Performance degradation detected
                  </p>
                  <p className="text-xs text-amber-400/80 leading-relaxed">
                    Your recent trades underperform your historical edge
                    {degradePct != null ? ` by ${degradePct}%` : ''}.
                    Review your strategy for changes in market conditions or execution.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
