'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { AnalyticsFilters } from './types';
import { EMPTY_FILTERS, ALL_REGIMES, REGIME_LABELS, TRADE_TYPES, buildParams } from './types';
import { useJournal } from '../JournalContext';
import { useAuthFetch } from '@/lib/api-client';
import CalendarHeatmap from './CalendarHeatmap';
import TimeAnalysis from './TimeAnalysis';
import ExitAnalysis from './ExitAnalysis';
import StrategyBreakdown from './StrategyBreakdown';
import WhatIfExplorer from './WhatIfExplorer';
import RegimePerformance from './RegimePerformance';
import PatternsSection from './PatternsSection';
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

// ── Types ──────────────────────────────────────────────────────────────────────

interface StatisticalTest {
  pValue: number;
  isSignificant: boolean;
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
  const pValue = insight.statistics?.[0]?.pValue;
  const pStr = pValue != null
    ? (pValue < 0.001 ? 'p<0.001' : `p=${pValue.toFixed(3)}`)
    : null;

  return (
    <div className={`bg-[#161b22] border ${style.border} rounded-lg px-3 py-2.5 flex items-start gap-3`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-xs font-semibold text-white">{insight.title}</span>
          <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-widest font-medium bg-[#21262d] text-[#6e7681]">
            {CATEGORY_LABEL[insight.category] ?? insight.category}
          </span>
          {insight.isSignificant && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400">
              {pStr ?? 'Significant'}
            </span>
          )}
        </div>
        <p className="text-xs text-[#8b949e] leading-relaxed line-clamp-1">{insight.description}</p>
      </div>
      {tab && onDigDeeper && (
        <button
          onClick={() => onDigDeeper(tab)}
          className="shrink-0 text-xs text-blue-400 hover:text-blue-300 transition-colors whitespace-nowrap"
        >
          Dig deeper →
        </button>
      )}
    </div>
  );
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

  return (
    <div className={`bg-[#161b22] border ${style.border} rounded-lg p-4 flex flex-col gap-2 ${isSignif ? '' : 'opacity-60'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-white">{insight.title}</span>
          <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-widest font-medium bg-[#21262d] text-[#6e7681]">
            {CATEGORY_LABEL[insight.category] ?? insight.category}
          </span>
        </div>
        <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] uppercase tracking-widest font-medium ${style.badge} ${style.badgeText}`}>
          {insight.severity}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {isSignif ? (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400">
            Significant{pStr ? ` · ${pStr}` : ''}
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-[#21262d] text-[#6e7681]">
            Preliminary{pStr ? ` · ${pStr}` : ''}
          </span>
        )}
        {insight.sampleSize != null && (
          <span className="text-[10px] text-[#6e7681]">{insight.sampleSize} trades</span>
        )}
      </div>

      <p className="text-sm text-[#8b949e] leading-relaxed">{insight.description}</p>

      {insight.suggestion && (
        <p className="text-xs text-[#6e7681] leading-relaxed pt-2 border-t border-[#21262d]">
          <span className="text-[#8b949e] font-medium">Suggestion: </span>
          {insight.suggestion}
        </p>
      )}

      {tab && (
        <button
          onClick={() => onDigDeeper(tab)}
          className="self-start text-xs text-blue-400 hover:text-blue-300 transition-colors mt-0.5"
        >
          → {tab.charAt(0).toUpperCase() + tab.slice(1)}
        </button>
      )}
    </div>
  );
}

// ── Tab: Overview ─────────────────────────────────────────────────────────────

function OverviewTab({
  wartResult,
  eloResult,
  insights,
  onSwitchTab,
}: {
  wartResult: WartResult | null;
  eloResult: EloResult | null;
  insights: Insight[];
  onSwitchTab: (tab: TabId) => void;
}) {
  const top3 = pickTop3(insights);

  const SUMMARY_TABS: { id: TabId; label: string }[] = [
    { id: 'strategy',   label: 'Strategy' },
    { id: 'execution',  label: 'Execution' },
    { id: 'risk',       label: 'Risk' },
    { id: 'psychology', label: 'Psychology' },
  ];

  return (
    <div className="space-y-4">
      {/* Top row: WART radar + Elo card */}
      <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-start">
        {/* Compact WART radar */}
        <div className="flex flex-col items-center">
          {wartResult ? (
            <>
              <div style={{ width: 200, height: 180 }}>
                <WartRadar wart={wartResult} compact />
              </div>
              <div className={`text-xl font-bold mt-1 ${wartColor(wartResult.composite)}`}>
                {wartResult.composite >= 0 ? '+' : ''}{wartResult.composite.toFixed(1)}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">{wartResult.tier}</div>
            </>
          ) : (
            <div className="w-[200px] h-[180px] flex items-center justify-center">
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
                <div className="text-xs text-[#6e7681] mt-0.5">{eloResult.tier}</div>
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
  missingExitMetricsCount,
  onSwitchTab,
  onRunDeepAnalysis,
  runningDeepAnalysis,
}: {
  chartProps: any;
  insights: Insight[];
  missingExitMetricsCount: number;
  onSwitchTab: (tab: TabId) => void;
  onRunDeepAnalysis: () => void;
  runningDeepAnalysis: boolean;
}) {
  const inlineInsights = getInlineInsights('execution', insights);
  return (
    <div className="space-y-4">
      {missingExitMetricsCount > 0 && (
        <div className="flex items-center justify-between bg-[#1c2128] border border-[#30363d] rounded-lg px-4 py-2.5">
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
      {inlineInsights.length > 0 && (
        <div className="space-y-1.5">
          {inlineInsights.map((ins, i) => (
            <InlineInsightCard key={`${ins.module}-${i}`} insight={ins} onDigDeeper={onSwitchTab} />
          ))}
        </div>
      )}
      <ExitAnalysis {...chartProps} />
      <TimeAnalysis {...chartProps} />
      <CalendarHeatmap {...chartProps} />
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

  // Extract Markov data from the ml-patterns-markov insight
  const markovInsight = insights.find((i) => i.module === 'ml-patterns-markov');
  const markovData = markovInsight?.data?.markov as MarkovData | undefined;

  // Extract tilt episode data
  const tiltInsight = insights.find((i) => i.module === 'tilt-episodes');
  const tiltEpisodes = (tiltInsight?.data?.episodes as TiltEpisode[] | undefined) ?? [];
  const totalEpisodes = (tiltInsight?.data?.totalEpisodes as number | undefined) ?? 0;
  const counterfactualImprovement =
    (tiltInsight?.data?.counterfactualImprovement as number | undefined) ?? 0;

  return (
    <div className="space-y-4">
      {/* ── Row 1: DisciplineGauge · MarkovBars · SessionDecayChart ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
          <SessionDecayChart positions={behaviorPositions} />
        </div>
      </div>

      {/* ── Row 2: TiltEquityCurve (full width) ───────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <TiltEquityCurve
          series={equitySeries}
          episodes={tiltEpisodes}
          totalEpisodes={totalEpisodes}
          counterfactualImprovement={counterfactualImprovement}
        />
      </div>

      {/* ── Row 3: SizeAfterOutcomeScatter ────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <SizeAfterOutcomeScatter positions={behaviorPositions} />
      </div>

      {/* ── Existing insight cards ─────────────────────────────────── */}
      {psychologyInsights.length > 0 ? (
        <div className="space-y-2">
          {psychologyInsights.map((ins, i) => (
            <FullInsightCard key={`${ins.module}-${i}`} insight={ins} onDigDeeper={onSwitchTab} />
          ))}
        </div>
      ) : (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6 text-center">
          <p className="text-sm text-[#6e7681]">
            No behavioral patterns detected yet. Booba watches for tilt, revenge trading, size escalation, and discipline drift as your trade history grows.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Tab: Strategy ─────────────────────────────────────────────────────────────

function StrategyTab({
  chartProps,
  insights,
  onSwitchTab,
  combinatorialResult,
  playbooks,
}: {
  chartProps: any;
  insights: Insight[];
  onSwitchTab: (tab: TabId) => void;
  combinatorialResult: CombinatorialSearchResult | null;
  playbooks: { id: string; name: string }[];
}) {
  const inlineInsights = getInlineInsights('strategy', insights);
  return (
    <div className="space-y-4">
      {inlineInsights.length > 0 && (
        <div className="space-y-1.5">
          {inlineInsights.map((ins, i) => (
            <InlineInsightCard key={`${ins.module}-${i}`} insight={ins} onDigDeeper={onSwitchTab} />
          ))}
        </div>
      )}
      <StrategyBreakdown {...chartProps} />
      <RegimePerformance {...chartProps} />
      <WalkForwardChart journalId={chartProps.journalId} />
      <PatternsSection />
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#21262d]">
          <h2 className="text-sm font-semibold text-white">
            {combinatorialResult
              ? `Edge Finder · ${combinatorialResult.totalTestsRun} combinations tested, ${combinatorialResult.totalSurvivingBH} significant`
              : 'Edge Finder'}
          </h2>
          <p className="text-xs text-[#6e7681] mt-0.5">
            Exhaustive slice-by-slice search with Benjamini-Hochberg FDR correction at 10%.
          </p>
        </div>
        <div className="px-4 py-5">
          <EdgeFinder result={combinatorialResult} />
        </div>
      </div>
      {playbooks.length > 0 && (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[#21262d]">
            <h2 className="text-sm font-semibold text-white">Playbook Adherence</h2>
            <p className="text-xs text-[#6e7681] mt-0.5">Rule adherence analytics across your saved playbooks.</p>
          </div>
          <div className="px-4 py-5 grid grid-cols-1 gap-3">
            {playbooks.map((pb) => (
              <PlaybookAnalyticsCard key={pb.id} playbookId={pb.id} playbookName={pb.name} />
            ))}
          </div>
        </div>
      )}
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
  const hasRatios = sharpeRatio != null || sortinoRatio != null || payoffRatio != null;
  const hasDrawdown = drawdownAnalysis != null && drawdownAnalysis.maxDrawdown < 0;

  return (
    <div className="space-y-4">
      {/* ── Risk-Adjusted Performance ────────────────────────────── */}
      {hasRatios && (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-3">Risk-Adjusted Performance</div>
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
      )}

      {/* ── Drawdown Analysis ────────────────────────────────────── */}
      {hasDrawdown && (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-3">Drawdown Analysis</div>
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
      )}

      {/* ── Monte Carlo ──────────────────────────────────────────── */}
      <MonteCarloChart journalId={chartProps.journalId} />

      {/* ── What-If equity curves ────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#21262d]">
          <h2 className="text-sm font-semibold text-white">What If?</h2>
          <p className="text-xs text-[#6e7681] mt-0.5">Explore how your stats change under hypothetical filters.</p>
        </div>
        <div className="px-4 py-5">
          <WhatIfExplorer {...chartProps} />
        </div>
      </div>
      <WhatIfChart journalId={chartProps.journalId} />

      {/* ── Fee & Funding Impact ─────────────────────────────────── */}
      {feeAttribution && (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
          <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-3">Fee & Funding Impact</div>
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
              <div className="text-xs text-[#6e7681] mb-1">Directional P&L</div>
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

function InsightsTab({
  insights,
  onSwitchTab,
}: {
  insights: Insight[];
  onSwitchTab: (tab: TabId) => void;
}) {
  const [catFilter, setCatFilter] = useState('');
  const [sigFilter, setSigFilter] = useState<'all' | 'significant' | 'non-significant'>('all');
  const [sortBy, setSortBy] = useState<'impact' | 'pvalue' | 'tradeCount'>('impact');

  const deduped = deduplicateByTitle(insights);

  const filtered = deduped.filter((i) => {
    if (catFilter && i.category !== catFilter) return false;
    if (sigFilter === 'significant' && !i.isSignificant) return false;
    if (sigFilter === 'non-significant' && i.isSignificant) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'impact') return b.impactScore - a.impactScore;
    if (sortBy === 'pvalue') {
      const pA = a.statistics?.[0]?.pValue ?? 1;
      const pB = b.statistics?.[0]?.pValue ?? 1;
      return pA - pB;
    }
    if (sortBy === 'tradeCount') return (b.sampleSize ?? 0) - (a.sampleSize ?? 0);
    return 0;
  });

  const significantCount = deduped.filter((i) => i.isSignificant).length;

  return (
    <div className="space-y-4">
      {/* Header + controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-xs text-[#6e7681]">
          {deduped.length} pattern{deduped.length !== 1 ? 's' : ''} detected
          {' · '}
          <span className="text-emerald-400">{significantCount} statistically significant</span>
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="bg-[#21262d] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            {INSIGHT_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <select
            value={sigFilter}
            onChange={(e) => setSigFilter(e.target.value as any)}
            className="bg-[#21262d] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All significance</option>
            <option value="significant">Significant only</option>
            <option value="non-significant">Preliminary only</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-[#21262d] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value="impact">Sort: impact score</option>
            <option value="pvalue">Sort: p-value</option>
            <option value="tradeCount">Sort: trade count</option>
          </select>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-6 text-center">
          <p className="text-sm text-[#6e7681]">No insights match the current filters.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {sorted.map((insight, i) => (
            <FullInsightCard
              key={`${insight.module}-${i}`}
              insight={insight}
              onDigDeeper={onSwitchTab}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function AnalyticsClient() {
  const { journalId } = useJournal();
  const authFetch = useAuthFetch();

  const [activeTab, setActiveTab] = useState<TabId>('overview');
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
      {/* ── Page title ───────────────────────────────────────────────── */}
      <div>
        <h1 className="text-lg font-semibold text-white">Analytics</h1>
      </div>

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
            insights={insightsForCards}
            onSwitchTab={setActiveTab}
          />
        )}
        {activeTab === 'strategy' && (
          <StrategyTab
            chartProps={chartProps}
            insights={insightsForCards}
            onSwitchTab={setActiveTab}
            combinatorialResult={combinatorialResult}
            playbooks={playbooks}
          />
        )}
        {activeTab === 'execution' && (
          <ExecutionTab
            chartProps={chartProps}
            insights={insightsForCards}
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
            onSwitchTab={setActiveTab}
          />
        )}
      </div>
    </div>
  );
}
