'use client';

import { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { useAuthFetch } from '@/lib/api-client';
import { REGIME_LABELS } from '../types';
import type { WhatIfCurvesResult, EquityPoint } from '@/services/analytics/what-if-curves';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChartRow {
  date: string;
  actual: number;
  optimalExit?: number;
  optimalSizing?: number;
  noLosingRegime?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDelta(v: number | null): string {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtDollar(v: number): string {
  return '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(0) + '%';
}

function deltaColor(v: number | null): string {
  if (v == null) return 'text-[#6e7681]';
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

function regimeLabel(regime: string | null): string {
  if (!regime) return 'Unknown';
  return REGIME_LABELS[regime] ?? regime;
}

/** Merge the four equity curves into a unified date-keyed series for recharts. */
function mergeCurves(data: WhatIfCurvesResult): ChartRow[] {
  // Collect all unique dates across all curves present.
  const dateSet = new Set<string>();
  for (const pt of data.actualCurve) dateSet.add(pt.date);
  if (data.optimalExitCurve) for (const pt of data.optimalExitCurve) dateSet.add(pt.date);
  if (data.optimalSizingCurve) for (const pt of data.optimalSizingCurve) dateSet.add(pt.date);
  if (data.noLosingRegimeCurve) for (const pt of data.noLosingRegimeCurve) dateSet.add(pt.date);

  const dates = Array.from(dateSet).sort();

  // Build lookup maps for fast access.
  const toMap = (curve: EquityPoint[] | null): Map<string, number> => {
    const m = new Map<string, number>();
    if (curve) for (const pt of curve) m.set(pt.date, pt.balance);
    return m;
  };

  const actualMap = toMap(data.actualCurve);
  const exitMap   = toMap(data.optimalExitCurve);
  const sizeMap   = toMap(data.optimalSizingCurve);
  const regimeMap = toMap(data.noLosingRegimeCurve);

  // Forward-fill so the lines don't have gaps between trades.
  let lastActual = 0, lastExit = 0, lastSize = 0, lastRegime = 0;
  return dates.map((date) => {
    if (actualMap.has(date)) lastActual = actualMap.get(date)!;
    if (exitMap.has(date))   lastExit   = exitMap.get(date)!;
    if (sizeMap.has(date))   lastSize   = sizeMap.get(date)!;
    if (regimeMap.has(date)) lastRegime = regimeMap.get(date)!;

    const row: ChartRow = { date, actual: lastActual };
    if (data.optimalExitCurve)    row.optimalExit    = lastExit;
    if (data.optimalSizingCurve)  row.optimalSizing  = lastSize;
    if (data.noLosingRegimeCurve) row.noLosingRegime = lastRegime;
    return row;
  });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SummaryCard({
  title, subtitle, delta, unavailable,
}: {
  title: string;
  subtitle: string;
  delta: number | null;
  unavailable?: boolean;
}) {
  return (
    <div className="flex-1 min-w-0 bg-[#0d1117] border border-[#21262d] rounded-lg px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#6e7681] mb-1">
        {title}
      </div>
      {unavailable ? (
        <div className="text-xs text-[#6e7681]">Not enough data</div>
      ) : (
        <>
          <div className={`text-lg font-bold tabular-nums ${deltaColor(delta)}`}>
            {fmtDelta(delta)}
          </div>
          <div className="text-xs text-[#6e7681] mt-0.5 leading-tight">{subtitle}</div>
        </>
      )}
    </div>
  );
}

// ── Chart axis / tooltip ──────────────────────────────────────────────────────

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

function CustomTooltip({ active, label, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#161b22',
      border: '1px solid #30363d',
      borderRadius: 6,
      padding: '8px 12px',
      fontSize: 12,
      lineHeight: 1.7,
    }}>
      <div style={{ color: '#e6edf3', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} style={{ color: entry.color }}>
          {entry.name}: <span style={{ color: '#e6edf3' }}>
            {entry.value >= 0 ? '+' : ''}{fmtDollar(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface WhatIfChartProps {
  journalId?: string;
}

export default function WhatIfChart({ journalId }: WhatIfChartProps) {
  const authFetch = useAuthFetch();
  const [data, setData]       = useState<WhatIfCurvesResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!journalId) return;
    setLoading(true);
    setData(null);
    setError(null);

    authFetch(`/api/analytics/what-if-analysis?journalId=${encodeURIComponent(journalId)}`)
      .then((r) => r.json())
      .then((d: any) => {
        if (d.error) setError(d.error as string);
        else setData(d as WhatIfCurvesResult);
      })
      .catch(() => setError('Failed to load what-if analysis.'))
      .finally(() => setLoading(false));
  }, [journalId, authFetch]);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6">
        <div className="h-5 w-40 bg-[#21262d] rounded animate-pulse mb-4" />
        <div className="h-48 bg-[#0d1117] rounded animate-pulse" />
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6">
        <h2 className="text-sm font-semibold text-white mb-1">What If Analysis</h2>
        <p className="text-xs text-[#6e7681]">{error}</p>
      </div>
    );
  }

  // ── Insufficient data ─────────────────────────────────────────────────────
  if (!data || data.tradeCount < 10 || data.mfeTradeCount < 10) {
    const count = data?.mfeTradeCount ?? 0;
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6">
        <h2 className="text-sm font-semibold text-white mb-1">What If Analysis</h2>
        <p className="text-xs text-[#6e7681]">
          {count > 0
            ? `What-if analysis requires at least 10 trades with exit data (${count} found). Run deep analysis on the Exits tab to compute MFE/MAE.`
            : 'What-if analysis requires at least 10 trades with exit data. Run deep analysis on the Exits tab to compute MFE/MAE.'}
        </p>
      </div>
    );
  }

  const chartRows = mergeCurves(data);

  // Compute sensible Y domain with a small padding.
  const allValues = chartRows.flatMap((r) =>
    [r.actual, r.optimalExit, r.optimalSizing, r.noLosingRegime].filter((v): v is number => v != null),
  );
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const pad = (maxVal - minVal) * 0.08 || 100;
  const yDomain: [number, number] = [minVal - pad, maxVal + pad];

  // Thin out x-axis labels so they don't overlap.
  const tickEvery = Math.ceil(chartRows.length / 8);

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#21262d]">
        <h2 className="text-sm font-semibold text-white">What If Analysis</h2>
        <p className="text-xs text-[#6e7681] mt-0.5">
          How would your P&L curve look under different trading decisions?
        </p>
      </div>

      <div className="px-4 py-4 space-y-5">
        {/* Summary cards */}
        <div className="flex gap-3">
          <SummaryCard
            title="Optimal Exits"
            subtitle="Exit at MFE each trade"
            delta={data.exitMoneyLeftOnTable}
            unavailable={data.optimalExitCurve == null}
          />
          <SummaryCard
            title="Consistent Sizing"
            subtitle="Use median position size"
            delta={data.sizingImprovement}
            unavailable={data.optimalSizingCurve == null}
          />
          <SummaryCard
            title={`Skip ${regimeLabel(data.worstRegime)} Regime`}
            subtitle={`Remove worst-regime trades`}
            delta={data.regimeFilterImprovement}
            unavailable={data.noLosingRegimeCurve == null}
          />
        </div>

        {/* Overlay chart */}
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartRows} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
            <CartesianGrid stroke="#21262d" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              {...axisProps}
              interval={tickEvery - 1}
              tick={{ fill: '#6e7681', fontSize: 10 }}
            />
            <YAxis
              {...axisProps}
              domain={yDomain}
              tickFormatter={(v: number) =>
                v === 0 ? '$0' : `${v >= 0 ? '+' : '-'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`
              }
              width={72}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#30363d" strokeDasharray="4 2" />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(value) => <span style={{ color: '#8b949e' }}>{value}</span>}
            />

            {/* Actual — solid, thicker, most prominent */}
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke="#ef4444"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, fill: '#ef4444' }}
              isAnimationActive={false}
            />

            {/* Optimal exits — green dashed */}
            {data.optimalExitCurve && (
              <Line
                type="monotone"
                dataKey="optimalExit"
                name="Optimal Exits"
                stroke="#22c55e"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                activeDot={{ r: 3, fill: '#22c55e' }}
                isAnimationActive={false}
              />
            )}

            {/* Optimal sizing — blue dashed */}
            {data.optimalSizingCurve && (
              <Line
                type="monotone"
                dataKey="optimalSizing"
                name="Consistent Sizing"
                stroke="#60a5fa"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                activeDot={{ r: 3, fill: '#60a5fa' }}
                isAnimationActive={false}
              />
            )}

            {/* No losing regime — orange dashed */}
            {data.noLosingRegimeCurve && (
              <Line
                type="monotone"
                dataKey="noLosingRegime"
                name={`Skip ${regimeLabel(data.worstRegime)}`}
                stroke="#f97316"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                activeDot={{ r: 3, fill: '#f97316' }}
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>

        {/* Explanatory text */}
        <div className="space-y-2 border-t border-[#21262d] pt-4">
          {data.optimalExitCurve && (
            <p className="text-xs text-[#8b949e] leading-relaxed">
              <span className="text-green-400 font-medium">Optimal Exits:</span>{' '}
              If you had exited every trade at its best price (MFE), you would have earned{' '}
              <span className={deltaColor(data.exitMoneyLeftOnTable)}>
                {fmtDelta(data.exitMoneyLeftOnTable)}
              </span>{' '}
              {(data.exitMoneyLeftOnTable ?? 0) >= 0 ? 'more' : 'less'}.
              {data.avgExitEfficiency != null && (
                <> Your average exit captures {fmtPct(data.avgExitEfficiency)} of available profit.</>
              )}
            </p>
          )}

          {data.optimalSizingCurve && data.medianSize != null && (
            <p className="text-xs text-[#8b949e] leading-relaxed">
              <span className="text-blue-400 font-medium">Consistent Sizing:</span>{' '}
              If you had used your median position size ({fmtDollar(data.medianSize)}) on every trade
              instead of varying between {fmtDollar(data.minSize ?? 0)} and {fmtDollar(data.maxSize ?? 0)},
              you would have earned{' '}
              <span className={deltaColor(data.sizingImprovement)}>
                {fmtDelta(data.sizingImprovement)}
              </span>{' '}
              {(data.sizingImprovement ?? 0) >= 0 ? 'more' : 'less'}.
            </p>
          )}

          {data.noLosingRegimeCurve && data.worstRegime != null && (
            <p className="text-xs text-[#8b949e] leading-relaxed">
              <span className="text-orange-400 font-medium">Regime Filter:</span>{' '}
              If you had avoided trading in the {regimeLabel(data.worstRegime)} regime (your worst regime
              by P&L), you would have saved{' '}
              <span className={deltaColor(data.regimeFilterImprovement)}>
                {fmtDelta(data.regimeFilterImprovement)}
              </span>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
