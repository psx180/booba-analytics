'use client';

import { useEffect, useState } from 'react';
import { useAuthFetch } from '@/lib/api-client';

interface Analytics {
  sampleSize: number;
  highAdherence: { count: number; winRate: number | null; avgPnl: number | null } | null;
  lowAdherence:  { count: number; winRate: number | null; avgPnl: number | null } | null;
  mostViolatedRule: { label: string; violations: number } | null;
  // Money left on the table: (highAvgPnl - lowAvgPnl) * lowAdherence.count.
  // Positive = following the plan would have earned this much more on the
  // trades where the trader deviated.
  costOfDeviation: number | null;
  notEnoughData: boolean;
  enoughDataThreshold: number;
}

export default function PlaybookAnalyticsCard({
  playbookId,
  playbookName,
}: {
  playbookId: string;
  playbookName: string;
}) {
  const authFetch = useAuthFetch();
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/playbooks/${playbookId}/analytics`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setAnalytics(d.analytics ?? null); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playbookId, authFetch]);

  if (loading) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4 text-xs text-[#6e7681]">
        Loading analytics for {playbookName}…
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4 text-xs text-[#6e7681]">
        {playbookName} — no data.
      </div>
    );
  }

  if (analytics.notEnoughData) {
    return (
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="text-sm font-semibold text-white mb-1">{playbookName}</div>
        <div className="text-xs text-[#8b949e]">
          Need at least {analytics.enoughDataThreshold} checked trades to compute analytics —
          {' '}currently {analytics.sampleSize}.
        </div>
      </div>
    );
  }

  const hi = analytics.highAdherence;
  const lo = analytics.lowAdherence;

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-white">{playbookName}</div>
        <div className="text-xs text-[#6e7681]">{analytics.sampleSize} scored trades</div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-[#0d1117] border border-[#21262d] rounded p-3">
          <div className="text-[10px] uppercase tracking-widest text-green-400 mb-1">Following plan (≥80%)</div>
          {hi && hi.count > 0 ? (
            <>
              <div className="text-lg font-bold text-white">{hi.winRate != null ? `${(hi.winRate * 100).toFixed(0)}%` : '—'} win rate</div>
              <div className="text-xs text-[#8b949e]">
                {hi.count} trades, avg ${hi.avgPnl != null ? hi.avgPnl.toFixed(2) : '—'}/trade
              </div>
            </>
          ) : <div className="text-xs text-[#6e7681]">No trades in this band</div>}
        </div>

        <div className="bg-[#0d1117] border border-[#21262d] rounded p-3">
          <div className="text-[10px] uppercase tracking-widest text-red-400 mb-1">Deviating (&lt;50%)</div>
          {lo && lo.count > 0 ? (
            <>
              <div className="text-lg font-bold text-white">{lo.winRate != null ? `${(lo.winRate * 100).toFixed(0)}%` : '—'} win rate</div>
              <div className="text-xs text-[#8b949e]">
                {lo.count} trades, avg ${lo.avgPnl != null ? lo.avgPnl.toFixed(2) : '—'}/trade
              </div>
            </>
          ) : <div className="text-xs text-[#6e7681]">No trades in this band</div>}
        </div>
      </div>

      {analytics.mostViolatedRule && (
        <div className="text-xs text-[#8b949e] mb-1">
          Most-violated rule:{' '}
          <span className="text-amber-400 font-semibold">{analytics.mostViolatedRule.label}</span>
          {' '}({analytics.mostViolatedRule.violations} trades)
        </div>
      )}

      {analytics.costOfDeviation != null && analytics.costOfDeviation > 0 && lo && lo.count > 0 && (
        <div className="text-xs mt-2 pt-2 border-t border-[#21262d]">
          Your win rate is{' '}
          <span className="text-green-400 font-semibold">
            {hi?.winRate != null ? `${(hi.winRate * 100).toFixed(0)}%` : '—'}
          </span>
          {' '}when following your plan vs{' '}
          <span className="text-red-400 font-semibold">
            {lo.winRate != null ? `${(lo.winRate * 100).toFixed(0)}%` : '—'}
          </span>
          {' '}when deviating. Following your rules would have saved roughly{' '}
          <span className="text-white font-semibold">${analytics.costOfDeviation.toFixed(2)}</span>.
        </div>
      )}
    </div>
  );
}
