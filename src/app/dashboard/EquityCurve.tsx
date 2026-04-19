'use client';

import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts';
import { useMemo } from 'react';

export interface EquityPoint {
  date: string;
  cumulativePnl: number;
  /** Absolute account equity at this point. Populated by the snapshot-twr provider. */
  value?: number;
}

export type ChartMode = 'pnl' | 'equity';

export interface XpnlOverlayPoint {
  date: string;
  actualCumPnl: number;
  xpnlCumPnl: number;
}

// Regime bands extracted from the equity curve data for background shading.
// We need the regime timeline separately — this comes from /api/analytics/regime-breakdown
// For the overlay we use the trades' regimeAtEntry and group consecutive trades with the same regime.
export interface TradeMeta {
  date: string;
  regimeAtEntry: string | null;
}

interface RegimeBand {
  x1: string;
  x2: string;
  regime: string;
}

const REGIME_COLORS: Record<string, string> = {
  trending_low_vol: '#16a34a22',
  trending_high_vol: '#16a34a33',
  ranging_low_vol: '#d9770622',
  ranging_high_vol: '#d9770633',
  transitional: '#6b728015',
  unknown: '#6b728010',
};

const REGIME_LABELS: Record<string, string> = {
  trending_low_vol: 'Trending / Low Vol',
  trending_high_vol: 'Trending / High Vol',
  ranging_low_vol: 'Ranging / Low Vol',
  ranging_high_vol: 'Ranging / High Vol',
  transitional: 'Transitional',
};

function buildRegimeBands(trades: TradeMeta[]): RegimeBand[] {
  if (trades.length < 2) return [];
  const bands: RegimeBand[] = [];
  let start = 0;
  for (let i = 1; i < trades.length; i++) {
    const currentRegime = trades[i].regimeAtEntry ?? 'unknown';
    const prevRegime = trades[i - 1].regimeAtEntry ?? 'unknown';
    if (currentRegime !== prevRegime || i === trades.length - 1) {
      bands.push({
        x1: trades[start].date,
        x2: trades[i === trades.length - 1 ? i : i - 1].date,
        regime: prevRegime,
      });
      start = i;
    }
  }
  return bands;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatPnl(value: number) {
  return `$${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

interface Props {
  equityCurve: EquityPoint[];
  tradeMetas: TradeMeta[];
  activeRegimeFilter: string | null;
  /** Optional dual-curve overlay: actual vs expected P&L. Ignored when chartMode='equity'. */
  xpnlSeries?: XpnlOverlayPoint[];
  showXpnl?: boolean;
  /**
   * What the main line represents. 'pnl' plots cumulativePnl starting at 0
   * (legacy behavior). 'equity' plots the absolute account equity from
   * `point.value` — used by the snapshot-twr provider. xPnL overlay is
   * suppressed in 'equity' mode because the two series live on different
   * scales; the dashboard renders a separate PnlComparison chart instead.
   */
  chartMode?: ChartMode;
}

export default function EquityCurve({
  equityCurve,
  tradeMetas,
  activeRegimeFilter,
  xpnlSeries,
  showXpnl,
  chartMode = 'pnl',
}: Props) {
  const isEquityMode = chartMode === 'equity';
  const yKey = isEquityMode ? 'value' : 'cumulativePnl';
  const yLabel = isEquityMode ? 'Equity' : 'Cum P&L';
  const regimeBands = useMemo(() => buildRegimeBands(tradeMetas), [tradeMetas]);

  // Merge xPnL into equity curve points by index. xPnL is computed from the
  // same set of closed positions ordered by exit time, so positional index
  // matching is safe — same trade lives at the same position in both arrays.
  // xPnL is suppressed in equity mode because the two series are on different
  // scales (account equity vs cumulative P&L); the dashboard stacks a
  // PnlComparison chart below for that comparison.
  const merged = useMemo(() => {
    const xpnlActive = showXpnl && !isEquityMode && xpnlSeries && xpnlSeries.length > 0;
    if (!xpnlActive) {
      return equityCurve.map((p, i) => ({
        ...p,
        xpnlCumPnl: null as number | null,
        gapPositive: null as number | null,
        gapNegative: null as number | null,
        tradeCount: i + 1,
        regimeAtEntry: tradeMetas[i]?.regimeAtEntry ?? null,
      }));
    }
    return equityCurve.map((p, i) => {
      const x = xpnlSeries![i];
      const xCum = x ? x.xpnlCumPnl : null;
      const gap = xCum != null ? p.cumulativePnl - xCum : 0;
      return {
        ...p,
        xpnlCumPnl: xCum,
        // Two parallel area bands so recharts paints green where actual > xPnL
        // and red where actual < xPnL. We anchor the band at xPnL and stack the
        // signed gap on top.
        gapPositive: xCum != null && gap >= 0 ? gap : 0,
        gapNegative: xCum != null && gap <  0 ? gap : 0,
        bandBase: xCum,
        tradeCount: i + 1,
        regimeAtEntry: tradeMetas[i]?.regimeAtEntry ?? null,
      };
    });
  }, [equityCurve, xpnlSeries, showXpnl, tradeMetas, isEquityMode]);

  // In equity mode we want the line green regardless — equity being positive
  // is always "good". In P&L mode it reflects net gain/loss sign.
  const isPositive = isEquityMode
    ? true
    : equityCurve.length > 0 && equityCurve[equityCurve.length - 1].cumulativePnl >= 0;

  if (equityCurve.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6e7681] text-sm">
        No trades yet — equity curve will appear here.
      </div>
    );
  }

  const lineColor = isPositive ? '#22c55e' : '#ef4444';
  const gradientId = 'equityGradient';

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload as EquityPoint & {
      xpnlCumPnl?: number | null;
      tradeCount?: number;
      regimeAtEntry?: string | null;
    };
    const shownValue = isEquityMode ? (point.value ?? point.cumulativePnl) : point.cumulativePnl;
    const pnl = point.cumulativePnl;
    const xpnl = point.xpnlCumPnl;
    const regime = point.regimeAtEntry;
    const valueColorClass = isEquityMode
      ? 'text-white'
      : shownValue >= 0
        ? 'text-green-400'
        : 'text-red-400';
    return (
      <div className="bg-[#1c2128] border border-[#30363d] rounded px-3 py-2 text-xs space-y-0.5">
        <div className="text-[#8b949e]">{formatDate(point.date)}</div>
        {point.tradeCount != null && (
          <div className="text-[#6e7681]">Trade #{point.tradeCount}</div>
        )}
        <div className={valueColorClass}>
          {yLabel} {isEquityMode
            ? `$${shownValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : formatPnl(shownValue)}
        </div>
        {xpnl != null && !isEquityMode && (
          <div className="text-slate-400">
            xPnL {formatPnl(xpnl)}
            <span className="ml-2 text-[#6e7681]">
              ({pnl - xpnl >= 0 ? '+' : ''}{(pnl - xpnl).toFixed(2)})
            </span>
          </div>
        )}
        {regime && regime !== 'unknown' && (
          <div className="text-[#6e7681]">{REGIME_LABELS[regime] ?? regime}</div>
        )}
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={merged} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={lineColor} stopOpacity={0.15} />
            <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
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

        {/* Regime background bands */}
        {!activeRegimeFilter &&
          regimeBands.map((band, i) => (
            <ReferenceArea
              key={i}
              x1={band.x1}
              x2={band.x2}
              fill={REGIME_COLORS[band.regime] ?? '#6b728010'}
              strokeOpacity={0}
              ifOverflow="extendDomain"
            />
          ))}

        <Area
          type="monotone"
          dataKey={yKey}
          stroke={lineColor}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 4, fill: lineColor, strokeWidth: 0 }}
        />

        {/* xPnL overlay — dashed gray line for the expected curve. */}
        {showXpnl && !isEquityMode && xpnlSeries && xpnlSeries.length > 0 && (
          <Line
            type="monotone"
            dataKey="xpnlCumPnl"
            stroke="#94a3b8"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export { REGIME_LABELS };
