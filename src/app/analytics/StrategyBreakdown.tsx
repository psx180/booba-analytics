'use client';

import { useState, useEffect, useMemo } from 'react';
import type { AnalyticsChartProps, PositionData } from './types';
import { buildParams, ALL_REGIMES, REGIME_LABELS, REGIME_COLORS, computeStats } from './types';

function fmtHoldTime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function RegimeMiniBar({ tradePositions }: { tradePositions: PositionData[] }) {
  const bars = ALL_REGIMES.map((regime) => {
    const sub = tradePositions.filter((p) => p.regimeAtEntry === regime);
    if (sub.length === 0) return null;
    const stats = computeStats(sub);
    return { regime, winRate: stats.winRate, tradeCount: sub.length };
  }).filter(Boolean) as { regime: string; winRate: number; tradeCount: number }[];

  if (bars.length === 0) return <span className="text-[#6e7681] text-xs">—</span>;

  return (
    <div className="flex gap-1 items-center">
      {bars.map(({ regime, winRate, tradeCount }) => (
        <div
          key={regime}
          title={`${REGIME_LABELS[regime]}: ${(winRate * 100).toFixed(0)}% win (${tradeCount} trades)`}
          className="flex flex-col items-center gap-0.5"
        >
          <div className="w-3 rounded-sm" style={{
            height: `${Math.max(4, winRate * 28)}px`,
            background: REGIME_COLORS[regime] ?? '#374151',
            opacity: 0.85,
          }} />
        </div>
      ))}
    </div>
  );
}

function StatCell({ v, isGood, neutral }: { v: React.ReactNode; isGood?: boolean; neutral?: boolean }) {
  const cls = neutral ? 'text-[#8b949e]' : isGood ? 'text-green-400' : 'text-red-400';
  return <td className={`py-2.5 pr-4 text-sm ${cls}`}>{v}</td>;
}

export default function StrategyBreakdown({ walletAddress, filters, journalId }: AnalyticsChartProps) {
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/analytics/positions?${buildParams(walletAddress, filters, journalId)}`)
      .then((r) => r.json())
      .then((d) => setPositions(d.positions ?? []))
      .finally(() => setLoading(false));
  }, [walletAddress, filters, journalId]);

  const overall = useMemo(() => computeStats(positions), [positions]);

  const groups = useMemo(() => {
    const map = new Map<string, PositionData[]>();
    for (const p of positions) {
      const key = p.tradeType ?? 'untagged';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries())
      .map(([type, ps]) => {
        const stats = computeStats(ps);
        const withHold = ps.filter((p) => p.holdTimeSeconds != null);
        const avgHold = withHold.length > 0
          ? withHold.reduce((s, p) => s + (p.holdTimeSeconds ?? 0), 0) / withHold.length
          : null;
        const withEff = ps.filter((p) => p.exitEfficiency != null && p.exitEfficiency > 0);
        const avgEff = withEff.length > 0
          ? withEff.reduce((s, p) => s + (p.exitEfficiency ?? 0), 0) / withEff.length
          : null;
        return { type, ps, stats, avgHold, avgEff };
      })
      .sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
  }, [positions]);

  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm animate-pulse">
        Loading strategy breakdown…
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
        No positions found. Tag trades with a type and run grouping to see strategy comparison.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left min-w-[700px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
            <th className="pb-2 pr-4">Trade Type</th>
            <th className="pb-2 pr-4">Trades</th>
            <th className="pb-2 pr-4">Win Rate</th>
            <th className="pb-2 pr-4">Total P&L</th>
            <th className="pb-2 pr-4">Avg P&L</th>
            <th className="pb-2 pr-4">Profit Factor</th>
            <th className="pb-2 pr-4">Avg Hold</th>
            <th className="pb-2 pr-4">Exit Eff.</th>
            <th className="pb-2">Regime Dist.</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ type, ps, stats, avgHold, avgEff }) => {
            const winRateAboveAvg = stats.winRate >= overall.winRate;
            return (
              <tr key={type} className="border-t border-[#21262d] hover:bg-[#1c2128] transition-colors">
                <td className="py-2.5 pr-4 font-medium text-white text-sm">
                  {type.replace(/_/g, ' ')}
                </td>
                <StatCell v={stats.tradeCount} neutral />
                <StatCell
                  v={`${(stats.winRate * 100).toFixed(1)}%`}
                  isGood={winRateAboveAvg}
                />
                <StatCell
                  v={`${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`}
                  isGood={stats.totalPnl >= 0}
                />
                <StatCell
                  v={`${stats.expectancy >= 0 ? '+' : ''}$${stats.expectancy.toFixed(2)}`}
                  isGood={stats.expectancy >= 0}
                />
                <StatCell
                  v={stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2)}
                  isGood={stats.profitFactor >= 1}
                />
                <StatCell v={avgHold != null ? fmtHoldTime(Math.round(avgHold)) : '—'} neutral />
                <StatCell
                  v={avgEff != null ? `${(avgEff * 100).toFixed(0)}%` : '—'}
                  isGood={avgEff != null && avgEff >= 0.5}
                  neutral={avgEff == null}
                />
                <td className="py-2.5">
                  <RegimeMiniBar tradePositions={ps} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-[#6e7681] mt-3">
        Regime mini-bars show win rate per regime (height = win rate). Hover a bar for details.
        Overall win rate: {(overall.winRate * 100).toFixed(1)}% — win rate colored green if above average.
      </p>
    </div>
  );
}
