'use client';

import { useState, useEffect } from 'react';
import type { AnalyticsChartProps, PerformanceStats } from './types';
import { buildParams } from './types';
import { useAuthFetch } from '@/lib/api-client';
import SignificanceBadge, { SIGNIFICANCE_FOOTNOTE } from './SignificanceBadge';

type BuilderBreakdown = Record<string, PerformanceStats>;

/**
 * Per-builder-code performance table on the Strategy tab. Sourced from the
 * server-side breakdown aggregator (groupBy=builderCode), so significance
 * fields (pnlPValue, winRatePValue, isSignificant, sampleSize) are already
 * attached to each row.
 *
 * Manual trades surface under the 'manual' label (Position.builderCode IS
 * NULL), letting the user immediately compare manual vs. each builder.
 */
export default function BuilderCodeBreakdown({ filters, journalId }: AnalyticsChartProps) {
  const authFetch = useAuthFetch();
  const [breakdown, setBreakdown] = useState<BuilderBreakdown>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const p = buildParams(filters, journalId);
    p.set('groupBy', 'builderCode');
    authFetch(`/api/analytics/breakdown?${p}`)
      .then((r) => r.json())
      .then((d) => setBreakdown(d.breakdowns?.builderCode ?? {}))
      .finally(() => setLoading(false));
  }, [filters, journalId, authFetch]);

  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm animate-pulse">
        Loading builder code breakdown…
      </div>
    );
  }

  const entries = Object.entries(breakdown).filter(([, s]) => s.tradeCount > 0);
  if (entries.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
        No builder code data yet.
      </div>
    );
  }

  const totalTrades = entries.reduce((s, [, st]) => s + st.tradeCount, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
            <th className="pb-2 pr-4">Builder</th>
            <th className="pb-2 pr-4">Trades</th>
            <th className="pb-2 pr-4">% of All</th>
            <th className="pb-2 pr-4">Total P&L</th>
            <th className="pb-2 pr-4">Win Rate</th>
            <th className="pb-2 pr-4">Expectancy</th>
            <th className="pb-2 pr-4">Profit Factor</th>
            <th className="pb-2">Significance</th>
          </tr>
        </thead>
        <tbody>
          {entries
            .sort(([, a], [, b]) => b.totalPnl - a.totalPnl)
            .map(([code, stats]) => (
              <tr key={code} className="border-t border-[#21262d] text-sm hover:bg-[#1c2128] transition-colors">
                <td className="py-2.5 pr-4">
                  {code === 'manual' ? (
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-slate-700/40 text-slate-300">
                      manual
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-[#e6edf3]">{code}</span>
                  )}
                </td>
                <td className="py-2.5 pr-4 text-[#8b949e]">{stats.tradeCount}</td>
                <td className="py-2.5 pr-4 text-[#8b949e]">
                  {totalTrades > 0 ? `${((stats.tradeCount / totalTrades) * 100).toFixed(0)}%` : '—'}
                </td>
                <td className={`py-2.5 pr-4 font-medium ${stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}
                </td>
                <td className="py-2.5 pr-4 text-[#8b949e]">
                  {(stats.winRate * 100).toFixed(1)}%
                </td>
                <td className={`py-2.5 pr-4 ${stats.expectancy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)}
                </td>
                <td className={`py-2.5 pr-4 ${stats.profitFactor >= 1 ? 'text-green-400' : 'text-red-400'}`}>
                  {stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2)}
                </td>
                <td className="py-2.5">
                  <SignificanceBadge stats={stats} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="text-[10px] text-[#6e7681] mt-2">
        {SIGNIFICANCE_FOOTNOTE}
      </p>
    </div>
  );
}
