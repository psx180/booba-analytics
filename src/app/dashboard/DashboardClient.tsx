'use client';

import { useState, useEffect, useCallback } from 'react';
import EquityCurve, { EquityPoint, TradeMeta, REGIME_LABELS } from './EquityCurve';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PerformanceData {
  tradeCount: number;
  winRate: number;        // fraction 0-1
  lossRate: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  profitFactor: number;
  totalPnl: number;
  totalFees: number;
  totalFunding: number;
  avgTiltScore?: number;      // 0-1, averaged over positions with computed tiltScore
  tiltCoverage?: number;      // 0-1, fraction of positions with a score
  tiltEpisodeCount?: number;
}

interface PerformanceResult {
  name: string;
  data: PerformanceData;
  breakdowns?: { regime: Record<string, PerformanceData> };
  // Advanced summary fields appended by /api/analytics/summary
  eloResult?: EloResult;
  entropyResult?: EntropyResult;
  xpnlLuckScore?: number;
  xpnlResult?: XpnlSummary;
  equityCurveConsistency?: number;
}

interface EloResult {
  currentElo: number;
  tier: string;
  peakElo: number;
  peakDate: string | null;
  eloSeries: { date: string; elo: number }[];
  conditionDifficulty: { condition: string; elo: number }[];
  recentTrend: 'improving' | 'declining' | 'stable';
  tradeCount: number;
}

interface EntropyResult {
  compositeScore: number;
  dimensions: { name: string; entropy: number; normalizedEntropy: number; maxEntropy: number }[];
  conditionalEntropy: number;
  rollingSeries: { date: string; score: number }[];
  trend: 'improving' | 'declining' | 'stable';
  tradeCount: number;
}

interface XpnlSummary {
  positions: { positionId: string; actualPnl: number; xpnl: number; residual: number }[];
  cumulativeSeries: { date: string; actualCumPnl: number; xpnlCumPnl: number }[];
  luckScore: number;
  r2: number;
}

interface EquityCurvePoint {
  date: string;
  value: number;
  cumulativePnl: number;
  regime: string;
  positionId: string;
}

interface EquityCurveResult {
  name: string;
  data: { tradeCount: number; finalPnl: number };
  series: EquityCurvePoint[];
}

interface BreakdownResult {
  name: string;
  data: { groupBy: string; groupCount: number };
  breakdowns: Record<string, Record<string, PerformanceData>>;
}

interface StatisticalTest {
  testName: string;
  pValue: number;
  effectSize: number;
  sampleSizeA: number;
  sampleSizeB: number;
  isSignificant: boolean;
  description: string;
}

interface Insight {
  module: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  confidence: number;
  suggestion?: string;
  data: Record<string, any>;
  regimeBreakdown?: Record<string, any>;
  // Statistical fields
  statistics?: StatisticalTest[];
  impactScore?: number;
  category?: string;
  isSignificant?: boolean;
  sampleSize?: number;
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

const SEVERITY_STYLE: Record<Insight['severity'], { border: string; badge: string; badgeText: string }> = {
  info:     { border: 'border-blue-500/30',  badge: 'bg-blue-500/15',   badgeText: 'text-blue-300'   },
  warning:  { border: 'border-amber-500/40', badge: 'bg-amber-500/15',  badgeText: 'text-amber-300'  },
  critical: { border: 'border-red-500/40',   badge: 'bg-red-500/15',    badgeText: 'text-red-300'    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pnlColor(v: number) {
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

function formatPnl(v: number) {
  return `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
}

function formatPercent(fraction: number) {
  return `${(fraction * 100).toFixed(1)}%`;
}

// Tilt score shown on a 0-100 scale with a green/amber/red band.
function tiltColor(score0to100: number): string {
  if (score0to100 < 30) return 'text-green-400';
  if (score0to100 < 60) return 'text-amber-400';
  return 'text-red-400';
}

function eloColor(elo: number): string {
  if (elo >= 1800) return 'text-purple-400';
  if (elo >= 1600) return 'text-blue-400';
  if (elo >= 1400) return 'text-green-400';
  if (elo >= 1200) return 'text-amber-400';
  return 'text-red-400';
}

function disciplineColor(score: number): string {
  if (score >= 65) return 'text-green-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-red-400';
}

function consistencyColor(r2: number): string {
  if (r2 >= 0.7) return 'text-green-400';
  if (r2 >= 0.4) return 'text-amber-400';
  return 'text-red-400';
}

function trendArrow(trend: 'improving' | 'declining' | 'stable'): string {
  if (trend === 'improving') return '↑';
  if (trend === 'declining') return '↓';
  return '→';
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

const CATEGORY_LABEL: Record<string, string> = {
  exit:      'Exit',
  entry:     'Entry',
  behavior:  'Behavior',
  strategy:  'Strategy',
  risk:      'Risk',
  timing:    'Timing',
  pacifica:  'Pacifica',
};

// ── Insight Card ─────────────────────────────────────────────────────────────

function InsightCard({ insight }: { insight: Insight }) {
  const style       = SEVERITY_STYLE[insight.severity];
  const isSignif    = insight.isSignificant ?? false;
  const primaryTest = insight.statistics?.[0];
  const pValue      = primaryTest?.pValue;
  const pStr        = pValue != null
    ? (pValue < 0.001 ? 'p<0.001' : `p=${pValue.toFixed(3)}`)
    : null;
  // Guard: only show green badge when the displayed p-value also supports significance.
  // Prevents "Significant · p=0.391" when one backing test passed but statistics[0] didn't.
  const showSignificant = isSignif && (pValue == null || pValue < 0.05);

  return (
    <div
      className={`bg-[#161b22] border rounded-lg p-4 transition-opacity ${style.border} ${
        isSignif ? '' : 'opacity-60'
      }`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-semibold text-white">{insight.title}</div>
          {insight.category && (
            <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-widest font-medium bg-[#21262d] text-[#6e7681]">
              {CATEGORY_LABEL[insight.category] ?? insight.category}
            </span>
          )}
        </div>
        <span
          className={`shrink-0 px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-medium ${style.badge} ${style.badgeText}`}
        >
          {insight.severity}
        </span>
      </div>

      {/* Significance + sample size badges */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {showSignificant ? (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-green-900/30 text-green-400">
            Significant{pStr ? ` · ${pStr}` : ''}
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-900/20 text-amber-500">
            Preliminary{pStr ? ` · ${pStr}` : ''}
          </span>
        )}
        {insight.sampleSize != null && (
          <span className="text-[10px] text-[#6e7681]">Based on {insight.sampleSize} trades</span>
        )}
      </div>

      <p className="text-sm text-[#8b949e] leading-relaxed">{insight.description}</p>

      {insight.suggestion && (
        <p className="text-xs text-[#6e7681] leading-relaxed mt-2 pt-2 border-t border-[#21262d]">
          <span className="text-[#8b949e] font-medium">Suggestion: </span>
          {insight.suggestion}
        </p>
      )}
    </div>
  );
}

function EmptyInsightCard({ title, body }: { title: string; body: string }) {
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

function RegimeRow({ regime, stats }: { regime: string; stats: PerformanceData }) {
  if (stats.tradeCount === 0) return null;
  const badge = REGIME_BADGE[regime];
  return (
    <tr className="border-t border-[#21262d] text-sm">
      <td className="py-2 pr-4">
        {badge ? (
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${badge.bg} ${badge.text}`}>
            {badge.label}
          </span>
        ) : (
          <span className="text-[#6e7681]">{regime}</span>
        )}
      </td>
      <td className="py-2 pr-4 text-[#8b949e]">{stats.tradeCount}</td>
      <td className={`py-2 pr-4 font-medium ${pnlColor(stats.totalPnl)}`}>
        {formatPnl(stats.totalPnl)}
      </td>
      <td className="py-2 pr-4 text-[#8b949e]">{formatPercent(stats.winRate)}</td>
      <td className={`py-2 ${pnlColor(stats.expectancy)}`}>
        {formatPnl(stats.expectancy)}
      </td>
    </tr>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DashboardClient({ walletAddress }: { walletAddress: string }) {
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [tradeMetas, setTradeMetas] = useState<TradeMeta[]>([]);
  const [regimeBreakdown, setRegimeBreakdown] = useState<Record<string, PerformanceData>>({});
  const [insights, setInsights] = useState<Insight[]>([]);
  const [activeRegime, setActiveRegime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [computeResult, setComputeResult] = useState<string | null>(null);
  // Advanced analytics
  const [eloResult, setEloResult] = useState<EloResult | null>(null);
  const [entropyResult, setEntropyResult] = useState<EntropyResult | null>(null);
  const [equityConsistency, setEquityConsistency] = useState<number | null>(null);
  const [xpnlSummary, setXpnlSummary] = useState<XpnlSummary | null>(null);
  const [showXpnlOverlay, setShowXpnlOverlay] = useState(true);

  const fetchData = useCallback(
    async (regime: string | null) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ walletAddress });
        if (regime) params.set('regime', regime);

        const breakdownParams = new URLSearchParams({ walletAddress, groupBy: 'regime' });
        const equityParams = new URLSearchParams(params);
        equityParams.set('withXpnl', 'true');

        const [summaryRes, equityRes, breakdownRes, insightsRes] = await Promise.all([
          fetch(`/api/analytics/summary?${params}`),
          fetch(`/api/analytics/equity-curve?${equityParams}`),
          fetch(`/api/analytics/breakdown?${breakdownParams}`),
          fetch(`/api/analytics/insights?walletAddress=${walletAddress}`),
        ]);

        const [summaryData, equityData, breakdownData, insightsData] = await Promise.all([
          summaryRes.json() as Promise<PerformanceResult>,
          equityRes.json() as Promise<EquityCurveResult & { xpnl?: XpnlSummary }>,
          breakdownRes.json() as Promise<BreakdownResult>,
          insightsRes.json() as Promise<{ insights: Insight[] }>,
        ]);

        setPerformance(summaryData.data ?? null);
        setEloResult(summaryData.eloResult ?? null);
        setEntropyResult(summaryData.entropyResult ?? null);
        setEquityConsistency(summaryData.equityCurveConsistency ?? null);
        setXpnlSummary(equityData.xpnl ?? summaryData.xpnlResult ?? null);
        setEquityCurve(
          (equityData.series ?? []).map((p) => ({
            date: p.date,
            cumulativePnl: p.cumulativePnl,
          })),
        );
        setTradeMetas(
          (equityData.series ?? []).map((p) => ({
            date: p.date,
            regimeAtEntry: p.regime,
          })),
        );
        setRegimeBreakdown(breakdownData.breakdowns?.regime ?? {});
        setInsights(insightsData.insights ?? []);
      } finally {
        setLoading(false);
      }
    },
    [walletAddress],
  );

  useEffect(() => {
    fetchData(activeRegime);
  }, [fetchData, activeRegime]);

  const handleRegimeToggle = (regime: string) => {
    const next = activeRegime === regime ? null : regime;
    setActiveRegime(next);
  };

  const handleCompute = async () => {
    setComputing(true);
    setComputeResult(null);
    try {
      const res = await fetch('/api/analytics/metrics/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });
      const data = await res.json();
      const metricsCount = data.metrics?.computed ?? 0;
      const insightsCount = data.insights?.produced ?? 0;
      setComputeResult(`Computed metrics for ${metricsCount} positions. Found ${insightsCount} insights.`);
      await fetchData(activeRegime);
    } catch {
      setComputeResult('Compute failed — see server logs.');
    } finally {
      setComputing(false);
    }
  };

  const hasData = performance && performance.tradeCount > 0;

  const regimeRows = Object.entries(regimeBreakdown)
    .filter(([, stats]) => stats.tradeCount > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      {/* ── Header / Compute button ──────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-white">Dashboard</h1>
          {computeResult && (
            <p className="text-xs text-[#8b949e] mt-1">{computeResult}</p>
          )}
        </div>
        <button
          onClick={handleCompute}
          disabled={computing}
          className="px-3 py-1.5 rounded text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {computing ? 'Computing…' : 'Compute Analytics'}
        </button>
      </div>

      {/* ── Stats Bar ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-9 gap-3">
        <StatCard
          label="Total P&L"
          value={
            <span className={performance ? pnlColor(performance.totalPnl) : 'text-[#6e7681]'}>
              {performance ? formatPnl(performance.totalPnl) : '—'}
            </span>
          }
        />
        <StatCard
          label="Win Rate"
          value={performance ? formatPercent(performance.winRate) : '—'}
        />
        <StatCard
          label="Total Trades"
          value={performance?.tradeCount ?? '—'}
        />
        <StatCard
          label="Expectancy"
          value={
            <span className={performance ? pnlColor(performance.expectancy) : 'text-[#6e7681]'}>
              {performance ? formatPnl(performance.expectancy) : '—'}
            </span>
          }
          sub="avg $ per trade"
        />
        <StatCard
          label="Profit Factor"
          value={performance ? performance.profitFactor.toFixed(2) : '—'}
        />
        <StatCard
          label="Tilt Score"
          value={
            performance && (performance.tiltCoverage ?? 0) > 0 ? (
              <span className={tiltColor(Math.round((performance.avgTiltScore ?? 0) * 100))}>
                {Math.round((performance.avgTiltScore ?? 0) * 100)}
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub={
            performance && (performance.tiltEpisodeCount ?? 0) > 0
              ? `${performance.tiltEpisodeCount} episode${performance.tiltEpisodeCount === 1 ? '' : 's'}`
              : 'avg 0-100, wallet-wide'
          }
        />
        <StatCard
          label="ELO"
          value={
            eloResult ? (
              <span className="flex items-center gap-1.5">
                <span className={eloColor(eloResult.currentElo)}>
                  {Math.round(eloResult.currentElo)}
                </span>
                <span className="text-xs text-[#6e7681]">{trendArrow(eloResult.recentTrend)}</span>
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub={eloResult ? `${eloResult.tier} · peak ${Math.round(eloResult.peakElo)}` : 'chess-style rating'}
        />
        <StatCard
          label="Discipline"
          value={
            entropyResult ? (
              <span className="flex items-center gap-1.5">
                <span className={disciplineColor(entropyResult.compositeScore)}>
                  {Math.round(entropyResult.compositeScore)}
                </span>
                <span className="text-xs text-[#6e7681]">/100</span>
                <span className="text-xs text-[#6e7681]">{trendArrow(entropyResult.trend)}</span>
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub="Shannon entropy"
        />
        <StatCard
          label="Consistency"
          value={
            equityConsistency != null ? (
              <span className={consistencyColor(equityConsistency)}>
                {Math.round(equityConsistency * 100)}%
              </span>
            ) : (
              <span className="text-[#6e7681]">—</span>
            )
          }
          sub="equity curve R²"
        />
      </div>

      {/* ── Equity Curve ──────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Equity Curve</h2>
            {(activeRegime || equityConsistency != null || xpnlSummary) && (
              <p className="text-xs text-[#6e7681] mt-0.5 flex items-center gap-3 flex-wrap">
                {activeRegime && (
                  <span>
                    Showing trades in{' '}
                    <span className="text-amber-400">
                      {REGIME_LABELS[activeRegime] ?? activeRegime}
                    </span>{' '}
                    only
                  </span>
                )}
                {equityConsistency != null && (
                  <span>
                    Consistency:{' '}
                    <span className={consistencyColor(equityConsistency)}>
                      {Math.round(equityConsistency * 100)}%
                    </span>
                  </span>
                )}
                {xpnlSummary && (
                  <span>
                    Luck score:{' '}
                    <span className={xpnlSummary.luckScore >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {xpnlSummary.luckScore >= 0 ? '+' : ''}
                      {Math.round(xpnlSummary.luckScore * 100)}%
                    </span>
                  </span>
                )}
              </p>
            )}
          </div>

          {/* Regime filter toggles */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setShowXpnlOverlay((v) => !v)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                showXpnlOverlay
                  ? 'bg-slate-700/60 text-slate-200 ring-1 ring-current'
                  : 'bg-[#21262d] text-[#6e7681] hover:text-[#8b949e]'
              }`}
              title="Toggle expected P&L overlay"
            >
              Expected P&L
            </button>
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
            equityCurve={equityCurve}
            tradeMetas={tradeMetas}
            activeRegimeFilter={activeRegime}
            xpnlSeries={xpnlSummary?.cumulativeSeries}
            showXpnl={showXpnlOverlay}
          />
        )}

        {/* Regime legend */}
        {!activeRegime && hasData && (
          <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-[#21262d]">
            {Object.entries(REGIME_BADGE).map(([key, { label, bg }]) => (
              <span key={key} className="flex items-center gap-1.5 text-xs text-[#6e7681]">
                <span className={`w-3 h-3 rounded-sm ${bg}`} />
                {label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Insight Cards ─────────────────────────────────────────────────── */}
      {insights.length > 0 ? (
        <>
          {insights.some((i) => i.isSignificant) ? null : (
            <p className="text-xs text-[#6e7681] -mb-1">
              We're analyzing your trading patterns. Most insights require 20+ trades with sufficient variety to detect reliable patterns. Keep trading and check back.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {insights.slice(0, 5).map((insight, i) => (
              <InsightCard key={`${insight.module}-${i}`} insight={insight} />
            ))}
          </div>
          {insights.length > 5 && (
            <div className="text-right">
              <a
                href="/analytics"
                className="text-xs text-[#6e7681] hover:text-white transition-colors"
              >
                View all {insights.length} insights →
              </a>
            </div>
          )}
        </>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <EmptyInsightCard
            title="No Insights Yet"
            body="Click Compute Analytics to run the behavioral detectors. Booba needs at least 20 closed positions with MFE/MAE data before insights will appear."
          />
          <EmptyInsightCard
            title="Regime Insight"
            body="Regime-conditional performance insights will appear here once there's enough data across regimes."
          />
          <EmptyInsightCard
            title="Strategy Insight"
            body="Strategy degradation alerts will appear here once a baseline has been established."
          />
        </div>
      )}

      {/* ── Regime Breakdown Table ─────────────────────────────────────────── */}
      {hasData && regimeRows.length > 0 && (
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
              {regimeRows.map(([regime, stats]) => (
                <RegimeRow key={regime} regime={regime} stats={stats} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
