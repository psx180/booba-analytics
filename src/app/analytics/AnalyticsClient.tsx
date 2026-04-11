'use client';

import { useState, useCallback, useEffect } from 'react';
import type { AnalyticsFilters } from './types';
import { EMPTY_FILTERS, ALL_REGIMES, REGIME_LABELS, TRADE_TYPES, buildParams } from './types';
import CalendarHeatmap from './CalendarHeatmap';
import TimeAnalysis from './TimeAnalysis';
import ExitAnalysis from './ExitAnalysis';
import StrategyBreakdown from './StrategyBreakdown';
import WhatIfExplorer from './WhatIfExplorer';
import RegimePerformance from './RegimePerformance';
import PatternsSection from './PatternsSection';

// ── Insight types (mirror of backend Insight) ──────────────────────────────────

interface StatisticalTest {
  testName: string;
  pValue: number;
  effectSize: number;
  sampleSizeA: number;
  sampleSizeB: number;
  isSignificant: boolean;
  correctionApplied?: string;
  description: string;
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
  regimeBreakdown?: Record<string, any>;
  statistics: StatisticalTest[];
  impactScore: number;
  category: string;
  isSignificant: boolean;
  sampleSize: number;
}

const CATEGORY_ORDER = ['behavior', 'exit', 'timing', 'strategy', 'risk', 'entry', 'pacifica'] as const;
const CATEGORY_LABEL: Record<string, string> = {
  behavior:  'Behavior',
  exit:      'Exit',
  timing:    'Timing',
  strategy:  'Strategy',
  risk:      'Risk',
  entry:     'Entry',
  pacifica:  'Pacifica',
};

const SEVERITY_STYLE: Record<string, { border: string; badge: string; badgeText: string }> = {
  info:     { border: 'border-blue-500/30',  badge: 'bg-blue-500/15',   badgeText: 'text-blue-300'   },
  warning:  { border: 'border-amber-500/40', badge: 'bg-amber-500/15',  badgeText: 'text-amber-300'  },
  critical: { border: 'border-red-500/40',   badge: 'bg-red-500/15',    badgeText: 'text-red-300'    },
};

function InsightCard({ insight }: { insight: Insight }) {
  const style    = SEVERITY_STYLE[insight.severity] ?? SEVERITY_STYLE.info;
  const isSignif = insight.isSignificant ?? false;
  const primary  = insight.statistics?.[0];
  const pValue   = primary?.pValue;
  const pStr     = pValue != null
    ? (pValue < 0.001 ? 'p<0.001' : `p=${pValue.toFixed(3)}`)
    : null;

  return (
    <div className={`bg-[#161b22] border ${style.border} rounded-lg p-4 flex flex-col gap-2`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-white">{insight.title}</span>
          {insight.category && (
            <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-widest font-medium bg-[#21262d] text-[#6e7681]">
              {CATEGORY_LABEL[insight.category] ?? insight.category}
            </span>
          )}
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
          <span className="text-[10px] text-[#6e7681]">Based on {insight.sampleSize} trades</span>
        )}
      </div>

      <p className="text-sm text-[#8b949e] leading-relaxed">{insight.description}</p>

      {insight.suggestion && (
        <p className="text-xs text-[#6e7681] leading-relaxed pt-2 border-t border-[#21262d]">
          <span className="text-[#8b949e] font-medium">Suggestion: </span>
          {insight.suggestion}
        </p>
      )}
    </div>
  );
}

// ── Filter Select ──────────────────────────────────────────────────────────────

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

// ── Collapsible Section Card ───────────────────────────────────────────────────

function Section({
  title, subtitle, defaultOpen = true, children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
      <button
        className="w-full flex items-start justify-between px-4 py-3 text-left hover:bg-[#1c2128] transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {subtitle && <p className="text-xs text-[#6e7681] mt-0.5">{subtitle}</p>}
        </div>
        <span className="text-[#6e7681] text-sm mt-0.5 ml-4 shrink-0">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="border-t border-[#21262d] px-4 py-5">{children}</div>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function AnalyticsClient({ walletAddress }: { walletAddress: string }) {
  const [filters, setFilters] = useState<AnalyticsFilters>(EMPTY_FILTERS);
  const [assetOptions, setAssetOptions] = useState<string[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);

  const set = useCallback(<K extends keyof AnalyticsFilters>(key: K, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
  }, []);

  // Populate asset options from trade-units (same wallet)
  useEffect(() => {
    fetch(`/api/trade-units?walletAddress=${walletAddress}&pageSize=500`)
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
  }, [walletAddress]);

  // Load insights once on mount
  useEffect(() => {
    fetch(`/api/analytics/insights?walletAddress=${walletAddress}`)
      .then((r) => r.json())
      .then((d) => setInsights(d.insights ?? []))
      .catch(() => {});
  }, [walletAddress]);

  const hasFilters = Object.values(filters).some(Boolean);
  const chartProps = { walletAddress, filters };

  // Group insights by category in display order
  const insightsByCategory = CATEGORY_ORDER.reduce<Record<string, Insight[]>>((acc, cat) => {
    const group = insights.filter((i) => i.category === cat);
    if (group.length > 0) acc[cat] = group;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-lg font-semibold text-white">Analytics</h1>
        <p className="text-xs text-[#6e7681] mt-0.5">
          Deep-dive charts. All sections update when you apply filters.
        </p>
      </div>

      {/* ── Filter Bar ─────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
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

      {/* ── Calendar Heatmap ───────────────────────────────────────────── */}
      <Section
        title="Calendar"
        subtitle="Daily P&L — darker = larger magnitude. Hover a day for details."
      >
        <CalendarHeatmap {...chartProps} />
      </Section>

      {/* ── Time Analysis ──────────────────────────────────────────────── */}
      <Section
        title="When Do You Trade Best?"
        subtitle="P&L by hour of day and day of week."
      >
        <TimeAnalysis {...chartProps} />
      </Section>

      {/* ── Exit Analysis ──────────────────────────────────────────────── */}
      <Section
        title="Are You Cutting Winners Short?"
        subtitle="MFE/MAE scatter and exit efficiency distribution."
      >
        <ExitAnalysis {...chartProps} />
      </Section>

      {/* ── Strategy Breakdown ─────────────────────────────────────────── */}
      <Section
        title="How Do Your Strategies Compare?"
        subtitle="Side-by-side stats per trade type. Regime mini-bars show win rate by market condition."
      >
        <StrategyBreakdown {...chartProps} />
      </Section>

      {/* ── What If ────────────────────────────────────────────────────── */}
      <Section
        title="What If?"
        subtitle="Explore how your stats change under hypothetical filters."
        defaultOpen={false}
      >
        <WhatIfExplorer {...chartProps} />
      </Section>

      {/* ── Regime Performance ─────────────────────────────────────────── */}
      <Section
        title="Regime Performance"
        subtitle="P&L chart, trade distribution, and detailed stats per market regime."
      >
        <RegimePerformance {...chartProps} />
      </Section>

      {/* ── ML Patterns ────────────────────────────────────────────────── */}
      <Section
        title="Patterns (ML)"
        subtitle="Clusters, anomalies, and serial-dependence discovered by ML over your trade history."
        defaultOpen={false}
      >
        <PatternsSection walletAddress={walletAddress} />
      </Section>

      {/* ── Behavioural Insights ───────────────────────────────────────── */}
      {insights.length > 0 && (
        <Section
          title="Behavioural Insights"
          subtitle={`${insights.length} pattern${insights.length > 1 ? 's' : ''} detected · ${insights.filter((i) => i.isSignificant).length} statistically significant`}
        >
          <div className="space-y-6">
            {Object.entries(insightsByCategory).map(([category, group]) => (
              <div key={category}>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-[#6e7681] mb-3">
                  {CATEGORY_LABEL[category] ?? category}
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {group.map((insight, i) => (
                    <InsightCard key={`${insight.module}-${i}`} insight={insight} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
