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

  const hasFilters = Object.values(filters).some(Boolean);
  const chartProps = { walletAddress, filters };

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
    </div>
  );
}
