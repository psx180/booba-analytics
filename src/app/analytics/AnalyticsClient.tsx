'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AnalyticsFilters } from './types';
import { EMPTY_FILTERS, ALL_REGIMES, REGIME_LABELS, TRADE_TYPES, buildParams } from './types';
import { useJournal } from '../JournalContext';
import { useAuthFetch } from '@/lib/api-client';
import CalendarHeatmap from './CalendarHeatmap';
import TimeAnalysis from './TimeAnalysis';
import ExitAnalysis, { type ExitSummary } from './ExitAnalysis';
import StrategyBreakdown from './StrategyBreakdown';
import WhatIfExplorer from './WhatIfExplorer';
import RegimePerformance from './RegimePerformance';
import PatternsSection, { OutcomeSerialDependence } from './PatternsSection';
import EdgeFinder, { type CombinatorialSearchResult } from './EdgeFinder';
import WartRadar, { type WartResult } from './WartRadar';
import DisciplineGauge from './behavior/DisciplineGauge';
import MarkovBars from './behavior/MarkovBars';
import SessionDecayChart from './behavior/SessionDecayChart';
import SizeAfterOutcomeScatter from './behavior/SizeAfterOutcomeScatter';
import TiltEquityCurve, { type TiltEpisode } from './behavior/TiltEquityCurve';
import MonteCarloChart from './monte-carlo/MonteCarloChart';
import WhatIfChart from './what-if/WhatIfChart';
import WalkForwardChart from './walk-forward/WalkForwardChart';
import PlaybookAnalyticsCard from '../playbooks/PlaybookAnalyticsCard';
import type {
  ConvergenceResult,
  ConvergentTheme,
  ThemeSeverity,
} from '@/services/analytics/convergence';

// ── Types ──────────────────────────────────────────────────────────────────────

interface StatisticalTest {
  pValue: number;
  isSignificant: boolean;
  testName?: string;
  effectSize?: number;
}

interface Insight {
  module: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  confidence: number;
  affectedPositions: string[];
  suggestion?: string;
  data: Record<string, any>;
  statistics: StatisticalTest[];
  impactScore: number;
  category: string;
  isSignificant: boolean;
  sampleSize: number;
  tier?: 'significant' | 'preliminary' | 'descriptive' | 'not_detected';
}

interface EloResult {
  currentElo: number;
  tier: string;
  peakElo: number;
  recentTrend: 'improving' | 'declining' | 'stable';
  tradeCount: number;
}

interface EntropyResult {
  compositeScore: number;
  rollingSeries: { date: string; score: number }[];
}

interface MarkovData {
  transitionProbabilities: {
    winAfterWin: number;
    winAfterLoss: number;
    lossAfterWin: number;
    lossAfterLoss: number;
  };
  overallWinRate: number;
  independenceTest: { pValue: number; isSignificant: boolean };
}

interface BehaviorPosition {
  id: string;
  kind: 'position' | 'linked_strategy';
  pnl: number | null;
  totalSize: number | null;
  firstEntryTime: string | null;
}

interface DrawdownAnalysis {
  maxDrawdown: number;
  maxDrawdownPercent: number;
  currentDrawdown: number;
  currentDrawdownDuration: number;
  avgDrawdownDuration: number;
  drawdownCount: number;
  longestDrawdown: number;
}

interface FeeAttribution {
  totalFees: number;
  totalFunding: number;
  directionalPnl: number;
  feeImpact: number;
  fundingImpact: number;
}

// ── Tab config ─────────────────────────────────────────────────────────────────

type TabId = 'overview' | 'strategy' | 'execution' | 'risk' | 'psychology' | 'insights';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview',   label: 'Overview' },
  { id: 'strategy',   label: 'Strategy' },
  { id: 'execution',  label: 'Execution' },
  { id: 'risk',       label: 'Risk' },
  { id: 'psychology', label: 'Psychology' },
  { id: 'insights',   label: 'Insights' },
];

const CATEGORY_TO_TAB: Record<string, TabId> = {
  timing:   'execution',
  exit:     'execution',
  behavior: 'psychology',
  strategy: 'strategy',
  risk:     'risk',
  entry:    'strategy',
  pacifica: 'strategy',
};

const CATEGORY_LABEL: Record<string, string> = {
  behavior: 'Behavior',
  exit:     'Exit',
  timing:   'Timing',
  strategy: 'Strategy',
  risk:     'Risk',
  entry:    'Entry',
  pacifica: 'Pacifica',
};

const SEVERITY_STYLE: Record<string, { border: string; badge: string; badgeText: string }> = {
  info:     { border: 'border-blue-500/30',  badge: 'bg-blue-500/15',   badgeText: 'text-blue-300'   },
  warning:  { border: 'border-amber-500/40', badge: 'bg-amber-500/15',  badgeText: 'text-amber-300'  },
  critical: { border: 'border-red-500/40',   badge: 'bg-red-500/15',    badgeText: 'text-red-300'    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function eloColor(elo: number): string {
  if (elo >= 1800) return 'text-purple-400';
  if (elo >= 1600) return 'text-blue-400';
  if (elo >= 1400) return 'text-green-400';
  if (elo >= 1200) return 'text-amber-400';
  return 'text-red-400';
}

function trendArrow(trend: 'improving' | 'declining' | 'stable'): string {
  if (trend === 'improving') return '↑';
  if (trend === 'declining') return '↓';
  return '→';
}

function wartColor(composite: number): string {
  if (composite >=  1) return 'text-green-400';
  if (composite >= -0.5) return 'text-amber-400';
  return 'text-red-400';
}

/** Deduplicate insights by title, keeping highest impactScore per title. */
function deduplicateByTitle(insights: Insight[]): Insight[] {
  const map = new Map<string, Insight>();
  for (const insight of insights) {
    const existing = map.get(insight.title);
    if (!existing || insight.impactScore > existing.impactScore) {
      map.set(insight.title, insight);
    }
  }
  return Array.from(map.values());
}

/**
 * Pick top 3 insights from deduplicated list ensuring ≥2 different categories.
 */
function pickTop3(insights: Insight[]): Insight[] {
  const deduped = deduplicateByTitle(insights)
    .sort((a, b) => b.impactScore - a.impactScore);

  if (deduped.length <= 3) return deduped;

  const top3 = deduped.slice(0, 3);
  const categories = new Set(top3.map((i) => i.category));

  // If all 3 are the same category, replace the 3rd with the best from a different one
  if (categories.size === 1) {
    const firstCat = top3[0].category;
    const altIdx = deduped.findIndex((i) => i.category !== firstCat);
    if (altIdx >= 3) top3[2] = deduped[altIdx];
  }

  return top3;
}

/** First sentence (up to first period ≤120 chars) or first 120 chars. */
function firstSentence(text: string): string {
  const period = text.indexOf('.');
  return period > 0 && period < 120 ? text.slice(0, period + 1) : text.slice(0, 120);
}

/** Derive one-liner for a category tab from the insights array. */
function getCategoryOneliner(tabId: TabId, insights: Insight[]): string | null {
  const catMap: Record<string, string[]> = {
    execution:  ['timing', 'exit'],
    psychology: ['behavior'],
    strategy:   ['strategy', 'entry', 'pacifica'],
    risk:       ['risk'],
  };
  const cats = catMap[tabId] ?? [];

  const match = insights
    .filter((i) => cats.includes(i.category))
    .sort((a, b) => b.impactScore - a.impactScore)[0];

  return match ? firstSentence(match.description ?? match.title) : null;
}

/** Top 2-3 insights for a given tab by category, for inline display. */
function getInlineInsights(tabId: TabId, insights: Insight[], n = 3): Insight[] {
  const catMap: Record<string, string[]> = {
    execution:  ['timing', 'exit'],
    psychology: ['behavior'],
    strategy:   ['strategy', 'entry', 'pacifica'],
    risk:       ['risk'],
  };
  const cats = catMap[tabId] ?? [];
  const filtered = insights.filter((i) => cats.includes(i.category));
  return deduplicateByTitle(filtered)
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, n);
}

// ── Filter Select ─────────────────────────────────────────────────────────────

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-widest text-[#6e7681]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[#21262d] border border-[#30363d] text-sm text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500 min-w-[130px]"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── Impact-led insight framing ────────────────────────────────────────────────
// The insight detectors produce neutral technical titles ("Exit Efficiency
// Baseline", "Disposition Effect Detected"). For the cards we rewrite the
// headline to lead with the dollar impact or the behavioural finding in plain
// English. Statistical backing is moved behind a disclosure — still one click
// away, but not the first thing the user reads.

function formatDollar(n: number): string {
  const v = Math.round(Math.abs(n));
  return (n < 0 ? '-' : '') + '$' + v.toLocaleString();
}

function deriveImpactHeadline(insight: Insight): string {
  const d = insight.data ?? {};
  const num = (v: unknown): number | null =>
    typeof v === 'number' && isFinite(v) ? v : null;

  switch (insight.module) {
    case 'exit-optimizer': {
      const left = num(d.totalLeftOnTable);
      if (left != null && left > 0) return `You're leaving ${formatDollar(left)} on the table`;
      return 'Your exit timing has room to improve';
    }
    case 'disposition': {
      const cost = num(d.estimatedCost);
      if (cost != null && cost > 0) return `Disposition effect is costing you ${formatDollar(cost)}`;
      return 'You hold losers longer than winners';
    }
    case 'liquidation': {
      const count = num(d.liquidationCount);
      const cost  = num(d.totalCost);
      if (count && cost != null) {
        return `You were liquidated ${count} time${count === 1 ? '' : 's'}, costing ${formatDollar(Math.abs(cost))}`;
      }
      return 'You were liquidated';
    }
    case 'tilt-episodes': {
      const impr = num(d.counterfactualImprovement);
      if (impr != null && impr > 0) return `Tilt episodes are costing you ${formatDollar(impr)}`;
      const eps = num(d.totalEpisodes);
      if (eps && eps > 0) return `${eps} tilt episode${eps === 1 ? '' : 's'} detected`;
      return 'No tilt episodes detected';
    }
    case 'size-escalation': {
      const impact = num(d.dollarImpact);
      if (impact && impact > 0) return `Size escalation after losses is costing you ${formatDollar(impact)}`;
      return 'Your position size grows after losses';
    }
    case 'sizing-analysis': {
      const savings = num(d.regimeDollarSavings);
      if (savings && savings > 0) return `Better sizing in high-vol regimes saves ${formatDollar(savings)}`;
      const impact = num(d.dollarImpact);
      if (impact && impact > 0) return `Inconsistent sizing is costing you ${formatDollar(impact)}`;
      return 'Your position sizing is consistent';
    }
    case 'regime-mismatch': {
      const impact = num(d.topDollarImpact);
      if (impact != null) {
        return `${formatDollar(Math.abs(impact))} lost in regime-strategy mismatches`;
      }
      return 'Your strategy performs differently across regimes';
    }
    case 'revenge-trading': {
      const impact = num(d.dollarImpact);
      if (impact && impact > 0) return `Revenge trading is costing you ${formatDollar(impact)}`;
      return 'No revenge-trading pattern detected';
    }
    case 'overtrading': {
      const impact = num(d.dollarImpact);
      if (impact && impact > 0) return `Overtrading on heavy days costs ${formatDollar(impact)}`;
      return 'Your trade frequency has no impact on P&L';
    }
    case 'time-of-day-edge': {
      const fatigue = d.fatigue as { estimatedSavings?: number } | null | undefined;
      if (fatigue?.estimatedSavings && fatigue.estimatedSavings > 0) {
        return `Session fatigue costs ${formatDollar(fatigue.estimatedSavings)}`;
      }
      const bestHour = num(d.bestHour);
      if (bestHour != null) return `Your best hour is ${String(bestHour).padStart(2, '0')}:00`;
      return 'No time-of-day edge detected';
    }
    case 'hold-time-optimizer': {
      const impact = num(d.dollarImpact);
      if (impact && impact > 0) return `Hold-time tuning could gain ${formatDollar(impact)}`;
      return 'Hold time analysis: no clear optimal window yet';
    }
    case 'streak-behavior': {
      const winPnl  = num(d.winStreakTotalPnl)  ?? 0;
      const lossPnl = num(d.lossStreakTotalPnl) ?? 0;
      const totalStreakPnl = winPnl + lossPnl;
      if (totalStreakPnl < -100) return `Streak-influenced trades cost ${formatDollar(Math.abs(totalStreakPnl))}`;
      if (totalStreakPnl > 100)  return `Streak-influenced trades earned ${formatDollar(totalStreakPnl)}`;
      return 'No significant streak-state behaviour detected';
    }
    case 'social-correlation': {
      const gap = num(d.winRateGap);
      const betterGroup = d.betterGroup as string | undefined;
      if (gap != null && gap > 0 && betterGroup) {
        const label = betterGroup === 'high' ? 'high-buzz' : 'low-buzz';
        return `You win ${Math.round(gap)}% more on ${label} trades`;
      }
      return 'Social attention has no clear effect on your win rate';
    }
    case 'xpnl': {
      const luck = num(d.luckScore);
      if (luck != null) {
        const pct = Math.round(luck * 100);
        if (pct > 20)  return `Your P&L is ${pct}% above expected — likely luck`;
        if (pct < -20) return `Your P&L is ${Math.abs(pct)}% below expected — likely unlucky`;
        return 'Your P&L matches expected skill level';
      }
      return 'Expected P&L analysis pending';
    }
    case 'outlier-dependency': {
      const topPct = num(d.topPct);
      const top10Count = num(d.top10Count);
      if (topPct != null && top10Count != null) {
        if (topPct > 50) return `${top10Count} trades drive ${Math.round(topPct)}% of your total P&L`;
        return `Your P&L is well-distributed across ${num(d.tradeCount) ?? 'your'} trades`;
      }
      return 'Outlier dependency analysis pending';
    }
    case 'entropy': {
      const score = num(d.compositeScore);
      if (score != null) {
        if (score >= 65) return `Discipline score: ${Math.round(score)}/100 — focused, rule-driven trading`;
        if (score >= 40) return `Discipline score: ${Math.round(score)}/100 — mixed consistency`;
        return `Discipline score: ${Math.round(score)}/100 — scattered across dimensions`;
      }
      return 'Trading discipline score pending';
    }
    case 'wart': {
      const composite = num(d.composite);
      const tier = d.tier as string | undefined;
      if (composite != null) {
        const sign = composite >= 0 ? '+' : '';
        return `Trader score: ${sign}${composite.toFixed(1)} WART${tier ? ` (${tier})` : ''}`;
      }
      return 'WART score pending (need 50+ trades)';
    }
    case 'ml-patterns-clustering': {
      const clustering = d.clustering as { clusters?: { label: string; avgPnl: number }[] } | undefined;
      const best = clustering?.clusters?.sort((a, b) => b.avgPnl - a.avgPnl)[0];
      if (best) return `Your best pattern: ${best.label} (avg $${Math.round(best.avgPnl)}/trade)`;
      return 'No distinct trading pattern clusters found';
    }
    case 'ml-patterns-anomaly': {
      const count = num(d.anomalyCount ?? d.anomalies?.length);
      if (count != null && count > 0) return `${count} anomalous trade${count === 1 ? '' : 's'} detected`;
      return 'No significant trade anomalies detected';
    }
    case 'ml-patterns-markov': {
      const markov = d.markov as { transitionProbabilities?: { winAfterWin: number; winAfterLoss: number } } | undefined;
      if (markov?.transitionProbabilities) {
        const diff = markov.transitionProbabilities.winAfterWin - markov.transitionProbabilities.winAfterLoss;
        const pct = Math.round(Math.abs(diff) * 100);
        if (diff > 0.02) return `Performance drops ${pct}% after a loss`;
        if (diff < -0.02) return `You recover well — win rate up ${pct}% after losses`;
        return 'Your outcomes are independent of prior results';
      }
      return 'Serial dependence analysis pending';
    }
    default:
      return insight.title;
  }
}

function firstTwoSentences(text: string): string {
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  return parts.slice(0, 2).join(' ').trim();
}

// ── Inline compact insight card (shown at top of each tab) ────────────────────

function InlineInsightCard({
  insight,
  onDigDeeper,
}: {
  insight: Insight;
  onDigDeeper?: (tab: TabId) => void;
}) {
  const style = SEVERITY_STYLE[insight.severity] ?? SEVERITY_STYLE.info;
  const tab = CATEGORY_TO_TAB[insight.category];
  const headline = deriveImpactHeadline(insight);

  return (
    <div className={`bg-[#161b22] border ${style.border} rounded-lg px-3 py-2.5 flex items-start gap-3`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-xs font-semibold text-white">{headline}</span>
          <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-widest font-medium bg-[#21262d] text-[#6e7681]">
            {CATEGORY_LABEL[insight.category] ?? insight.category}
          </span>
        </div>
        <p className="text-xs text-[#8b949e] leading-relaxed line-clamp-1">
          {firstTwoSentences(insight.description)}
        </p>
      </div>
      {tab && onDigDeeper && (
        <button
          onClick={() => onDigDeeper(tab)}
          className="shrink-0 text-xs text-[#6e7681] hover:text-[#8b949e] transition-colors whitespace-nowrap"
        >
          See all {CATEGORY_LABEL[insight.category] ?? insight.category} analysis →
        </button>
      )}
    </div>
  );
}

// ── Insight tier helpers ──────────────────────────────────────────────────────

function tierLabel(insight: Insight): string {
  const n = insight.sampleSize != null ? ` based on ${insight.sampleSize} trades` : '';
  switch (insight.tier) {
    case 'significant':  return `Strong evidence${n}`;
    case 'preliminary':  return 'Observed pattern — needs more data for certainty';
    case 'descriptive':  return 'Factual observation';
    case 'not_detected': return 'No pattern detected';
    default:
      return insight.isSignificant
        ? `Strong evidence${n}`
        : 'Observed pattern — needs more data for certainty';
  }
}

function deriveDollarEffect(insight: Insight): string | null {
  const d = insight.data as Record<string, any> | undefined;
  if (!d) return null;
  if (typeof d.meanDifference === 'number') {
    return `$${Math.abs(d.meanDifference).toFixed(2)} per trade`;
  }
  // Combinatorial search: top edge or weakness per-trade delta vs baseline
  const top = d.combinatorial?.topEdges?.[0] ?? d.combinatorial?.topWeaknesses?.[0];
  if (top && typeof top.avgPnl === 'number' && typeof top.overallAvgPnl === 'number') {
    const diff = top.avgPnl - top.overallAvgPnl;
    const sign = diff >= 0 ? '+' : '−';
    return `${sign}$${Math.abs(diff).toFixed(2)} avg per trade vs baseline`;
  }
  return null;
}

// ── Full insight card (Insights tab) ─────────────────────────────────────────

function FullInsightCard({
  insight,
  onDigDeeper,
}: {
  insight: Insight;
  onDigDeeper: (tab: TabId) => void;
}) {
  const style = SEVERITY_STYLE[insight.severity] ?? SEVERITY_STYLE.info;
  const tab = CATEGORY_TO_TAB[insight.category];
  const primary = insight.statistics?.[0];
  const pValue = primary?.pValue;
  const pStr = pValue != null
    ? (pValue < 0.001 ? 'p<0.001' : `p=${pValue.toFixed(3)}`)
    : null;
  const isSignif = insight.isSignificant;

  const [showStats, setShowStats] = useState(false);
  const headline = deriveImpactHeadline(insight);
  const body = firstTwoSentences(insight.description);
  const dollarEffect = deriveDollarEffect(insight);

  return (
    <div className={`bg-[#161b22] border ${style.border} rounded-lg p-4 flex flex-col gap-2 ${isSignif ? '' : 'opacity-75'}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold text-white">{headline}</span>
        <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-medium ${style.badge} ${style.badgeText}`}>
          {insight.severity}
        </span>
      </div>

      <p className="text-sm text-[#c9d1d9] leading-relaxed">{body}</p>

      {insight.suggestion && (
        <p className="text-xs text-[#8b949e] leading-relaxed">
          {insight.suggestion}
        </p>
      )}

      <div className="flex items-center gap-4 pt-1 flex-wrap">
        <button
          onClick={() => setShowStats((s) => !s)}
          className="text-xs text-[#6e7681] hover:text-[#c9d1d9] transition-colors"
        >
          {showStats ? 'Hide statistical details ▲' : 'Show statistical details ▼'}
        </button>
        {tab && (
          <button
            onClick={() => onDigDeeper(tab)}
            className="text-xs text-[#6e7681] hover:text-[#8b949e] transition-colors"
          >
            See all {CATEGORY_LABEL[insight.category] ?? insight.category} analysis →
          </button>
        )}
      </div>

      {showStats && (
        <div className="mt-1 pt-2 border-t border-[#21262d] space-y-1.5 text-xs text-[#8b949e]">
          <div className="flex flex-wrap gap-3">
            <span className="text-[#6e7681]">Module:</span>
            <span className="text-[#c9d1d9] font-mono">{insight.module}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <span className="text-[#6e7681]">Significance:</span>
            <span className={isSignif ? 'text-emerald-400' : 'text-[#6e7681]'}>
              {tierLabel(insight)}
            </span>
          </div>
          {insight.sampleSize != null && (
            <div className="flex flex-wrap gap-3">
              <span className="text-[#6e7681]">Sample size:</span>
              <span className="text-[#c9d1d9]">{insight.sampleSize} trades</span>
            </div>
          )}
          {primary?.testName && (
            <div className="flex flex-wrap gap-3">
              <span className="text-[#6e7681]">Test:</span>
              <span className="text-[#c9d1d9] font-mono">{primary.testName}</span>
            </div>
          )}
          {primary?.effectSize != null && (
            <div className="flex flex-wrap gap-3">
              <span className="text-[#6e7681]">Effect size:</span>
              <span className="text-[#c9d1d9]">{primary.effectSize.toFixed(3)}</span>
            </div>
          )}
          {dollarEffect && (
            <div className="flex flex-wrap gap-3">
              <span className="text-[#6e7681]">Effect:</span>
              <span className="text-[#c9d1d9]">{dollarEffect}</span>
            </div>
          )}
          <p className="text-[#8b949e] leading-relaxed pt-1">{insight.description}</p>
        </div>
      )}
    </div>
  );
}

// ── Tab Verdicts ──────────────────────────────────────────────────────────────
// 2-3 sentence summary at the top of each tab. Sourced from data the tab (or
// page) already fetches — insights, summary, regime breakdown, or a lazy
// tab-level fetch of walk-forward / Monte Carlo.

type VerdictTone = 'positive' | 'negative' | 'neutral';

function Verdict({
  tone,
  text,
  loading,
}: {
  tone: VerdictTone;
  text: string | null;
  loading?: boolean;
}) {
  const border =
    tone === 'positive' ? 'border-l-green-500/70' :
    tone === 'negative' ? 'border-l-red-500/70'   :
                          'border-l-blue-500/70';

  return (
    <div className={`bg-[#161b22] border border-[#21262d] border-l-2 ${border} rounded-lg px-4 py-3`}>
      {loading ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-3 w-2/3 bg-[#21262d] rounded" />
          <div className="h-3 w-1/2 bg-[#21262d] rounded" />
        </div>
      ) : (
        <p className="text-sm text-[#c9d1d9] leading-relaxed">{text ?? '—'}</p>
      )}
    </div>
  );
}

function regimeLabel(key: string): string {
  return key
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function buildPlaybookPhrase(
  playbooks: { id: string; name: string }[],
): string | null {
  // Playbook adherence data isn't currently surfaced via a shared API, so we
  // omit the adherence %. Brief allows us to drop the playbook clause
  // entirely when adherence isn't available.
  if (!playbooks.length) return null;
  return null;
}

function StrategyVerdict({
  regimeBreakdown,
  playbooks,
  journalId,
}: {
  regimeBreakdown: Record<string, any>;
  playbooks: { id: string; name: string }[];
  journalId?: string;
}) {
  const authFetch = useAuthFetch();
  const [wf, setWf] = useState<{
    expectancyTrend?: 'improving' | 'declining' | 'stable';
    winRateTrend?: 'improving' | 'declining' | 'stable';
    edgePersistent?: boolean;
  } | null>(null);
  const [wfLoading, setWfLoading] = useState(true);

  useEffect(() => {
    if (!journalId) return;
    setWfLoading(true);
    authFetch(`/api/analytics/walk-forward?journalId=${encodeURIComponent(journalId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWf(d && !d.error ? d : null))
      .catch(() => setWf(null))
      .finally(() => setWfLoading(false));
  }, [journalId, authFetch]);

  const qualifying = Object.entries(regimeBreakdown).filter(
    ([name, s]) => name !== 'unknown' && (s?.tradeCount ?? 0) >= 5,
  );
  const sorted = [...qualifying].sort(
    ([, a], [, b]) => (b.winRate ?? 0) - (a.winRate ?? 0),
  );
  const best = sorted[0];

  if (!best) {
    return <Verdict tone="neutral" text="Not enough trades across regimes yet for a strategy verdict." />;
  }

  const bestName = regimeLabel(best[0]);
  const bestWinPct = Math.round((best[1].winRate ?? 0) * 100);

  let trendPhrase: string;
  if (wfLoading) {
    trendPhrase = 'still being checked';
  } else if (wf?.expectancyTrend === 'improving') {
    trendPhrase = 'improving across recent windows';
  } else if (wf?.expectancyTrend === 'declining') {
    trendPhrase = 'weakening across recent windows';
  } else if (wf?.edgePersistent) {
    trendPhrase = 'holding steady across time';
  } else if (wf?.expectancyTrend === 'stable') {
    trendPhrase = 'stable across time windows';
  } else {
    trendPhrase = 'not yet durable across windows';
  }

  const playbookPhrase = buildPlaybookPhrase(playbooks);
  const expTrendTone: VerdictTone =
    wf?.expectancyTrend === 'declining' ? 'negative' :
    wf?.expectancyTrend === 'improving' || wf?.edgePersistent ? 'positive' :
    'neutral';

  const text = [
    `Your best regime is ${bestName} (${bestWinPct}% win rate).`,
    `Your edge is ${trendPhrase}.`,
    playbookPhrase,
  ]
    .filter(Boolean)
    .join(' ');

  return <Verdict tone={expTrendTone} text={text} loading={wfLoading && !wf} />;
}

function ExecutionVerdict({
  insights,
  tradeCount,
}: {
  insights: Insight[];
  tradeCount: number;
}) {
  const exitInsight = insights.find((i) => i.module === 'exit-optimizer');
  const effPct = typeof exitInsight?.data?.avgEfficiency === 'number'
    ? Math.round((exitInsight.data.avgEfficiency as number) * 100)
    : null;
  const moneyLeft = typeof exitInsight?.data?.totalLeftOnTable === 'number'
    ? Math.round(exitInsight.data.totalLeftOnTable as number)
    : null;

  const timeInsight = insights.find((i) => i.module === 'time-of-day-edge');
  const bestHour = typeof timeInsight?.data?.bestHour === 'number'
    ? (timeInsight.data.bestHour as number)
    : null;

  const parts: string[] = [];
  if (effPct != null && moneyLeft != null) {
    parts.push(
      `You capture ${effPct}% of available profit, leaving $${moneyLeft.toLocaleString()} on the table across ${tradeCount || (exitInsight?.data?.tradeCount ?? 0)} trades.`,
    );
  } else if (effPct != null) {
    parts.push(`You capture ${effPct}% of available profit across ${tradeCount} trades.`);
  }
  if (bestHour != null) {
    parts.push(`Your best entry time is ${String(bestHour).padStart(2, '0')}:00.`);
  }

  const text = parts.join(' ');
  const tone: VerdictTone = effPct != null && effPct < 40 ? 'negative' : 'neutral';

  return <Verdict tone={tone} text={text || 'Execution verdict will appear once exit and timing data are computed.'} />;
}

function RiskVerdict({
  sharpeRatio,
  drawdownAnalysis,
  journalId,
}: {
  sharpeRatio: number | null;
  drawdownAnalysis: DrawdownAnalysis | null;
  journalId?: string;
}) {
  const authFetch = useAuthFetch();
  const [mc, setMc] = useState<{ probDrawdown25?: number } | null>(null);
  const [mcLoading, setMcLoading] = useState(true);

  useEffect(() => {
    if (!journalId) return;
    setMcLoading(true);
    authFetch(`/api/analytics/monte-carlo?journalId=${encodeURIComponent(journalId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMc(d && !d.error ? d : null))
      .catch(() => setMc(null))
      .finally(() => setMcLoading(false));
  }, [journalId, authFetch]);

  const sharpeStr = sharpeRatio != null ? sharpeRatio.toFixed(2) : '—';
  const dd25Pct = mc?.probDrawdown25 != null ? Math.round(mc.probDrawdown25 * 100) : null;

  let drawdownSentence: string;
  if (drawdownAnalysis && drawdownAnalysis.currentDrawdownDuration > 0) {
    drawdownSentence = `You are ${Math.round(drawdownAnalysis.currentDrawdownDuration)} day${drawdownAnalysis.currentDrawdownDuration >= 1.5 ? 's' : ''} into a drawdown.`;
  } else {
    drawdownSentence = 'You are at your equity high.';
  }

  const parts: string[] = [];
  parts.push(`Your Sharpe ratio is ${sharpeStr}.`);
  if (dd25Pct != null) {
    parts.push(`There is a ${dd25Pct}% chance of a 25% drawdown over your next 100 trades.`);
  }
  parts.push(drawdownSentence);

  const tone: VerdictTone =
    (sharpeRatio != null && sharpeRatio < 0.3) ||
    (dd25Pct != null && dd25Pct > 30)
      ? 'negative'
      : (sharpeRatio != null && sharpeRatio >= 1.0)
        ? 'positive'
        : 'neutral';

  return (
    <Verdict tone={tone} text={parts.join(' ')} loading={mcLoading && !mc} />
  );
}

function PsychologyVerdict({ insights }: { insights: Insight[] }) {
  const tilt = insights.find((i) => i.module === 'tilt-episodes');
  const tof  = insights.find((i) => i.module === 'time-of-day-edge');
  const mlm  = insights.find((i) => i.module === 'ml-patterns-markov');

  const tiltEpisodes = (tilt?.data?.totalEpisodes as number | undefined) ?? 0;
  const tiltCost = tilt?.data?.counterfactualImprovement as number | undefined;

  const tiltStatement = tiltEpisodes > 0
    ? `${tiltEpisodes} tilt episode${tiltEpisodes === 1 ? '' : 's'} detected${
        tiltCost != null && tiltCost > 0 ? `, costing ~$${Math.round(tiltCost).toLocaleString()}` : ''
      }.`
    : 'No tilt episodes detected.';

  const fatigue = tof?.data?.fatigue as { optimalCutoff?: number } | null | undefined;
  const fatigueStatement = fatigue?.optimalCutoff != null
    ? `Performance drops after trade #${fatigue.optimalCutoff}.`
    : null;

  const markov = mlm?.data?.markov as
    | { transitionProbabilities: { winAfterWin: number; winAfterLoss: number } }
    | undefined;

  let postLossPhrase: string | null = null;
  if (markov) {
    const diff = markov.transitionProbabilities.winAfterWin - markov.transitionProbabilities.winAfterLoss;
    const winAfterWin = Math.round(markov.transitionProbabilities.winAfterWin * 100);
    const winAfterLoss = Math.round(markov.transitionProbabilities.winAfterLoss * 100);
    postLossPhrase = diff > 0.02
      ? `After a loss, your win rate drops to ${winAfterLoss}% (vs ${winAfterWin}% after a win) — losses hurt your next trade.`
      : diff < -0.02
        ? `After a loss, your win rate rises to ${winAfterLoss}% (vs ${winAfterWin}% after a win) — you recover well.`
        : 'Your outcomes are independent of prior results.';
  }

  const parts = [tiltStatement, fatigueStatement, postLossPhrase].filter(Boolean);
  const text = parts.join(' ');
  const tone: VerdictTone = tiltEpisodes > 0 || fatigue?.optimalCutoff != null ? 'negative' : 'neutral';

  return <Verdict tone={tone} text={text || 'Psychology verdict will appear once behavioral analytics are computed.'} />;
}

function InsightsVerdict({
  insights,
  tradeCount,
}: {
  insights: Insight[];
  tradeCount: number;
}) {
  const actionable = insights.filter(
    (i) => i.tier === 'significant' || i.tier === 'descriptive',
  ).length;
  const preliminary = insights.filter((i) => i.tier === 'preliminary').length;
  const text = `${actionable} confirmed finding${actionable === 1 ? '' : 's'}, ${preliminary} observed pattern${preliminary === 1 ? '' : 's'}${preliminary > 0 ? ' (need more data for certainty)' : ''} across ${tradeCount} trades`;
  return <Verdict tone="neutral" text={text} />;
}

// ── Narrative Hero (Overview) ─────────────────────────────────────────────────

const NARRATIVE_CARD_STYLES: Record<
  'leak' | 'strength' | 'focus',
  { bg: string; border: string; title: string; titleText: string; icon: string }
> = {
  leak: {
    bg:        'bg-red-900/20',
    border:    'border-red-800/40',
    title:     'BIGGEST LEAK',
    titleText: 'text-red-300',
    icon:      '🔴',
  },
  strength: {
    bg:        'bg-green-900/20',
    border:    'border-green-800/40',
    title:     'BIGGEST STRENGTH',
    titleText: 'text-green-300',
    icon:      '🟢',
  },
  focus: {
    bg:        'bg-yellow-900/20',
    border:    'border-yellow-800/40',
    title:     'FOCUS THIS WEEK',
    titleText: 'text-yellow-300',
    icon:      '⚠️',
  },
};

function tabLabelFor(tab: TabId): string {
  return TABS.find((t) => t.id === tab)?.label ?? tab;
}

function NarrativeCard({
  kind,
  theme,
  body,
  onSwitchTab,
}: {
  kind: 'leak' | 'strength' | 'focus';
  theme: ConvergentTheme;
  body: React.ReactNode;
  onSwitchTab: (tab: TabId) => void;
}) {
  const s = NARRATIVE_CARD_STYLES[kind];
  return (
    <button
      type="button"
      onClick={() => onSwitchTab(theme.tabLink as TabId)}
      className={`${s.bg} ${s.border} border rounded-lg px-4 py-2 text-left hover:brightness-125 transition-colors w-full h-full`}
    >
      <div className={`flex items-center gap-2 text-[11px] uppercase tracking-widest ${s.titleText} mb-2`}>
        <span aria-hidden>{s.icon}</span>
        <span>{s.title}</span>
      </div>
      <div className="text-sm font-semibold text-white mb-1">{theme.headline}</div>
      <div className="text-sm text-[#c9d1d9] leading-relaxed">{body}</div>
      <div className="mt-2 text-xs text-[#8b949e]">→ {tabLabelFor(theme.tabLink as TabId)}</div>
    </button>
  );
}

function NarrativeHero({
  convergence,
  onSwitchTab,
}: {
  convergence: ConvergenceResult;
  onSwitchTab: (tab: TabId) => void;
}) {
  const { biggestLeak, biggestStrength, weeklyFocus } = convergence;

  return (
    <div className="space-y-3">
      <div className="text-[11px] uppercase tracking-widest text-[#6e7681]">
        Your trading in 30 seconds
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {biggestLeak && (
          <NarrativeCard
            kind="leak"
            theme={biggestLeak}
            body={twoSentences(biggestLeak.diagnosis)}
            onSwitchTab={onSwitchTab}
          />
        )}
        {biggestStrength && (
          <NarrativeCard
            kind="strength"
            theme={biggestStrength}
            body={twoSentences(biggestStrength.diagnosis)}
            onSwitchTab={onSwitchTab}
          />
        )}
        {weeklyFocus && (
          <NarrativeCard
            kind="focus"
            theme={weeklyFocus}
            body={
              <>
                <div>{weeklyFocus.prescription}</div>
                {weeklyFocus.expectedImpact && (
                  <div className="mt-1.5 text-xs text-[#8b949e]">
                    Expected impact: {weeklyFocus.expectedImpact}
                  </div>
                )}
              </>
            }
            onSwitchTab={onSwitchTab}
          />
        )}
      </div>
    </div>
  );
}

/** Grab the first two sentences of a diagnosis for card body copy. */
function twoSentences(text: string): string {
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  return parts.slice(0, 2).join(' ').trim();
}

// ── NarrativeSection ─────────────────────────────────────────────────────────

interface NarrativeSectionProps {
  question: string;
  verdict: string;
  evidence: React.ReactNode;
  implication: string;
  details?: React.ReactNode;
}

function NarrativeSection({ question, verdict, evidence, implication, details }: NarrativeSectionProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mb-4">
      <h3 className="text-sm text-[#8b949e] uppercase mb-1">{question}</h3>
      <p className="text-[#e6edf3] text-lg mb-3">{verdict}</p>
      <div className="mb-3">{evidence}</div>
      <p className="text-[#8b949e] text-sm italic mb-2">💡 {implication}</p>
      {details && (
        <button onClick={() => setExpanded(!expanded)} className="text-[#1f6feb] text-sm">
          {expanded ? '▼ Hide details' : '▸ Show details'}
        </button>
      )}
      {expanded && <div className="mt-3">{details}</div>}
    </div>
  );
}

const NO_DATA_VERDICT = 'Not enough data for this analysis yet. Keep trading!';

// ── Tab: Overview ─────────────────────────────────────────────────────────────

function OverviewTab({
  wartResult,
  eloResult,
  sharpeRatio,
  insights,
  convergence,
  onSwitchTab,
}: {
  wartResult: WartResult | null;
  eloResult: EloResult | null;
  sharpeRatio: number | null;
  insights: Insight[];
  convergence: ConvergenceResult | null;
  onSwitchTab: (tab: TabId) => void;
}) {
  const top3 = pickTop3(insights);

  const SUMMARY_TABS: { id: TabId; label: string }[] = [
    { id: 'strategy',   label: 'Strategy' },
    { id: 'execution',  label: 'Execution' },
    { id: 'risk',       label: 'Risk' },
    { id: 'psychology', label: 'Psychology' },
  ];

  const hasNarrative =
    convergence != null &&
    !convergence.insufficientData &&
    (convergence.biggestLeak || convergence.biggestStrength || convergence.weeklyFocus);

  return (
    <div className="space-y-4">
      {/* Narrative hero: BIGGEST LEAK / STRENGTH / FOCUS THIS WEEK */}
      {hasNarrative && (
        <NarrativeHero convergence={convergence!} onSwitchTab={onSwitchTab} />
      )}

      {/* WART / Elo / Sharpe — secondary context row (always shown when available) */}
      {hasNarrative && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-sm text-[#8b949e]">
          {wartResult && (
            <span>
              <span className="text-[10px] uppercase tracking-widest text-[#6e7681] mr-1.5">WART</span>
              <span className={wartColor(wartResult.composite)}>
                {wartResult.composite >= 0 ? '+' : ''}{wartResult.composite.toFixed(1)}
              </span>
              <span className="text-[#6e7681] ml-1">({wartResult.tier})</span>
            </span>
          )}
          {eloResult && (
            <span>
              <span className="text-[10px] uppercase tracking-widest text-[#6e7681] mr-1.5">Elo</span>
              <span className={eloColor(eloResult.currentElo)}>{Math.round(eloResult.currentElo)}</span>
              <span className="text-[#6e7681] ml-1">({eloResult.tier})</span>
            </span>
          )}
          {sharpeRatio != null && (
            <span>
              <span className="text-[10px] uppercase tracking-widest text-[#6e7681] mr-1.5">Sharpe</span>
              <span className="text-white">{sharpeRatio.toFixed(2)}</span>
            </span>
          )}
        </div>
      )}

      {/* Top row: WART radar + Elo card */}
      <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-start">
        {/* Compact WART radar */}
        <div className="flex flex-col items-center">
          {wartResult ? (
            <>
              <div style={{ width: 170, height: 153 }}>
                <WartRadar wart={wartResult} compact />
              </div>
              <div className={`text-xl font-bold mt-1 ${wartColor(wartResult.composite)}`}>
                {wartResult.composite >= 0 ? '+' : ''}{wartResult.composite.toFixed(1)}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">{wartResult.tier}</div>
            </>
          ) : (
            <div className="w-[170px] h-[153px] flex items-center justify-center">
              <p className="text-xs text-[#4a5568] italic text-center px-2">
                Need 50+ trades for WART
              </p>
            </div>
          )}
        </div>

        {/* Right column: Elo card + top 3 insights */}
        <div className="space-y-3">
          {/* Elo card */}
          {eloResult ? (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3 flex items-center gap-6">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">Elo Rating</div>
                <div className={`text-2xl font-bold ${eloColor(eloResult.currentElo)}`}>
                  {Math.round(eloResult.currentElo)}
                  <span className="text-sm ml-1.5 text-[#6e7681]">{trendArrow(eloResult.recentTrend)}</span>
                </div>
                <div className="text-xs text-[#6e7681]">{eloResult.tier}</div>
              </div>
              <div className="border-l border-[#21262d] pl-6">
                <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">Peak</div>
                <div className="text-sm font-medium text-white">{Math.round(eloResult.peakElo)}</div>
              </div>
              <div className="border-l border-[#21262d] pl-6">
                <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">Trades</div>
                <div className="text-sm font-medium text-white">{eloResult.tradeCount}</div>
              </div>
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
              <p className="text-xs text-[#4a5568] italic">Elo rating not yet available.</p>
            </div>
          )}

          {/* Top 3 insights as compact one-liners */}
          {top3.length > 0 ? (
            <div className="space-y-1.5">
              {top3.map((insight, i) => (
                <InlineInsightCard
                  key={`${insight.module}-${i}`}
                  insight={insight}
                  onDigDeeper={onSwitchTab}
                />
              ))}
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
              <p className="text-xs text-[#4a5568] italic">
                No insights yet — analytics run automatically after trades are imported.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Quick category summaries */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-[#21262d]">
          <span className="text-[10px] uppercase tracking-widest text-[#6e7681]">Quick Summary</span>
        </div>
        <div className="divide-y divide-[#21262d]">
          {SUMMARY_TABS.map(({ id, label }) => {
            const summary = getCategoryOneliner(id, insights);
            return (
              <button
                key={id}
                onClick={() => onSwitchTab(id)}
                className="w-full flex items-baseline gap-3 text-left px-4 py-2.5 hover:bg-[#1c2128] transition-colors group"
              >
                <span className="text-[10px] uppercase tracking-widest text-[#6e7681] shrink-0 w-20">
                  {label}
                </span>
                {summary ? (
                  <span className="text-xs text-[#8b949e] group-hover:text-white transition-colors leading-relaxed">
                    {summary}
                  </span>
                ) : (
                  <span className="text-xs text-[#4a5568] italic">Not enough data yet</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Tab: Execution ────────────────────────────────────────────────────────────

function ExecutionTab({
  chartProps,
  insights,
  tradeCount,
  missingExitMetricsCount,
  onSwitchTab,
  onRunDeepAnalysis,
  runningDeepAnalysis,
}: {
  chartProps: any;
  insights: Insight[];
  tradeCount: number;
  missingExitMetricsCount: number;
  onSwitchTab: (tab: TabId) => void;
  onRunDeepAnalysis: () => void;
  runningDeepAnalysis: boolean;
}) {
  const timeInsight = insights.find((i) => i.module === 'time-of-day-edge');
  const [exitSummary, setExitSummary] = useState<ExitSummary | null>(null);

  // Exit quality metrics derived from ExitAnalysis component (same data source as the summary)
  const effPct = exitSummary != null ? parseFloat(exitSummary.avgEff) : null;
  const moneyLeft = exitSummary != null ? parseFloat(exitSummary.totalLeft) : null;
  const exitCount = exitSummary?.tradeCount ?? 0;

  // Timing metrics
  const bestHour = typeof timeInsight?.data?.bestHour === 'number'
    ? (timeInsight.data.bestHour as number)
    : null;
  const fatigue = timeInsight?.data?.fatigue as
    | { estimatedSavings?: number; optimalCutoff?: number }
    | null
    | undefined;

  // Exit quality verdict & implication — derived from exitSummary (same data as ExitAnalysis summary paragraph)
  let exitVerdict: string;
  if (exitSummary != null && moneyLeft != null && moneyLeft > 0) {
    exitVerdict = `You capture ${exitSummary.avgEff}% of available moves, leaving $${Number(exitSummary.totalLeft).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} on the table across ${exitCount} trades.`;
  } else if (exitSummary != null) {
    exitVerdict = `You capture ${exitSummary.avgEff}% of available profit across ${exitCount} trades.`;
  } else {
    exitVerdict = NO_DATA_VERDICT;
  }

  let exitImplication: string;
  if (effPct == null) {
    exitImplication = 'Run deep analysis to compute exit efficiency.';
  } else if (effPct < 40) {
    exitImplication = 'You exit winners too early. Consider trailing stops or scaling out.';
  } else if (effPct < 60) {
    exitImplication = 'Decent capture rate. Look at your biggest MFE gaps for improvement opportunities.';
  } else {
    exitImplication = 'Strong exit discipline. Your entries and exits are well-timed.';
  }

  // Timing verdict & implication
  let timingVerdict: string;
  if (bestHour != null) {
    timingVerdict = `Your best hour is ${String(bestHour).padStart(2, '0')}:00.`;
  } else {
    timingVerdict = NO_DATA_VERDICT;
  }

  let timingImplication: string;
  if (fatigue?.estimatedSavings && fatigue.estimatedSavings > 0) {
    timingImplication = `Session fatigue is costing you $${Math.round(fatigue.estimatedSavings).toLocaleString()}. Consider stopping earlier in your sessions.`;
  } else if (bestHour != null) {
    timingImplication = 'Your performance is consistent across trading hours — no timing edge detected.';
  } else {
    timingImplication = 'Not enough data yet to identify timing patterns.';
  }

  return (
    <div className="space-y-2">
      {missingExitMetricsCount > 0 && (
        <div className="flex items-center justify-between bg-[#1c2128] border border-[#30363d] rounded-lg px-4 py-2.5 mb-4">
          <span className="text-sm text-[#8b949e]">
            {missingExitMetricsCount} position{missingExitMetricsCount === 1 ? '' : 's'} missing exit analysis.
          </span>
          <button
            onClick={onRunDeepAnalysis}
            disabled={runningDeepAnalysis}
            className="text-xs px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-[#8b949e] hover:text-white rounded transition-colors shrink-0 ml-4 disabled:opacity-50"
          >
            {runningDeepAnalysis ? 'Running…' : 'Run deep analysis'}
          </button>
        </div>
      )}
      <NarrativeSection
        question="Are you capturing enough profit?"
        verdict={exitVerdict}
        evidence={<ExitAnalysis {...chartProps} onSummary={setExitSummary} />}
        implication={exitImplication}
      />
      <NarrativeSection
        question="When do you trade best?"
        verdict={timingVerdict}
        evidence={<TimeAnalysis {...chartProps} />}
        implication={timingImplication}
        details={<CalendarHeatmap {...chartProps} />}
      />
    </div>
  );
}

// ── Tab: Psychology ───────────────────────────────────────────────────────────

function PsychologyTab({
  insights,
  onSwitchTab,
  entropyResult,
  behaviorPositions,
  equitySeries,
}: {
  insights: Insight[];
  onSwitchTab: (tab: TabId) => void;
  entropyResult: EntropyResult | null;
  behaviorPositions: BehaviorPosition[];
  equitySeries: { date: string; cumulativePnl: number }[];
}) {
  const psychologyInsights = getInlineInsights('psychology', insights, 10);

  // Extract Markov data
  const markovInsight = insights.find((i) => i.module === 'ml-patterns-markov');
  const markovData = markovInsight?.data?.markov as MarkovData | undefined;

  // Extract tilt episode data
  const tiltInsight = insights.find((i) => i.module === 'tilt-episodes');
  const tiltEpisodeList = (tiltInsight?.data?.episodes as TiltEpisode[] | undefined) ?? [];
  const totalEpisodes = (tiltInsight?.data?.totalEpisodes as number | undefined) ?? 0;
  const counterfactualImprovement =
    (tiltInsight?.data?.counterfactualImprovement as number | undefined) ?? 0;

  // Fatigue data (from time-of-day insight)
  const timeInsight = insights.find((i) => i.module === 'time-of-day-edge');
  const fatigue = timeInsight?.data?.fatigue as
    | { estimatedSavings?: number; optimalCutoff?: number }
    | null
    | undefined;

  // ── Section 1: DISCIPLINE ────────────────────────────────────────────────
  let disciplineVerdict: string;
  if (entropyResult != null) {
    const score = Math.round(entropyResult.compositeScore);
    const desc =
      score >= 65
        ? 'is highly consistent'
        : score >= 40
          ? 'shows moderate consistency'
          : 'is scattered across patterns';
    disciplineVerdict = `Discipline score: ${score}/100. Your trading ${desc}.`;
  } else {
    disciplineVerdict = NO_DATA_VERDICT;
  }

  let disciplineImplication: string;
  if (markovData) {
    const diff =
      markovData.transitionProbabilities.winAfterWin -
      markovData.transitionProbabilities.winAfterLoss;
    const winAfterWinPct = Math.round(markovData.transitionProbabilities.winAfterWin * 100);
    const winAfterLossPct = Math.round(markovData.transitionProbabilities.winAfterLoss * 100);
    const markovConfidence = markovInsight?.tier === 'significant'
      ? ` Strong evidence${markovInsight.sampleSize != null ? ` based on ${markovInsight.sampleSize} trades` : ''}.`
      : markovInsight?.tier === 'preliminary'
        ? ' Observed pattern — needs more data for certainty.'
        : '';
    if (diff > 0.02) {
      disciplineImplication = `Your win rate drops from ${winAfterWinPct}% to ${winAfterLossPct}% after a loss — consider pausing after losing trades.${markovConfidence}`;
    } else if (diff < -0.02) {
      disciplineImplication = `Your win rate rises to ${winAfterLossPct}% after a loss vs ${winAfterWinPct}% after a win — you recover well.${markovConfidence}`;
    } else {
      disciplineImplication = 'Your outcomes are independent of prior results — no tilt pattern detected.';
    }
  } else if (entropyResult != null) {
    const score = Math.round(entropyResult.compositeScore);
    disciplineImplication =
      score >= 65
        ? 'Your trading discipline is strong. Keep following your rules.'
        : score >= 40
          ? 'Review your rule adherence — consistency still has room to improve.'
          : 'Your trading lacks consistency. Focus on following a structured plan.';
  } else {
    disciplineImplication = 'Not enough data yet to assess discipline patterns.';
  }

  // ── Section 2: EMOTIONAL PATTERNS ───────────────────────────────────────
  let tiltVerdict: string;
  if (tiltInsight != null) {
    tiltVerdict =
      totalEpisodes > 0
        ? `${totalEpisodes} tilt episode${totalEpisodes === 1 ? '' : 's'} detected, costing approximately $${Math.round(counterfactualImprovement).toLocaleString()}.`
        : 'No significant tilt episodes detected — your emotional state appears stable.';
  } else {
    tiltVerdict = NO_DATA_VERDICT;
  }

  let tiltImplication: string;
  if (totalEpisodes > 0 && counterfactualImprovement > 0) {
    tiltImplication = `Pausing during these periods would have improved your P&L by $${Math.round(counterfactualImprovement).toLocaleString()}.`;
  } else if (tiltInsight != null) {
    tiltImplication = 'No significant tilt episodes detected — your emotional state appears stable.';
  } else {
    tiltImplication = 'Not enough data yet to identify emotional patterns.';
  }

  // ── Section 3: SESSION MANAGEMENT ───────────────────────────────────────
  const cutoff = fatigue?.optimalCutoff ?? null;
  const savings = fatigue?.estimatedSavings ?? null;

  let sessionVerdict: string;
  if (cutoff != null) {
    sessionVerdict = `Performance peaks at trade #${cutoff}. After that, average P&L drops.`;
  } else {
    sessionVerdict = NO_DATA_VERDICT;
  }

  let sessionImplication: string;
  if (cutoff != null && savings != null && savings > 0) {
    sessionImplication = `Consider stopping after ${cutoff} trades per session — estimated savings of $${Math.round(savings).toLocaleString()} per session.`;
  } else if (cutoff != null) {
    sessionImplication = `Consider stopping after ${cutoff} trades per session.`;
  } else {
    sessionImplication =
      'No session fatigue detected. Your performance is consistent throughout trading sessions.';
  }

  return (
    <div className="space-y-2">
      <NarrativeSection
        question="How consistent is your behavior?"
        verdict={disciplineVerdict}
        evidence={
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
              {entropyResult ? (
                <DisciplineGauge
                  compositeScore={entropyResult.compositeScore}
                  rollingSeries={entropyResult.rollingSeries}
                />
              ) : (
                <div className="flex items-center justify-center h-[180px] text-xs text-[#4a5568] italic">
                  Discipline score not yet computed
                </div>
              )}
            </div>
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
              {markovData ? (
                <MarkovBars
                  winAfterWin={markovData.transitionProbabilities.winAfterWin}
                  winAfterLoss={markovData.transitionProbabilities.winAfterLoss}
                  overallWinRate={markovData.overallWinRate}
                  pValue={markovData.independenceTest?.pValue ?? null}
                  isSignificant={markovData.independenceTest?.isSignificant ?? false}
                />
              ) : (
                <div className="flex items-center justify-center h-[180px] text-xs text-[#4a5568] italic">
                  Markov analysis not yet computed
                </div>
              )}
            </div>
          </div>
        }
        implication={disciplineImplication}
        details={<OutcomeSerialDependence />}
      />
      <NarrativeSection
        question="Are your emotions costing you money?"
        verdict={tiltVerdict}
        evidence={
          <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
            <TiltEquityCurve
              series={equitySeries}
              episodes={tiltEpisodeList}
              totalEpisodes={totalEpisodes}
              counterfactualImprovement={counterfactualImprovement}
            />
          </div>
        }
        implication={tiltImplication}
        details={
          <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
            <SizeAfterOutcomeScatter positions={behaviorPositions} />
          </div>
        }
      />
      <NarrativeSection
        question="Are you overtrading?"
        verdict={sessionVerdict}
        evidence={
          <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
            <SessionDecayChart positions={behaviorPositions} />
          </div>
        }
        implication={sessionImplication}
        details={
          psychologyInsights.length > 0 ? (
            <div className="space-y-2">
              {psychologyInsights.map((ins, i) => (
                <FullInsightCard key={`${ins.module}-${i}`} insight={ins} onDigDeeper={onSwitchTab} />
              ))}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

// ── Tab: Strategy ─────────────────────────────────────────────────────────────

function StrategyTab({
  chartProps,
  insights,
  regimeBreakdown,
  onSwitchTab,
  combinatorialResult,
  playbooks,
}: {
  chartProps: any;
  insights: Insight[];
  regimeBreakdown: Record<string, any>;
  onSwitchTab: (tab: TabId) => void;
  combinatorialResult: CombinatorialSearchResult | null;
  playbooks: { id: string; name: string }[];
}) {
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [edgeFinderExpanded, setEdgeFinderExpanded] = useState(true);

  // Walk-forward data (same call as StrategyVerdict, lifted to tab level)
  const authFetch = useAuthFetch();
  const [wf, setWf] = useState<{
    expectancyTrend?: 'improving' | 'declining' | 'stable';
    winRateTrend?: 'improving' | 'declining' | 'stable';
    edgePersistent?: boolean;
    windows?: { expectancy: number; winRate: number }[];
  } | null>(null);
  const [wfLoading, setWfLoading] = useState(true);

  useEffect(() => {
    if (!chartProps.journalId) return;
    setWfLoading(true);
    authFetch(`/api/analytics/walk-forward?journalId=${encodeURIComponent(chartProps.journalId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWf(d && !d.error ? d : null))
      .catch(() => setWf(null))
      .finally(() => setWfLoading(false));
  }, [chartProps.journalId, authFetch]);

  // ── Section 1: YOUR STRATEGIES ────────────────────────────────────────────
  const clusteringInsight = insights.find((i) => i.module === 'ml-patterns-clustering');
  const clusters = (
    clusteringInsight?.data?.clustering as
      | { clusters?: { label: string; avgPnl: number }[] }
      | undefined
  )?.clusters;
  const sortedClusters = clusters ? [...clusters].sort((a, b) => b.avgPnl - a.avgPnl) : null;
  const bestCluster = sortedClusters?.[0];
  const worstCluster = sortedClusters?.[sortedClusters.length - 1];

  let strategyVerdict: string;
  if (playbooks.length > 0) {
    strategyVerdict = `You have ${playbooks.length} defined strateg${playbooks.length === 1 ? 'y' : 'ies'}. Compare performance in the chart below.`;
  } else if (bestCluster && bestCluster.avgPnl > 0) {
    strategyVerdict = `Your best pattern is "${bestCluster.label}" averaging $${Math.round(bestCluster.avgPnl)} per trade. Define strategies on the Playbooks page for deeper analysis.`;
  } else {
    strategyVerdict =
      'Performance by trade type is shown below. Define strategies on the Playbooks page for deeper analysis.';
  }

  let strategyImplication: string;
  if (bestCluster && worstCluster && bestCluster.label !== worstCluster.label) {
    const diff = bestCluster.avgPnl - worstCluster.avgPnl;
    if (diff > 50) {
      strategyImplication = `Focus on "${bestCluster.label}". Consider pausing "${worstCluster.label}" — it underperforms by $${Math.round(diff)} per trade.`;
    } else {
      strategyImplication =
        'Your strategies perform similarly. The difference may not be meaningful yet.';
    }
  } else if (playbooks.length === 0) {
    strategyImplication =
      'Define strategies on the Playbooks page for deeper per-strategy analysis.';
  } else {
    strategyImplication = 'Review your playbook performance and double down on what works.';
  }

  // ── Section 2: IS YOUR EDGE PERSISTENT? ──────────────────────────────────
  let wfVerdict: string;
  let wfImplication: string;

  if (wfLoading) {
    wfVerdict = 'Checking edge persistence…';
    wfImplication = '';
  } else if (wf == null) {
    wfVerdict = NO_DATA_VERDICT;
    wfImplication = 'Not enough trades yet for walk-forward analysis.';
  } else {
    const trend = wf.expectancyTrend ?? (wf.edgePersistent ? 'stable' : 'stable');
    const trendWord =
      trend === 'improving' ? 'improving' : trend === 'declining' ? 'declining' : 'stable';

    // Expectancy delta across windows if available
    let changePhrase = '';
    const wins = wf.windows;
    if (wins && wins.length >= 2) {
      const first = wins[0].expectancy;
      const last = wins[wins.length - 1].expectancy;
      if (first !== 0) {
        const fmt = (v: number) => v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
        const dir = last > first ? 'improved' : 'dropped';
        changePhrase = ` Early trades averaged ${fmt(first)} per trade; recent trades average ${fmt(last)} — expectancy ${dir}.`;
      }
    }

    wfVerdict = `Your performance is ${trendWord}.${changePhrase}`;
    const wfConfidence = wins && wins.length >= 5
      ? ' Strong evidence across multiple time windows.'
      : wins && wins.length >= 3
        ? ' Observed pattern — needs more windows for certainty.'
        : '';
    wfImplication =
      trend === 'improving'
        ? `Your skills are developing. Study what changed in your recent trades.${wfConfidence}`
        : trend === 'declining'
          ? `Your edge may be decaying. Review whether market conditions have shifted.${wfConfidence}`
          : `Consistent performance — your approach is robust across time.${wfConfidence}`;
  }

  // ── Section 3: MARKET CONDITIONS ─────────────────────────────────────────
  const qualifying = Object.entries(regimeBreakdown).filter(
    ([name, s]) => name !== 'unknown' && (s?.tradeCount ?? 0) >= 5,
  );
  const sortedRegimes = [...qualifying].sort(
    ([, a], [, b]) => (b.winRate ?? 0) - (a.winRate ?? 0),
  );
  const bestRegime = sortedRegimes[0];
  const worstRegime = sortedRegimes[sortedRegimes.length - 1];
  const totalRegimeTrades = qualifying.reduce((sum, [, s]) => sum + (s?.tradeCount ?? 0), 0);

  let regimeVerdict: string;
  let regimeImplication: string;

  if (bestRegime && worstRegime && bestRegime[0] !== worstRegime[0]) {
    const bestWR = Math.round((bestRegime[1].winRate ?? 0) * 100);
    const worstWR = Math.round((worstRegime[1].winRate ?? 0) * 100);
    const worstPct =
      totalRegimeTrades > 0
        ? Math.round(((worstRegime[1].tradeCount ?? 0) / totalRegimeTrades) * 100)
        : 0;
    regimeVerdict = `You thrive in ${regimeLabel(bestRegime[0])} (${bestWR}% win rate) but struggle in ${regimeLabel(worstRegime[0])} (${worstWR}% win rate). ${worstPct}% of your trades are in your worst regime.`;

    const worstPnl = worstRegime[1].totalPnl as number | undefined;
    if (worstPct > 20 && worstPnl != null && worstPnl < 0) {
      regimeImplication = `Reducing ${regimeLabel(worstRegime[0])} trades would have saved $${Math.round(Math.abs(worstPnl)).toLocaleString()}. Consider sitting out when BTC conditions shift to ${regimeLabel(worstRegime[0])}.`;
    } else {
      regimeImplication = 'You adapt well to different conditions.';
    }
  } else if (bestRegime) {
    regimeVerdict = `Your best regime is ${regimeLabel(bestRegime[0])} (${Math.round((bestRegime[1].winRate ?? 0) * 100)}% win rate).`;
    regimeImplication = 'Not enough data across different regimes to compare performance yet.';
  } else {
    regimeVerdict = NO_DATA_VERDICT;
    regimeImplication = 'Trade more to see how market conditions affect your performance.';
  }

  return (
    <div className="space-y-2">
      <NarrativeSection
        question="Which strategies work?"
        verdict={strategyVerdict}
        evidence={
          <>
            {playbooks.length === 0 && (
              <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3 text-sm text-[#8b949e] mb-3">
                You haven&apos;t defined any strategies yet. Below is your performance by
                auto-detected trade type.{' '}
                <a href="/playbooks" className="text-blue-400 hover:text-blue-300 transition-colors">
                  → Create strategies on the Playbooks page
                </a>
              </div>
            )}
            <StrategyBreakdown {...chartProps} />
          </>
        }
        implication={strategyImplication}
        details={
          playbooks.length > 0 ? (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-[#21262d]">
                <h2 className="text-sm font-semibold text-white">Playbook Adherence</h2>
                <p className="text-xs text-[#6e7681] mt-0.5">
                  Rule adherence analytics across your saved playbooks.
                </p>
              </div>
              <div className="px-4 py-5 grid grid-cols-1 gap-3">
                {playbooks.map((pb) => (
                  <PlaybookAnalyticsCard key={pb.id} playbookId={pb.id} playbookName={pb.name} />
                ))}
              </div>
            </div>
          ) : undefined
        }
      />
      <NarrativeSection
        question="Is your edge real or lucky?"
        verdict={wfVerdict}
        evidence={<WalkForwardChart journalId={chartProps.journalId} />}
        implication={wfImplication}
      />
      <NarrativeSection
        question="How do market conditions affect you?"
        verdict={regimeVerdict}
        evidence={<RegimePerformance {...chartProps} />}
        implication={regimeImplication}
      />

      {/* ── Advanced Analysis (collapsed) ───────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setAdvancedExpanded((e) => !e)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#1c2128] transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">Advanced Analysis</span>
            <span className="text-xs text-[#6e7681]">(3 sections)</span>
          </div>
          <span className="text-xs text-[#6e7681]">{advancedExpanded ? '▲' : '▼'}</span>
        </button>
        {advancedExpanded && (
          <div className="border-t border-[#21262d] px-4 py-5 space-y-4">
            <PatternsSection />
            <div>
              <button
                type="button"
                onClick={() => setEdgeFinderExpanded((e) => !e)}
                className="w-full flex items-center gap-2 text-left mb-3 group"
              >
                <span className="text-[10px] text-[#6e7681] group-hover:text-[#c9d1d9] transition-colors">
                  {edgeFinderExpanded ? '▼' : '▶'}
                </span>
                <span className="text-sm font-semibold text-white group-hover:text-[#c9d1d9] transition-colors">
                  {combinatorialResult && combinatorialResult.totalSurvivingBH > 0
                    ? `Edge Finder — ${combinatorialResult.totalSurvivingBH} significant pattern${combinatorialResult.totalSurvivingBH === 1 ? '' : 's'} found`
                    : 'Edge Finder'}
                </span>
              </button>
              {edgeFinderExpanded && (
                <>
                  <p className="text-xs text-[#6e7681] mb-3 pl-4">
                    Exhaustive slice-by-slice search with Benjamini-Hochberg FDR correction at 10%.
                  </p>
                  <EdgeFinder result={combinatorialResult} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tab: Risk ─────────────────────────────────────────────────────────────────

function fmtDollars(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return n < 0 ? `-$${abs}` : `+$${abs}`;
}

function RiskTab({
  chartProps,
  sharpeRatio,
  sortinoRatio,
  payoffRatio,
  drawdownAnalysis,
  feeAttribution,
  liquidationCount,
  liquidationCost,
}: {
  chartProps: any;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  payoffRatio: number | null;
  drawdownAnalysis: DrawdownAnalysis | null;
  feeAttribution: FeeAttribution | null;
  liquidationCount: number;
  liquidationCost: number;
}) {
  const authFetch = useAuthFetch();
  const [mc, setMc] = useState<{ probDrawdown25?: number } | null>(null);
  const [mcLoading, setMcLoading] = useState(true);

  useEffect(() => {
    if (!chartProps.journalId) return;
    setMcLoading(true);
    authFetch(`/api/analytics/monte-carlo?journalId=${encodeURIComponent(chartProps.journalId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMc(d && !d.error ? d : null))
      .catch(() => setMc(null))
      .finally(() => setMcLoading(false));
  }, [chartProps.journalId, authFetch]);

  const hasRatios = sharpeRatio != null || sortinoRatio != null || payoffRatio != null;
  const hasDrawdown = drawdownAnalysis != null && drawdownAnalysis.maxDrawdown < 0;

  // ── Section 1: RISK-ADJUSTED PERFORMANCE ────────────────────────────────
  let riskAdjVerdict: string;
  if (sharpeRatio != null) {
    riskAdjVerdict =
      sharpeRatio < 0
        ? `Sharpe ratio: ${sharpeRatio.toFixed(2)}. You are not being compensated for the risk you take.`
        : `Sharpe ratio: ${sharpeRatio.toFixed(2)}. For every unit of risk, you earn ${sharpeRatio.toFixed(2)} units of return.`;
  } else {
    riskAdjVerdict = NO_DATA_VERDICT;
  }

  let riskAdjImplication: string;
  if (sharpeRatio == null) {
    riskAdjImplication = 'Not enough data yet to compute risk-adjusted metrics.';
  } else if (sharpeRatio < 0) {
    riskAdjImplication =
      'You are not being compensated for the risk you take. Reduce position sizes or improve your edge before sizing up.';
  } else if (sharpeRatio < 1) {
    riskAdjImplication = 'Modest risk-adjusted returns. Focus on consistency before sizing up.';
  } else {
    riskAdjImplication = 'Strong risk-adjusted returns.';
  }

  // ── Section 2: DRAWDOWN PROFILE ──────────────────────────────────────────
  let drawdownVerdict: string;
  if (hasDrawdown) {
    const ddDays = Math.round(drawdownAnalysis!.currentDrawdownDuration);
    const ddAmt = Math.round(Math.abs(drawdownAnalysis!.currentDrawdown));
    drawdownVerdict =
      ddDays > 0
        ? `Current drawdown: $${ddAmt.toLocaleString()} over ${ddDays} day${ddDays !== 1 ? 's' : ''}. You have had ${drawdownAnalysis!.drawdownCount} drawdown${drawdownAnalysis!.drawdownCount !== 1 ? 's' : ''} exceeding 5% of peak equity.`
        : `You are at your equity high. You have had ${drawdownAnalysis!.drawdownCount} drawdown${drawdownAnalysis!.drawdownCount !== 1 ? 's' : ''} exceeding 5% of peak equity.`;
  } else {
    drawdownVerdict = NO_DATA_VERDICT;
  }

  let drawdownImplication: string;
  if (!hasDrawdown) {
    drawdownImplication = 'Not enough data yet to assess drawdown profile.';
  } else if (drawdownAnalysis!.currentDrawdownDuration > 5) {
    drawdownImplication = `You are ${Math.round(drawdownAnalysis!.currentDrawdownDuration)} days into a drawdown. Consider reducing size until equity recovers.`;
  } else {
    const recoveryDays = Math.round(drawdownAnalysis!.avgDrawdownDuration);
    drawdownImplication =
      recoveryDays > 0
        ? `You recovered from drawdowns in an average of ${recoveryDays} day${recoveryDays !== 1 ? 's' : ''}.`
        : 'Your drawdown history is limited — keep monitoring as your trade history grows.';
  }

  // ── Section 3: FORWARD-LOOKING RISK ──────────────────────────────────────
  let mcVerdict: string;
  let mcImplication: string;
  if (mcLoading) {
    mcVerdict = 'Running Monte Carlo simulation…';
    mcImplication = '';
  } else if (mc?.probDrawdown25 != null) {
    const pct = Math.round(mc.probDrawdown25 * 100);
    mcVerdict = `${pct}% chance of a 25% drawdown over your next 100 trades.`;
    mcImplication =
      pct > 30
        ? 'Your current strategy has meaningful ruin risk. Consider smaller position sizes.'
        : 'Your risk of catastrophic drawdown is low at current sizing.';
  } else {
    mcVerdict = NO_DATA_VERDICT;
    mcImplication = 'Run more trades to generate Monte Carlo projections.';
  }

  return (
    <div className="space-y-2">
      <NarrativeSection
        question="Are your returns worth the risk?"
        verdict={riskAdjVerdict}
        evidence={
          hasRatios ? (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-xs text-[#6e7681] mb-1">Sharpe Ratio</div>
                  <div className={`text-lg font-bold tabular-nums ${
                    sharpeRatio == null ? 'text-[#4a5568]'
                    : sharpeRatio >= 1 ? 'text-green-400'
                    : sharpeRatio >= 0.5 ? 'text-amber-400'
                    : 'text-red-400'
                  }`}>
                    {sharpeRatio != null ? sharpeRatio.toFixed(2) : '—'}
                  </div>
                  <div className="text-[10px] text-[#4a5568] mt-0.5">Returns per unit of volatility</div>
                </div>
                <div>
                  <div className="text-xs text-[#6e7681] mb-1">Sortino Ratio</div>
                  <div className={`text-lg font-bold tabular-nums ${
                    sortinoRatio == null ? 'text-[#4a5568]'
                    : sortinoRatio >= 1 ? 'text-green-400'
                    : sortinoRatio >= 0.5 ? 'text-amber-400'
                    : 'text-red-400'
                  }`}>
                    {sortinoRatio != null ? sortinoRatio.toFixed(2) : '—'}
                  </div>
                  <div className="text-[10px] text-[#4a5568] mt-0.5">Returns per unit of downside risk</div>
                </div>
                <div>
                  <div className="text-xs text-[#6e7681] mb-1">Payoff Ratio</div>
                  <div className={`text-lg font-bold tabular-nums ${
                    payoffRatio == null ? 'text-[#4a5568]'
                    : payoffRatio >= 1.5 ? 'text-green-400'
                    : payoffRatio >= 1 ? 'text-amber-400'
                    : 'text-red-400'
                  }`}>
                    {payoffRatio != null ? payoffRatio.toFixed(2) : '—'}
                  </div>
                  <div className="text-[10px] text-[#4a5568] mt-0.5">Avg winner / avg loser</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4 text-xs text-[#4a5568] italic">
              Risk metrics not yet computed.
            </div>
          )
        }
        implication={riskAdjImplication}
      />
      <NarrativeSection
        question="How bad can it get?"
        verdict={drawdownVerdict}
        evidence={
          hasDrawdown ? (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs text-[#6e7681] mb-1">Max Drawdown</div>
                  <div className="text-sm font-medium text-red-400 tabular-nums">
                    {fmtDollars(drawdownAnalysis!.maxDrawdown)}
                  </div>
                  <div className="text-[10px] text-[#4a5568]">
                    {drawdownAnalysis!.maxDrawdownPercent.toFixed(1)}% of peak
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#6e7681] mb-1">Current</div>
                  <div className={`text-sm font-medium tabular-nums ${
                    drawdownAnalysis!.currentDrawdown < 0 ? 'text-red-400' : 'text-green-400'
                  }`}>
                    {drawdownAnalysis!.currentDrawdown !== 0
                      ? fmtDollars(drawdownAnalysis!.currentDrawdown)
                      : 'At HWM'}
                  </div>
                  {drawdownAnalysis!.currentDrawdownDuration > 0 && (
                    <div className="text-[10px] text-[#4a5568]">
                      {Math.round(drawdownAnalysis!.currentDrawdownDuration)}d in drawdown
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-[#6e7681] mb-1">Avg Recovery</div>
                  <div className="text-sm font-medium text-white tabular-nums">
                    {drawdownAnalysis!.avgDrawdownDuration.toFixed(0)}d
                  </div>
                  <div className="text-[10px] text-[#4a5568]">
                    Longest: {Math.round(drawdownAnalysis!.longestDrawdown)}d
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#6e7681] mb-1">Episodes &gt; 5%</div>
                  <div className="text-sm font-medium text-white tabular-nums">
                    {drawdownAnalysis!.drawdownCount}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4 text-xs text-[#4a5568] italic">
              No drawdown data yet.
            </div>
          )
        }
        implication={drawdownImplication}
      />
      <NarrativeSection
        question="What could happen next?"
        verdict={mcVerdict}
        evidence={<MonteCarloChart journalId={chartProps.journalId} />}
        implication={mcImplication}
        details={
          <>
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-[#21262d]">
                <h2 className="text-sm font-semibold text-white">What If?</h2>
                <p className="text-xs text-[#6e7681] mt-0.5">
                  Explore how your stats change under hypothetical filters.
                </p>
              </div>
              <div className="px-4 py-5">
                <WhatIfExplorer {...chartProps} />
              </div>
            </div>
            <WhatIfChart journalId={chartProps.journalId} />
            {feeAttribution && (
              <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4 mt-4">
                <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-3">
                  Fee &amp; Funding Impact
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-[#6e7681] mb-1">Total Fees</div>
                    <div className="text-sm font-medium text-red-400 tabular-nums">
                      {fmtDollars(feeAttribution.totalFees)}
                    </div>
                    <div className="text-[10px] text-[#4a5568]">
                      {feeAttribution.feeImpact.toFixed(1)}% of gross P&L
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[#6e7681] mb-1">Net Funding</div>
                    <div className={`text-sm font-medium tabular-nums ${
                      feeAttribution.totalFunding >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {fmtDollars(feeAttribution.totalFunding)}
                    </div>
                    <div className="text-[10px] text-[#4a5568]">
                      {feeAttribution.fundingImpact.toFixed(1)}% of net P&L
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[#6e7681] mb-1">Directional P&amp;L</div>
                    <div className={`text-sm font-medium tabular-nums ${
                      feeAttribution.directionalPnl >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {fmtDollars(feeAttribution.directionalPnl)}
                    </div>
                    <div className="text-[10px] text-[#4a5568]">Price movement only</div>
                  </div>
                  {liquidationCount > 0 && (
                    <div>
                      <div className="text-xs text-[#6e7681] mb-1">Liquidations</div>
                      <div className="text-sm font-medium text-red-400 tabular-nums">
                        {liquidationCount} event{liquidationCount !== 1 ? 's' : ''}
                      </div>
                      <div className="text-[10px] text-[#4a5568]">
                        {fmtDollars(liquidationCost)} total cost
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        }
      />
    </div>
  );
}

// ── Tab: Insights ─────────────────────────────────────────────────────────────

const INSIGHT_CATEGORIES = [
  { value: '',         label: 'All categories' },
  { value: 'behavior', label: 'Behavior' },
  { value: 'exit',     label: 'Exit' },
  { value: 'timing',   label: 'Timing' },
  { value: 'strategy', label: 'Strategy' },
  { value: 'risk',     label: 'Risk' },
  { value: 'entry',    label: 'Entry' },
  { value: 'pacifica', label: 'Pacifica' },
];

function InsightGroup({
  title,
  insights,
  onSwitchTab,
  defaultCollapsed = false,
  count,
}: {
  title: string;
  insights: Insight[];
  onSwitchTab: (tab: TabId) => void;
  defaultCollapsed?: boolean;
  count?: number;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (insights.length === 0 && count == null) return null;

  const displayCount = count ?? insights.length;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-[#6e7681] hover:text-[#c9d1d9] transition-colors w-full text-left"
      >
        <span>{collapsed ? '▶' : '▼'}</span>
        <span>{title}</span>
        <span className="ml-1 bg-[#21262d] px-1.5 py-0.5 rounded text-[9px]">{displayCount}</span>
      </button>
      {!collapsed && insights.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {insights.map((insight, i) => (
            <FullInsightCard
              key={`${insight.module}-${i}`}
              insight={insight}
              onDigDeeper={onSwitchTab}
            />
          ))}
        </div>
      )}
      {!collapsed && insights.length === 0 && (
        <p className="text-xs text-[#6e7681] px-1">No insights in this group.</p>
      )}
    </div>
  );
}

function InsightsTab({
  insights,
  tradeCount,
  onSwitchTab,
}: {
  insights: Insight[];
  tradeCount: number;
  onSwitchTab: (tab: TabId) => void;
}) {
  const [catFilter, setCatFilter] = useState('');

  const deduped = deduplicateByTitle(insights);

  const filtered = deduped.filter((i) => {
    if (catFilter && i.category !== catFilter) return false;
    return true;
  });

  // Group by tier
  const actionable = filtered
    .filter((i) => i.tier === 'significant' || i.tier === 'descriptive' || (!i.tier && i.isSignificant))
    .sort((a, b) => b.impactScore - a.impactScore);

  const preliminary = filtered
    .filter((i) => i.tier === 'preliminary' || (!i.tier && !i.isSignificant && (i.statistics?.[0]?.pValue ?? 1) < 0.10))
    .sort((a, b) => (a.statistics?.[0]?.pValue ?? 1) - (b.statistics?.[0]?.pValue ?? 1));

  const notDetected = filtered
    .filter((i) => i.tier === 'not_detected' || (!i.tier && !i.isSignificant && (i.statistics?.[0]?.pValue ?? 1) >= 0.10))
    .sort((a, b) => b.impactScore - a.impactScore);

  return (
    <div className="space-y-4">
      <InsightsVerdict insights={deduped} tradeCount={tradeCount} />

      {/* Category filter */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <p className="text-xs text-[#6e7681]">
          {deduped.length} pattern{deduped.length !== 1 ? 's' : ''} detected
        </p>
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className="bg-[#21262d] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
        >
          {INSIGHT_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6 text-center">
          <p className="text-sm text-[#6e7681]">No insights match the current filters.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <InsightGroup
            title="Actionable Findings"
            insights={actionable}
            onSwitchTab={onSwitchTab}
          />
          <InsightGroup
            title="Observed Patterns (need more data for certainty)"
            insights={preliminary}
            onSwitchTab={onSwitchTab}
          />
          <InsightGroup
            title="No Pattern Detected"
            insights={notDetected}
            onSwitchTab={onSwitchTab}
            defaultCollapsed
            count={notDetected.length}
          />
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const VALID_TABS: TabId[] = ['overview', 'strategy', 'execution', 'risk', 'psychology', 'insights'];

export default function AnalyticsClient() {
  const { journalId } = useJournal();
  const authFetch = useAuthFetch();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // Sync tab from URL — lets Booba navigate directly to a tab via router.push('/analytics?tab=risk')
  useEffect(() => {
    const tab = searchParams.get('tab') as TabId | null;
    if (tab && VALID_TABS.includes(tab)) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  const [filters, setFilters] = useState<AnalyticsFilters>(EMPTY_FILTERS);
  const [assetOptions, setAssetOptions] = useState<string[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [wartResult, setWartResult] = useState<WartResult | null>(null);
  const [eloResult, setEloResult] = useState<EloResult | null>(null);
  const [entropyResult, setEntropyResult] = useState<EntropyResult | null>(null);
  const [missingExitMetricsCount, setMissingExitMetricsCount] = useState(0);
  const [runningDeepAnalysis, setRunningDeepAnalysis] = useState(false);
  const [sharpeRatio, setSharpeRatio] = useState<number | null>(null);
  const [sortinoRatio, setSortinoRatio] = useState<number | null>(null);
  const [payoffRatio, setPayoffRatio] = useState<number | null>(null);
  const [drawdownAnalysis, setDrawdownAnalysis] = useState<DrawdownAnalysis | null>(null);
  const [feeAttribution, setFeeAttribution] = useState<FeeAttribution | null>(null);
  const [liquidationCount, setLiquidationCount] = useState(0);
  const [liquidationCost, setLiquidationCost] = useState(0);
  const [convergence, setConvergence] = useState<ConvergenceResult | null>(null);
  const [regimeBreakdown, setRegimeBreakdown] = useState<Record<string, any>>({});
  const [tradeCount, setTradeCount] = useState<number>(0);
  // Behavior-tab-specific data — fetched lazily when the tab first becomes active.
  const [behaviorPositions, setBehaviorPositions] = useState<BehaviorPosition[]>([]);
  const [equitySeries, setEquitySeries] = useState<{ date: string; cumulativePnl: number }[]>([]);
  // Track the last fetch key so we re-fetch when journalId or filters change.
  const behaviorLoadedRef = useRef<string>('');
  // Playbooks — fetched lazily when the Strategy tab first becomes active.
  const [playbooks, setPlaybooks] = useState<{ id: string; name: string }[]>([]);
  const playbooksLoadedRef = useRef(false);

  const set = useCallback(<K extends keyof AnalyticsFilters>(key: K, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
  }, []);

  // Asset options
  useEffect(() => {
    if (!journalId) return;
    const p = new URLSearchParams({ journalId, pageSize: '500' });
    authFetch(`/api/trade-units?${p}`)
      .then((r) => r.json())
      .then((d) => {
        const assets = [
          ...new Set<string>(
            (d.tradeUnits ?? []).flatMap((u: any) => (u.asset as string).split(' / ')),
          ),
        ].sort();
        setAssetOptions(assets);
      })
      .catch(() => {});
  }, [journalId, authFetch]);

  // Insights
  useEffect(() => {
    if (!journalId) return;
    const p = new URLSearchParams({ journalId });
    authFetch(`/api/analytics/insights?${p}`)
      .then((r) => r.json())
      .then((d) => setInsights(d.insights ?? []))
      .catch(() => {});
  }, [journalId, authFetch]);

  // Convergence — drives the Overview hero cards.
  useEffect(() => {
    if (!journalId) return;
    const p = new URLSearchParams({ journalId });
    authFetch(`/api/analytics/convergence?${p}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ConvergenceResult | null) => setConvergence(d))
      .catch(() => setConvergence(null));
  }, [journalId, authFetch]);

  // Summary (WART + Elo + risk metrics + missing exit count)
  useEffect(() => {
    if (!journalId) return;
    const params = buildParams(filters, journalId);
    authFetch(`/api/analytics/summary?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setWartResult(d.wartResult ?? null);
        setEloResult(d.eloResult ?? null);
        setEntropyResult(d.entropyResult ?? null);
        setMissingExitMetricsCount(d.missingExitMetricsCount ?? 0);
        setSharpeRatio(d.sharpeRatio ?? null);
        setSortinoRatio(d.sortinoRatio ?? null);
        setPayoffRatio(d.payoffRatio ?? null);
        setDrawdownAnalysis(d.drawdownAnalysis ?? null);
        setFeeAttribution(d.feeAttribution ?? null);
        setLiquidationCount(d.liquidationCount ?? 0);
        setLiquidationCost(d.liquidationCost ?? 0);
        setRegimeBreakdown((d.breakdowns?.regime as Record<string, any>) ?? {});
        setTradeCount((d.data?.tradeCount as number) ?? 0);
        // Invalidate behavior data so it re-fetches with the new filters.
        behaviorLoadedRef.current = '';
      })
      .catch(() => {});
  }, [filters, journalId, authFetch]);

  // Lazy-load behavior-tab data (positions + equity curve) when the tab is first opened.
  useEffect(() => {
    if (activeTab !== 'psychology' || !journalId) return;
    const key = `${journalId}|${JSON.stringify(filters)}`;
    if (behaviorLoadedRef.current === key) return;
    behaviorLoadedRef.current = key;

    const params = buildParams(filters, journalId);

    async function loadPositions() {
      let all: BehaviorPosition[] = [];
      let page = 1;
      while (all.length < 2000) {
        const p = new URLSearchParams(params);
        p.set('pageSize', '200');
        p.set('page', String(page));
        p.set('status', 'closed');
        p.set('sortBy', 'firstEntryTime');
        p.set('sortDir', 'asc');
        const d = await authFetch(`/api/trade-units?${p}`).then((r) => r.json());
        const units: BehaviorPosition[] = d.tradeUnits ?? [];
        const positions = units.filter((u) => u.kind === 'position');
        all = [...all, ...positions];
        const { totalPages, page: pg } = d.pagination ?? {};
        if (!totalPages || pg >= totalPages) break;
        page++;
      }
      return all;
    }

    async function loadEquityCurve() {
      const d = await authFetch(`/api/analytics/equity-curve?${params}`).then((r) => r.json());
      return (d.series ?? []) as { date: string; cumulativePnl: number }[];
    }

    Promise.all([loadPositions(), loadEquityCurve()])
      .then(([positions, curve]) => {
        setBehaviorPositions(positions);
        setEquitySeries(curve);
      })
      .catch(() => {});
  }, [activeTab, journalId, filters, authFetch]);

  // Lazy-load playbooks when the Strategy tab first becomes active.
  useEffect(() => {
    if (activeTab !== 'strategy' || playbooksLoadedRef.current) return;
    playbooksLoadedRef.current = true;
    authFetch('/api/playbooks')
      .then((r) => r.json())
      .then((d) => setPlaybooks(d.playbooks ?? []))
      .catch(() => {});
  }, [activeTab, authFetch]);

  const handleRunDeepAnalysis = useCallback(async () => {
    if (!journalId || runningDeepAnalysis) return;
    setRunningDeepAnalysis(true);
    try {
      await authFetch('/api/analytics/metrics/compute?tier=slow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journalId }),
      });
      const params = buildParams(filters, journalId);
      const d = await authFetch(`/api/analytics/summary?${params}`).then((r) => r.json());
      setMissingExitMetricsCount(d.missingExitMetricsCount ?? 0);
    } catch {
      // silent
    } finally {
      setRunningDeepAnalysis(false);
    }
  }, [journalId, filters, authFetch, runningDeepAnalysis]);

  const hasFilters = Object.values(filters).some(Boolean);
  const chartProps = { filters, journalId: journalId ?? undefined };

  const combinatorialInsight = insights.find((i) => i.module === 'combinatorial-search');
  const combinatorialResult: CombinatorialSearchResult | null =
    (combinatorialInsight?.data?.combinatorial as CombinatorialSearchResult | undefined) ?? null;

  // Exclude combinatorial from inline insight rendering (it has its own EdgeFinder widget)
  const insightsForCards = insights.filter((i) => i.module !== 'combinatorial-search');

  return (
    <div className="space-y-4">
      {/* ── Filter Bar ─────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-3">
        <div className="flex flex-wrap gap-4 items-end">
          <FilterSelect
            label="Regime"
            value={filters.regime}
            onChange={(v) => set('regime', v)}
            options={ALL_REGIMES.map((r) => ({ value: r, label: REGIME_LABELS[r] ?? r }))}
          />
          <FilterSelect
            label="Trade Type"
            value={filters.tradeType}
            onChange={(v) => set('tradeType', v)}
            options={TRADE_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
          />
          <FilterSelect
            label="Asset"
            value={filters.asset}
            onChange={(v) => set('asset', v)}
            options={assetOptions.map((a) => ({ value: a, label: a }))}
          />
          {hasFilters && (
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="text-xs text-[#6e7681] hover:text-white bg-[#21262d] border border-[#30363d] rounded px-3 py-1.5 transition-colors self-end"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Sticky Tab Bar ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-[#0d1117] -mx-4 px-4 border-b border-[#21262d]">
        <div className="flex gap-0 overflow-x-auto">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                activeTab === id
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-[#6e7681] hover:text-[#8b949e]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab Content (lazy) ─────────────────────────────────────────── */}
      <div className="pt-1">
        {activeTab === 'overview' && (
          <OverviewTab
            wartResult={wartResult}
            eloResult={eloResult}
            sharpeRatio={sharpeRatio}
            insights={insightsForCards}
            convergence={convergence}
            onSwitchTab={setActiveTab}
          />
        )}
        {activeTab === 'strategy' && (
          <StrategyTab
            chartProps={chartProps}
            insights={insightsForCards}
            regimeBreakdown={regimeBreakdown}
            onSwitchTab={setActiveTab}
            combinatorialResult={combinatorialResult}
            playbooks={playbooks}
          />
        )}
        {activeTab === 'execution' && (
          <ExecutionTab
            chartProps={chartProps}
            insights={insightsForCards}
            tradeCount={tradeCount}
            missingExitMetricsCount={missingExitMetricsCount}
            onSwitchTab={setActiveTab}
            onRunDeepAnalysis={handleRunDeepAnalysis}
            runningDeepAnalysis={runningDeepAnalysis}
          />
        )}
        {activeTab === 'risk' && (
          <RiskTab
            chartProps={chartProps}
            sharpeRatio={sharpeRatio}
            sortinoRatio={sortinoRatio}
            payoffRatio={payoffRatio}
            drawdownAnalysis={drawdownAnalysis}
            feeAttribution={feeAttribution}
            liquidationCount={liquidationCount}
            liquidationCost={liquidationCost}
          />
        )}
        {activeTab === 'psychology' && (
          <PsychologyTab
            insights={insightsForCards}
            onSwitchTab={setActiveTab}
            entropyResult={entropyResult}
            behaviorPositions={behaviorPositions}
            equitySeries={equitySeries}
          />
        )}
        {activeTab === 'insights' && (
          <InsightsTab
            insights={insightsForCards}
            tradeCount={tradeCount}
            onSwitchTab={setActiveTab}
          />
        )}
      </div>
    </div>
  );
}
