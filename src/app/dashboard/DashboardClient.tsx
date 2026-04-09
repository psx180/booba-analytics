'use client';

import { useState, useEffect, useCallback } from 'react';
import EquityCurve, { EquityPoint, TradeMeta, REGIME_LABELS } from './EquityCurve';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Summary {
  tradeCount: number;
  totalPnl: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
  equityCurve: EquityPoint[];
}

interface RegimeStats {
  regime: string;
  tradeCount: number;
  totalPnl: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const REGIME_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  trending_low_vol:  { label: 'Trending',    bg: 'bg-green-900/40',  text: 'text-green-400' },
  trending_high_vol: { label: 'Trending ↑V', bg: 'bg-green-900/30',  text: 'text-green-300' },
  ranging_low_vol:   { label: 'Ranging',     bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  ranging_high_vol:  { label: 'Ranging ↑V',  bg: 'bg-amber-900/30',  text: 'text-amber-300' },
  transitional:      { label: 'Trans.',      bg: 'bg-slate-700/40',  text: 'text-slate-400' },
};

const FILTER_REGIMES = [
  { key: 'trending_low_vol',  label: 'Trending' },
  { key: 'trending_high_vol', label: 'Trending ↑Vol' },
  { key: 'ranging_low_vol',   label: 'Ranging' },
  { key: 'ranging_high_vol',  label: 'Ranging ↑Vol' },
  { key: 'transitional',      label: 'Transitional' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pnlColor(v: number) {
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

function formatPnl(v: number) {
  return `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
}

// ── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
      <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-[#6e7681] mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Insight Card ─────────────────────────────────────────────────────────────

function InsightCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
      <div className="text-xs font-semibold text-[#8b949e] mb-2 uppercase tracking-wider">
        {title}
      </div>
      <p className="text-sm text-[#6e7681] leading-relaxed">{body}</p>
    </div>
  );
}

// ── Regime breakdown row ──────────────────────────────────────────────────────

function RegimeRow({ stats }: { stats: RegimeStats }) {
  if (stats.tradeCount === 0) return null;
  const badge = REGIME_BADGE[stats.regime];
  return (
    <tr className="border-t border-[#21262d] text-sm">
      <td className="py-2 pr-4">
        {badge ? (
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${badge.bg} ${badge.text}`}>
            {badge.label}
          </span>
        ) : (
          <span className="text-[#6e7681]">{stats.regime}</span>
        )}
      </td>
      <td className="py-2 pr-4 text-[#8b949e]">{stats.tradeCount}</td>
      <td className={`py-2 pr-4 font-medium ${pnlColor(stats.totalPnl)}`}>
        {formatPnl(stats.totalPnl)}
      </td>
      <td className="py-2 pr-4 text-[#8b949e]">{stats.winRate.toFixed(1)}%</td>
      <td className={`py-2 ${pnlColor(stats.expectancy)}`}>
        {formatPnl(stats.expectancy)}
      </td>
    </tr>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DashboardClient({ walletAddress }: { walletAddress: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [regimeBreakdown, setRegimeBreakdown] = useState<RegimeStats[]>([]);
  const [tradeMetas, setTradeMetas] = useState<TradeMeta[]>([]);
  const [activeRegime, setActiveRegime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(
    async (regime: string | null) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ walletAddress });
        if (regime) params.set('regime', regime);

        const [summaryRes, regimeRes, tradesRes] = await Promise.all([
          fetch(`/api/analytics/summary?${params}`),
          fetch(`/api/analytics/regime-breakdown?walletAddress=${walletAddress}`),
          fetch(`/api/trades?${params}&pageSize=500&sortBy=exitTime&sortDir=asc`),
        ]);

        const [summaryData, regimeData, tradesData] = await Promise.all([
          summaryRes.json(),
          regimeRes.json(),
          tradesRes.json(),
        ]);

        setSummary(summaryData);
        setRegimeBreakdown(regimeData.regimes ?? []);
        setTradeMetas(
          (tradesData.trades ?? []).map((t: any) => ({
            date: t.exitTime ?? t.entryTime,
            regimeAtEntry: t.regimeAtEntry,
          }))
        );
      } finally {
        setLoading(false);
      }
    },
    [walletAddress]
  );

  useEffect(() => {
    fetchData(activeRegime);
  }, [fetchData, activeRegime]);

  const handleRegimeToggle = (regime: string) => {
    const next = activeRegime === regime ? null : regime;
    setActiveRegime(next);
  };

  const hasData = summary && summary.tradeCount > 0;

  return (
    <div className="space-y-6">
      {/* ── Stats Bar ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label="Total P&L"
          value={
            <span className={summary ? pnlColor(summary.totalPnl) : 'text-[#6e7681]'}>
              {summary ? formatPnl(summary.totalPnl) : '—'}
            </span>
          }
        />
        <StatCard
          label="Win Rate"
          value={summary ? `${summary.winRate.toFixed(1)}%` : '—'}
        />
        <StatCard
          label="Total Trades"
          value={summary?.tradeCount ?? '—'}
        />
        <StatCard
          label="Expectancy"
          value={
            <span className={summary ? pnlColor(summary.expectancy) : 'text-[#6e7681]'}>
              {summary ? formatPnl(summary.expectancy) : '—'}
            </span>
          }
          sub="avg $ per trade"
        />
        <StatCard
          label="Profit Factor"
          value={summary ? summary.profitFactor.toFixed(2) : '—'}
        />
      </div>

      {/* ── Equity Curve ──────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Equity Curve</h2>
            {activeRegime && (
              <p className="text-xs text-[#6e7681] mt-0.5">
                Showing trades in{' '}
                <span className="text-amber-400">
                  {REGIME_LABELS[activeRegime] ?? activeRegime}
                </span>{' '}
                only
              </p>
            )}
          </div>

          {/* Regime filter toggles */}
          <div className="flex flex-wrap gap-1.5">
            {FILTER_REGIMES.map(({ key, label }) => {
              const isActive = activeRegime === key;
              const badge = REGIME_BADGE[key];
              return (
                <button
                  key={key}
                  onClick={() => handleRegimeToggle(key)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                    isActive
                      ? `${badge.bg} ${badge.text} ring-1 ring-current`
                      : 'bg-[#21262d] text-[#6e7681] hover:text-[#8b949e]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
            {activeRegime && (
              <button
                onClick={() => setActiveRegime(null)}
                className="px-2.5 py-1 rounded text-xs text-[#6e7681] hover:text-white bg-[#21262d] transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="h-64 flex items-center justify-center text-[#6e7681] text-sm">
            Loading…
          </div>
        ) : (
          <EquityCurve
            equityCurve={summary?.equityCurve ?? []}
            tradeMetas={tradeMetas}
            activeRegimeFilter={activeRegime}
          />
        )}

        {/* Regime legend */}
        {!activeRegime && hasData && (
          <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-[#21262d]">
            {Object.entries(REGIME_BADGE).map(([key, { label, bg, text }]) => (
              <span key={key} className="flex items-center gap-1.5 text-xs text-[#6e7681]">
                <span className={`w-3 h-3 rounded-sm ${bg}`} />
                {label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Regime Breakdown Table ─────────────────────────────────────────── */}
      {hasData && (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
          <h2 className="text-sm font-semibold text-white mb-3">Performance by Regime</h2>
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-[#6e7681]">
                <th className="pb-2 pr-4">Regime</th>
                <th className="pb-2 pr-4">Trades</th>
                <th className="pb-2 pr-4">P&L</th>
                <th className="pb-2 pr-4">Win Rate</th>
                <th className="pb-2">Expectancy</th>
              </tr>
            </thead>
            <tbody>
              {regimeBreakdown
                .filter((r) => r.tradeCount > 0)
                .map((r) => (
                  <RegimeRow key={r.regime} stats={r} />
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Insight Cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <InsightCard
          title="Behavioral Insight"
          body="Behavioral insights will appear here as data accumulates. Booba is watching for disposition effect, revenge trading, and size escalation patterns."
        />
        <InsightCard
          title="Regime Insight"
          body="Regime-conditional performance insights will appear here. Booba will flag if your edge degrades in ranging markets vs. your trending performance."
        />
        <InsightCard
          title="Strategy Insight"
          body="Strategy degradation alerts will appear here. Booba tracks rolling win rate vs. historical baseline and flags statistically significant drops."
        />
      </div>
    </div>
  );
}
