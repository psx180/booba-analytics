'use client';

import { useState, useEffect } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { useAuthFetch } from '@/lib/api-client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PercentileBand {
  tradeNumber: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

interface MonteCarloData {
  probDrawdown25: number;
  probDrawdown50: number;
  probRuin: number;
  medianFinalBalance: number;
  p10FinalBalance: number;
  p90FinalBalance: number;
  meanFinalBalance: number;
  equityCurves: number[][];
  percentileBands: PercentileBand[];
  initialBalance: number;
  inputWinRate: number;
  inputAvgWinPct: number;   // average % return on winning trades
  inputAvgLossPct: number;  // average % return on losing trades (negative)
  inputTradeCount: number;
}

export interface MonteCarloChartProps {
  journalId: string | undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function riskColor(prob: number): string {
  if (prob < 0.10) return 'text-green-400';
  if (prob < 0.30) return 'text-yellow-400';
  if (prob < 0.50) return 'text-orange-400';
  return 'text-red-400';
}

function fmtPct(n: number, decimals = 1): string {
  return (n * 100).toFixed(decimals) + '%';
}

function fmtDollar(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtChange(balance: number, initial: number): string {
  const pct = ((balance - initial) / initial) * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RiskRow({
  label, value, colorClass,
}: {
  label: string;
  value: number;
  colorClass: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-[#8b949e]">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${colorClass}`}>
        {fmtPct(value)}
      </span>
    </div>
  );
}

function OutcomeRow({
  label, balance, initial,
}: {
  label: string;
  balance: number;
  initial: number;
}) {
  const isPositive = balance >= initial;
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-[#8b949e]">{label}</span>
      <span className="text-xs tabular-nums text-white">
        {fmtDollar(balance)}{' '}
        <span className={isPositive ? 'text-green-400' : 'text-red-400'}>
          ({fmtChange(balance, initial)})
        </span>
      </span>
    </div>
  );
}

// ── Chart ─────────────────────────────────────────────────────────────────────

const axisProps = {
  tick: { fill: '#6e7681', fontSize: 11 },
  axisLine: { stroke: '#21262d' },
  tickLine: false,
};

function FanChart({
  percentileBands,
  initialBalance,
}: {
  percentileBands: PercentileBand[];
  initialBalance: number;
}) {
  // Shift the entire coordinate space so 0 = the chart's bottom edge.
  // This prevents recharts from pulling the Y-axis down to absolute $0 —
  // the stacked areas will start at 0 in chart-space, which equals yBase in dollars.
  const minP5  = Math.min(...percentileBands.map((b) => b.p5));
  const maxP95 = Math.max(...percentileBands.map((b) => b.p95));
  const yBase  = minP5  * 0.9;   // bottom of chart in absolute dollars
  const yTop   = maxP95 * 1.1 - yBase;  // domain ceiling in chart-space units

  // All data values are relative to yBase; the median Line and ReferenceLine match.
  const fanData = percentileBands.map((b) => ({
    trade:     b.tradeNumber,
    floor:     Math.max(0, b.p5  - yBase),   // tiny gap from chart bottom to p5
    outerLow:  Math.max(0, b.p25 - b.p5),    // p5  → p25
    innerBand: Math.max(0, b.p75 - b.p25),   // p25 → p75
    outerHigh: Math.max(0, b.p95 - b.p75),   // p75 → p95
    median:    b.p50 - yBase,                 // relative median for the Line
  }));

  const bandByTrade = new Map(percentileBands.map((b) => [b.tradeNumber, b]));
  const refY = initialBalance - yBase;  // reference line in chart-space (hidden if < 0)

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={fanData} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
        <CartesianGrid stroke="#21262d" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="trade"
          {...axisProps}
          label={{ value: 'Trade', position: 'insideBottom', offset: -8, fill: '#6e7681', fontSize: 10 }}
        />
        <YAxis
          {...axisProps}
          type="number"
          domain={[0, yTop]}
          tickFormatter={(v: number) => `$${((v + yBase) / 1000).toFixed(0)}k`}
          width={52}
        />
        <Tooltip
          content={({ active, label }) => {
            if (!active || label == null) return null;
            const b = bandByTrade.get(Number(label));
            if (!b) return null;
            return (
              <div style={{
                background: '#161b22',
                border: '1px solid #30363d',
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 12,
                lineHeight: 1.6,
              }}>
                <div style={{ color: '#e6edf3', marginBottom: 4, fontWeight: 600 }}>
                  Trade {label}
                </div>
                <div style={{ color: '#6e7681' }}>p95  <span style={{ color: '#e6edf3' }}>{fmtDollar(b.p95)}</span></div>
                <div style={{ color: '#6e7681' }}>p75  <span style={{ color: '#e6edf3' }}>{fmtDollar(b.p75)}</span></div>
                <div style={{ color: '#60a5fa', fontWeight: 600 }}>p50  {fmtDollar(b.p50)}</div>
                <div style={{ color: '#6e7681' }}>p25  <span style={{ color: '#e6edf3' }}>{fmtDollar(b.p25)}</span></div>
                <div style={{ color: '#6e7681' }}>p5   <span style={{ color: '#e6edf3' }}>{fmtDollar(b.p5)}</span></div>
              </div>
            );
          }}
        />

        {/* Stacked fan bands in chart-relative coordinates.
            floor keeps the bands starting at p5, not at the chart bottom. */}
        <Area
          type="monotone" stackId="fan" dataKey="floor"
          fill="transparent" fillOpacity={0} stroke="none" strokeWidth={0}
          isAnimationActive={false} legendType="none"
        />
        <Area
          type="monotone" stackId="fan" dataKey="outerLow"
          fill="rgba(96,165,250,0.13)" stroke="none" strokeWidth={0}
          isAnimationActive={false} legendType="none"
        />
        <Area
          type="monotone" stackId="fan" dataKey="innerBand"
          fill="rgba(96,165,250,0.30)" stroke="none" strokeWidth={0}
          isAnimationActive={false} legendType="none"
        />
        <Area
          type="monotone" stackId="fan" dataKey="outerHigh"
          fill="rgba(96,165,250,0.13)" stroke="none" strokeWidth={0}
          isAnimationActive={false} legendType="none"
        />

        {/* Median line — also in chart-relative coords */}
        <Line
          type="monotone" dataKey="median"
          stroke="#60a5fa" strokeWidth={2}
          dot={false} activeDot={false}
          isAnimationActive={false} legendType="none"
        />

        {/* Break-even reference — only render when initial balance is in view */}
        {refY >= 0 && (
          <ReferenceLine
            y={refY}
            stroke="#4b5563"
            strokeDasharray="5 3"
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MonteCarloChart({ journalId }: MonteCarloChartProps) {
  const authFetch = useAuthFetch();
  const [data, setData]       = useState<MonteCarloData | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!journalId) return;
    setLoading(true);
    setData(null);
    setError(null);

    authFetch(`/api/analytics/monte-carlo?journalId=${encodeURIComponent(journalId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error as string);
        else setData(d as MonteCarloData);
      })
      .catch(() => setError('Failed to run Monte Carlo simulation.'))
      .finally(() => setLoading(false));
  }, [journalId, authFetch]);

  if (loading) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6 text-center">
        <p className="text-xs text-[#6e7681] animate-pulse">Running Monte Carlo simulation…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-5 text-center">
        <p className="text-xs text-[#6e7681]">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { initialBalance } = data;

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#21262d]">
        <h2 className="text-sm font-semibold text-white">Risk of Ruin</h2>
        <p className="text-xs text-[#6e7681] mt-0.5">
          Monte Carlo simulation · 10,000 paths × 100 trades
        </p>
      </div>

      <div className="px-4 py-4 space-y-5">
        {/* Summary: drawdown probabilities + outcome distribution */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
          {/* Drawdown probabilities */}
          <div className="space-y-2.5">
            <p className="text-[10px] uppercase tracking-widest text-[#6e7681]">Drawdown risk</p>
            <RiskRow
              label="25% drawdown probability"
              value={data.probDrawdown25}
              colorClass={riskColor(data.probDrawdown25)}
            />
            <RiskRow
              label="50% drawdown probability"
              value={data.probDrawdown50}
              colorClass={riskColor(data.probDrawdown50)}
            />
            <RiskRow
              label="Total ruin probability"
              value={data.probRuin}
              colorClass={riskColor(data.probRuin)}
            />
          </div>

          {/* Outcome distribution */}
          <div className="space-y-2.5">
            <p className="text-[10px] uppercase tracking-widest text-[#6e7681]">Outcome distribution</p>
            <OutcomeRow label="Good case (90th %ile)"  balance={data.p90FinalBalance}    initial={initialBalance} />
            <OutcomeRow label="Median outcome"         balance={data.medianFinalBalance} initial={initialBalance} />
            <OutcomeRow label="Bad case (10th %ile)"   balance={data.p10FinalBalance}    initial={initialBalance} />
          </div>
        </div>

        {/* Fan chart */}
        <div>
          <FanChart percentileBands={data.percentileBands} initialBalance={initialBalance} />

          {/* Legend */}
          <div className="flex items-center gap-5 mt-1 px-1">
            <span className="flex items-center gap-1.5">
              <span className="block w-5 h-3 rounded" style={{ background: 'rgba(96,165,250,0.13)' }} />
              <span className="text-[10px] text-[#6e7681]">p5–p95</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="block w-5 h-3 rounded" style={{ background: 'rgba(96,165,250,0.30)' }} />
              <span className="text-[10px] text-[#6e7681]">p25–p75</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="block h-0.5 w-5 rounded" style={{ background: '#60a5fa' }} />
              <span className="text-[10px] text-[#6e7681]">Median</span>
            </span>
          </div>
        </div>

        {/* Explanatory text */}
        <p className="text-[11px] text-[#6e7681] leading-relaxed">
          Based on your actual win rate ({fmtPct(data.inputWinRate, 1)}),
          average win (+{data.inputAvgWinPct.toFixed(2)}% of notional),
          and average loss ({data.inputAvgLossPct.toFixed(2)}% of notional)
          over {data.inputTradeCount} trades. Simulated forward 100 trades, 10,000 times.
          Starting balance of $10,000 is a normalized reference point — outcomes scale proportionally.
        </p>
      </div>
    </div>
  );
}
