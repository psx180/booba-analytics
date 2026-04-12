'use client';

import { useState, useEffect, useMemo } from 'react';
import type { AnalyticsChartProps, PositionData, PerformanceStats } from './types';
import { buildParams, computeStats, REGIME_LABELS } from './types';
import { useAuthFetch } from '@/lib/api-client';

interface Scenario {
  id: string;
  label: string;
  description: string;
  filter: (p: PositionData) => boolean;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'trending',
    label: 'Only trending regime',
    description: 'Keep only trades taken in trending_low_vol or trending_high_vol regimes.',
    filter: (p) => p.regimeAtEntry === 'trending_low_vol' || p.regimeAtEntry === 'trending_high_vol',
  },
  {
    id: 'ranging',
    label: 'Only ranging regime',
    description: 'Keep only trades taken in ranging_low_vol or ranging_high_vol regimes.',
    filter: (p) => p.regimeAtEntry === 'ranging_low_vol' || p.regimeAtEntry === 'ranging_high_vol',
  },
  {
    id: 'morning',
    label: 'Only morning trades (UTC 0–12)',
    description: 'Keep only trades entered before 12:00 UTC.',
    filter: (p) => (p.entryHour ?? 25) < 12,
  },
  {
    id: 'afternoon',
    label: 'Only afternoon trades (UTC 12–24)',
    description: 'Keep only trades entered at or after 12:00 UTC.',
    filter: (p) => (p.entryHour ?? -1) >= 12,
  },
  {
    id: 'held_1h',
    label: 'Only trades held > 1 hour',
    description: 'Exclude quick scalps — keep positions held for more than an hour.',
    filter: (p) => (p.holdTimeSeconds ?? 0) > 3600,
  },
  {
    id: 'held_under_1h',
    label: 'Only trades held < 1 hour',
    description: 'Keep only fast trades held under one hour.',
    filter: (p) => p.holdTimeSeconds != null && p.holdTimeSeconds < 3600,
  },
  {
    id: 'high_efficiency',
    label: 'Only high exit efficiency (>50%)',
    description: 'Keep only trades where you captured more than 50% of available move.',
    filter: (p) => (p.exitEfficiency ?? 0) > 0.5,
  },
];

function DeltaCell({ actual, whatIf, field, isPercent, higherBetter = true }: {
  actual: number; whatIf: number; field: string;
  isPercent?: boolean; higherBetter?: boolean;
}) {
  const delta = whatIf - actual;
  const fmt = (v: number) => isPercent
    ? `${(v * 100).toFixed(1)}%`
    : `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
  const fmtDelta = (v: number) => isPercent
    ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`
    : `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;

  const isGood = higherBetter ? delta > 0 : delta < 0;
  const deltaColor = Math.abs(delta) < 0.001 ? 'text-[#6e7681]' : isGood ? 'text-green-400' : 'text-red-400';

  return (
    <tr className="border-t border-[#21262d]">
      <td className="py-2 pr-4 text-xs text-[#6e7681] uppercase tracking-wider">{field}</td>
      <td className="py-2 pr-4 text-sm text-[#8b949e]">{fmt(actual)}</td>
      <td className="py-2 pr-4 text-sm text-white">{fmt(whatIf)}</td>
      <td className={`py-2 text-sm font-medium ${deltaColor}`}>
        {Math.abs(delta) < 0.001 ? '—' : fmtDelta(delta)}
      </td>
    </tr>
  );
}

export default function WhatIfExplorer({ filters, journalId }: AnalyticsChartProps) {
  const authFetch = useAuthFetch();
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    authFetch(`/api/analytics/positions?${buildParams(filters, journalId)}`)
      .then((r) => r.json())
      .then((d) => setPositions(d.positions ?? []))
      .finally(() => setLoading(false));
  }, [filters, journalId, authFetch]);

  const actual = useMemo(() => computeStats(positions), [positions]);

  const scenario = SCENARIOS.find((s) => s.id === selectedId);
  const hypothetical = useMemo(() => {
    if (!scenario) return null;
    return computeStats(positions.filter(scenario.filter));
  }, [positions, scenario]);

  if (loading) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm animate-pulse">
        Loading what-if data…
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
        No positions yet. Import trades to explore what-if scenarios.
      </div>
    );
  }

  const filteredCount = scenario ? positions.filter(scenario.filter).length : 0;

  return (
    <div className="space-y-5">
      {/* Scenario selector */}
      <div>
        <p className="text-xs text-[#6e7681] mb-3">Select a scenario to compare against your actual stats:</p>
        <div className="flex flex-wrap gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(selectedId === s.id ? null : s.id)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all border ${
                selectedId === s.id
                  ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                  : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-white hover:border-[#6e7681]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {scenario && (
          <p className="text-xs text-[#6e7681] mt-2">{scenario.description}</p>
        )}
      </div>

      {/* Comparison table */}
      {selectedId && hypothetical && (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs text-[#8b949e]">
              {filteredCount} of {positions.length} positions match this scenario
            </span>
            {filteredCount === 0 && (
              <span className="text-xs text-amber-400">No trades match — nothing to compare.</span>
            )}
          </div>

          {filteredCount > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[400px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-[#6e7681]">
                    <th className="pb-2 pr-4 text-left">Metric</th>
                    <th className="pb-2 pr-4 text-left">Actual</th>
                    <th className="pb-2 pr-4 text-left">What If</th>
                    <th className="pb-2 text-left">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-[#21262d]">
                    <td className="py-2 pr-4 text-xs text-[#6e7681] uppercase tracking-wider">Trades</td>
                    <td className="py-2 pr-4 text-sm text-[#8b949e]">{actual.tradeCount}</td>
                    <td className="py-2 pr-4 text-sm text-white">{hypothetical.tradeCount}</td>
                    <td className="py-2 text-sm text-[#6e7681]">{hypothetical.tradeCount - actual.tradeCount}</td>
                  </tr>
                  <DeltaCell field="Total P&L" actual={actual.totalPnl} whatIf={hypothetical.totalPnl} />
                  <DeltaCell field="Win Rate" actual={actual.winRate} whatIf={hypothetical.winRate} isPercent />
                  <DeltaCell field="Expectancy" actual={actual.expectancy} whatIf={hypothetical.expectancy} />
                  <DeltaCell
                    field="Profit Factor"
                    actual={actual.profitFactor === 999 ? 0 : actual.profitFactor}
                    whatIf={hypothetical.profitFactor === 999 ? 0 : hypothetical.profitFactor}
                    isPercent={false}
                  />
                  <DeltaCell field="Avg Winner" actual={actual.averageWin} whatIf={hypothetical.averageWin} />
                  <DeltaCell field="Avg Loser" actual={actual.averageLoss} whatIf={hypothetical.averageLoss} higherBetter={false} />
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!selectedId && (
        <p className="text-xs text-[#6e7681] italic">
          Select a scenario above to see how your stats change.
        </p>
      )}
    </div>
  );
}
