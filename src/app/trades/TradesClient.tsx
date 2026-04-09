'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TradeGroup {
  id: string;
  asset: string;
  direction: string;
  tradeType: string | null;
  status: string;
  totalSize: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  aggregatePnl: number | null;
  aggregateFees: number | null;
  aggregateFunding: number | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  holdTimeSeconds: number | null;
  confidence: number | null;
  ruleSource: string | null;
  linkedGroupId: string | null;
  strategy: { name: string } | null;
  _count: { trades: number };
}

interface Fill {
  id: string;
  asset: string;
  direction: string;
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  entryTime: string | null;
  exitTime: string | null;
  pnlRealized: number | null;
  fees: number | null;
  fundingEarned: number | null;
  fundingPaid: number | null;
  holdTimeSeconds: number | null;
  regimeAtEntry: string | null;
  tradeType: string | null;
  rawData: string | null;
}

interface Pagination {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface Summary {
  tradeCount: number;
  totalPnl: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TRADE_TYPES = [
  'scalp', 'directional', 'scaled_directional', 'market_making',
  'delta_neutral', 'pairs_trade', 'carry_trade',
];

const REGIME_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  trending_low_vol:  { label: 'Trending',    bg: 'bg-green-900/40',  text: 'text-green-400' },
  trending_high_vol: { label: 'Trending HV', bg: 'bg-green-900/30',  text: 'text-green-300' },
  ranging_low_vol:   { label: 'Ranging',     bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  ranging_high_vol:  { label: 'Ranging HV',  bg: 'bg-amber-900/30',  text: 'text-amber-300' },
  transitional:      { label: 'Trans.',      bg: 'bg-slate-700/40',  text: 'text-slate-400' },
};

const SORT_FIELDS = [
  { key: 'firstEntryTime', label: 'Date' },
  { key: 'asset',          label: 'Asset' },
  { key: 'aggregatePnl',   label: 'P&L' },
  { key: 'aggregateFees',  label: 'Fees' },
  { key: 'holdTimeSeconds', label: 'Hold Time' },
  { key: 'confidence',     label: 'Confidence' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pnlColor(v: number | null) {
  if (v == null) return 'text-[#6e7681]';
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

function fmt$(v: number | null, fallback = '—') {
  if (v == null) return fallback;
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

function fmtPrice(v: number | null) {
  if (v == null) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtHoldTime(s: number | null) {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function confidenceBadge(c: number | null) {
  if (c == null) return null;
  if (c > 0.8) return { bg: 'bg-green-900/30', text: 'text-green-400', label: `${Math.round(c * 100)}%` };
  if (c >= 0.5) return { bg: 'bg-amber-900/30', text: 'text-amber-400', label: `${Math.round(c * 100)}%` };
  return { bg: 'bg-red-900/30', text: 'text-red-400', label: `${Math.round(c * 100)}%` };
}

function tradeTypeBadge(type: string | null) {
  if (!type) return null;
  const colors: Record<string, string> = {
    scalp: 'text-cyan-400 bg-cyan-900/30',
    directional: 'text-blue-400 bg-blue-900/30',
    scaled_directional: 'text-indigo-400 bg-indigo-900/30',
    market_making: 'text-purple-400 bg-purple-900/30',
    delta_neutral: 'text-teal-400 bg-teal-900/30',
    pairs_trade: 'text-pink-400 bg-pink-900/30',
    carry_trade: 'text-orange-400 bg-orange-900/30',
  };
  return colors[type] ?? 'text-[#6e7681] bg-[#21262d]';
}

// ── Filter Bar ────────────────────────────────────────────────────────────────

interface Filters {
  tradeType: string;
  asset: string;
  status: string;
}

const EMPTY_FILTERS: Filters = { tradeType: '', asset: '', status: '' };

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void; options: string[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-widest text-[#6e7681]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[#21262d] border border-[#30363d] text-sm text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500 min-w-[120px]"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>
        ))}
      </select>
    </div>
  );
}

// ── Sort Header Cell ──────────────────────────────────────────────────────────

function SortTh({
  label, field, sortBy, sortDir, onSort,
}: {
  label: string; field: string; sortBy: string; sortDir: 'asc' | 'desc'; onSort: (f: string) => void;
}) {
  const active = sortBy === field;
  return (
    <th
      className="pb-2 pr-4 text-left cursor-pointer select-none hover:text-white transition-colors whitespace-nowrap"
      onClick={() => onSort(field)}
    >
      {label}
      {active && <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}

// ── Expanded Fills Table ──────────────────────────────────────────────────────

function GroupFills({ groupId }: { groupId: string }) {
  const [fills, setFills] = useState<Fill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/groups/${groupId}/fills`)
      .then((r) => r.json())
      .then((data) => setFills(data.fills ?? []))
      .finally(() => setLoading(false));
  }, [groupId]);

  if (loading) {
    return (
      <div className="px-8 py-3 text-xs text-[#6e7681]">Loading fills...</div>
    );
  }

  return (
    <div className="px-4 py-2 bg-[#0d1117]">
      <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-2 px-4">
        {fills.length} fills in this group
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
            <th className="pb-1 pr-3 text-left">Side</th>
            <th className="pb-1 pr-3 text-left">Size</th>
            <th className="pb-1 pr-3 text-left">Entry</th>
            <th className="pb-1 pr-3 text-left">Exit</th>
            <th className="pb-1 pr-3 text-left">P&L</th>
            <th className="pb-1 pr-3 text-left">Fees</th>
            <th className="pb-1 pr-3 text-left">Regime</th>
            <th className="pb-1 text-left">Time</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((fill) => {
            const regime = fill.regimeAtEntry ? REGIME_BADGE[fill.regimeAtEntry] : null;
            return (
              <tr key={fill.id} className="border-t border-[#161b22]">
                <td className="py-1 pr-3">
                  <span className={fill.direction === 'long' ? 'text-green-400' : 'text-red-400'}>
                    {fill.direction.toUpperCase()}
                  </span>
                </td>
                <td className="py-1 pr-3 text-[#8b949e]">{fill.size}</td>
                <td className="py-1 pr-3 text-[#8b949e]">{fmtPrice(fill.entryPrice)}</td>
                <td className="py-1 pr-3 text-[#8b949e]">{fmtPrice(fill.exitPrice)}</td>
                <td className={`py-1 pr-3 ${pnlColor(fill.pnlRealized)}`}>{fmt$(fill.pnlRealized)}</td>
                <td className="py-1 pr-3 text-[#6e7681]">
                  {fill.fees != null ? `-$${Math.abs(fill.fees).toFixed(2)}` : '—'}
                </td>
                <td className="py-1 pr-3">
                  {regime ? (
                    <span className={`inline-block px-1 py-0.5 rounded text-xs ${regime.bg} ${regime.text}`}>
                      {regime.label}
                    </span>
                  ) : (
                    <span className="text-[#6e7681]">—</span>
                  )}
                </td>
                <td className="py-1 text-[#6e7681]">
                  {fmtDate(fill.exitTime ?? fill.entryTime)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function TradesClient({ walletAddress }: { walletAddress: string }) {
  const [groups, setGroups] = useState<TradeGroup[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sortBy, setSortBy] = useState('firstEntryTime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [assetOptions, setAssetOptions] = useState<string[]>([]);
  const [groupingRunning, setGroupingRunning] = useState(false);
  const [groupingSummary, setGroupingSummary] = useState<any>(null);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ walletAddress, sortBy, sortDir, page: String(page) });
      if (filters.tradeType) p.set('tradeType', filters.tradeType);
      if (filters.asset) p.set('asset', filters.asset);
      if (filters.status) p.set('status', filters.status);

      const [groupsRes, summaryRes] = await Promise.all([
        fetch(`/api/groups?${p}`),
        fetch(`/api/analytics/summary?walletAddress=${walletAddress}`),
      ]);
      const [groupsData, summaryData] = await Promise.all([
        groupsRes.json(),
        summaryRes.json(),
      ]);

      setGroups(groupsData.groups ?? []);
      setPagination(groupsData.pagination ?? null);
      setSummary(summaryData);

      if (!filters.tradeType && !filters.asset && !filters.status) {
        const assets = [...new Set<string>((groupsData.groups ?? []).map((g: TradeGroup) => g.asset))];
        setAssetOptions(assets.sort());
      }
    } finally {
      setLoading(false);
    }
  }, [walletAddress, sortBy, sortDir, page, filters]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  useEffect(() => {
    setPage(1);
  }, [filters, sortBy, sortDir]);

  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('desc');
    }
  };

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const runGrouping = async () => {
    setGroupingRunning(true);
    setGroupingSummary(null);
    try {
      const res = await fetch('/api/grouping/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });
      const data = await res.json();
      setGroupingSummary(data);
      await fetchGroups();
    } finally {
      setGroupingRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Stats Bar ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Groups', value: summary?.tradeCount ?? '—' },
          {
            label: 'Total P&L',
            value: (
              <span className={pnlColor(summary?.totalPnl ?? null)}>
                {summary ? fmt$(summary.totalPnl) : '—'}
              </span>
            ),
          },
          { label: 'Win Rate', value: summary ? `${summary.winRate.toFixed(1)}%` : '—' },
          {
            label: 'Expectancy',
            value: (
              <span className={pnlColor(summary?.expectancy ?? null)}>
                {summary ? fmt$(summary.expectancy) : '—'}
              </span>
            ),
          },
          { label: 'Profit Factor', value: summary ? summary.profitFactor.toFixed(2) : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
            <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">{label}</div>
            <div className="text-lg font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {/* ── Run Grouping + Summary ──────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Trade Grouping</h2>
            <p className="text-xs text-[#6e7681] mt-0.5">
              Group individual fills into logical trades using the rule pipeline
            </p>
          </div>
          <button
            onClick={runGrouping}
            disabled={groupingRunning}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-400 text-white text-sm font-medium rounded transition-colors"
          >
            {groupingRunning ? 'Running...' : 'Run Grouping'}
          </button>
        </div>

        {groupingSummary && (
          <div className="mt-3 pt-3 border-t border-[#21262d] text-xs text-[#8b949e] space-y-1">
            <div>
              Grouped <span className="text-white font-medium">{groupingSummary.totalFills}</span> fills into{' '}
              <span className="text-white font-medium">{groupingSummary.totalGroups}</span> trades.{' '}
              <span className="text-green-400">{groupingSummary.autoGroupedHighConfidence}</span> high confidence.{' '}
              <span className="text-amber-400">{groupingSummary.needsReview}</span> need review.
            </div>
            {groupingSummary.byRule && (
              <div className="flex flex-wrap gap-3">
                {Object.entries(groupingSummary.byRule).map(([rule, count]) => (
                  <span key={rule} className="text-[#6e7681]">
                    {rule}: <span className="text-[#8b949e]">{count as number}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Filter Bar ──────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <FilterSelect
            label="Trade Type"
            value={filters.tradeType}
            onChange={(v) => handleFilterChange('tradeType', v)}
            options={TRADE_TYPES}
          />
          <FilterSelect
            label="Asset"
            value={filters.asset}
            onChange={(v) => handleFilterChange('asset', v)}
            options={assetOptions}
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            onChange={(v) => handleFilterChange('status', v)}
            options={['open', 'closed']}
          />
          {Object.values(filters).some(Boolean) && (
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="text-xs text-[#6e7681] hover:text-white bg-[#21262d] border border-[#30363d] rounded px-3 py-1.5 transition-colors self-end"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Groups Table ────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        {loading ? (
          <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
            Loading...
          </div>
        ) : groups.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-[#6e7681] text-sm gap-2">
            <span>No trade groups found. Run the grouping pipeline first.</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
                  <th className="px-4 py-3 text-left w-8" />
                  <SortTh label="Asset" field="asset" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Dir</th>
                  <th className="pb-2 pr-4 text-left">Fills</th>
                  <th className="pb-2 pr-4 text-left">Entry</th>
                  <th className="pb-2 pr-4 text-left">Exit</th>
                  <SortTh label="P&L" field="aggregatePnl" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Fees" field="aggregateFees" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Hold" field="holdTimeSeconds" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Type</th>
                  <SortTh label="Conf." field="confidence" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Rule</th>
                  <SortTh label="Date" field="firstEntryTime" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isExpanded = expandedId === group.id;
                  const conf = confidenceBadge(group.confidence);
                  const typeClass = tradeTypeBadge(group.tradeType);
                  return (
                    <Fragment key={group.id}>
                      <tr
                        onClick={() => setExpandedId(isExpanded ? null : group.id)}
                        className={`border-t border-[#21262d] cursor-pointer transition-colors ${
                          isExpanded ? 'bg-[#1c2128]' : 'hover:bg-[#1c2128]'
                        }`}
                      >
                        <td className="px-4 py-2.5 text-[#6e7681] text-xs">
                          {isExpanded ? '▾' : '▸'}
                        </td>
                        <td className="py-2.5 pr-4 font-medium text-white">{group.asset}</td>
                        <td className="py-2.5 pr-4">
                          <span className={`text-xs font-medium ${group.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                            {group.direction.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-[#8b949e] text-xs">
                          {group._count.trades}
                        </td>
                        <td className="py-2.5 pr-4 text-[#8b949e]">{fmtPrice(group.averageEntryPrice)}</td>
                        <td className="py-2.5 pr-4 text-[#8b949e]">{fmtPrice(group.averageExitPrice)}</td>
                        <td className={`py-2.5 pr-4 font-medium ${pnlColor(group.aggregatePnl)}`}>
                          {fmt$(group.aggregatePnl)}
                        </td>
                        <td className="py-2.5 pr-4 text-[#6e7681] text-xs">
                          {group.aggregateFees != null ? `-$${Math.abs(group.aggregateFees).toFixed(2)}` : '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-[#6e7681] text-xs">
                          {fmtHoldTime(group.holdTimeSeconds)}
                        </td>
                        <td className="py-2.5 pr-4">
                          {group.tradeType ? (
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${typeClass}`}>
                              {group.tradeType.replace(/_/g, ' ')}
                            </span>
                          ) : (
                            <span className="text-[#6e7681]">—</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4">
                          {conf ? (
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${conf.bg} ${conf.text}`}>
                              {conf.label}
                            </span>
                          ) : (
                            <span className="text-[#6e7681]">—</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-[#6e7681]">
                          {group.ruleSource ?? '—'}
                        </td>
                        <td className="py-2.5 text-xs text-[#6e7681]">
                          {fmtDate(group.lastExitTime ?? group.firstEntryTime)}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-[#0d1117]">
                          <td colSpan={13} className="p-0">
                            <GroupFills groupId={group.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Pagination ────────────────────────────────────────────── */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#21262d] text-xs text-[#6e7681]">
            <span>
              {pagination.total} groups · page {pagination.page} of {pagination.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 bg-[#21262d] rounded disabled:opacity-30 hover:text-white transition-colors"
              >
                Prev
              </button>
              <button
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 bg-[#21262d] rounded disabled:opacity-30 hover:text-white transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
