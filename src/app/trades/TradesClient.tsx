'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Trade {
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
  sourceTag: string | null;
  captureMode: string;
  thesis: string | null;
  invalidationPrice: number | null;
  targetPrice: string | null;
  mfePrice: number | null;
  maePnl: number | null;
  mfePnl: number | null;
  maePrice: number | null;
  rawData: string | null;
  strategy: { name: string } | null;
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

const REGIME_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  trending_low_vol:  { label: 'Trending',    bg: 'bg-green-900/40',  text: 'text-green-400' },
  trending_high_vol: { label: 'Trending ↑V', bg: 'bg-green-900/30',  text: 'text-green-300' },
  ranging_low_vol:   { label: 'Ranging',     bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  ranging_high_vol:  { label: 'Ranging ↑V',  bg: 'bg-amber-900/30',  text: 'text-amber-300' },
  transitional:      { label: 'Trans.',      bg: 'bg-slate-700/40',  text: 'text-slate-400' },
};

const SORT_FIELDS = [
  { key: 'exitTime',        label: 'Date' },
  { key: 'asset',           label: 'Asset' },
  { key: 'pnlRealized',     label: 'P&L' },
  { key: 'fees',            label: 'Fees' },
  { key: 'holdTimeSeconds', label: 'Hold Time' },
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

function RegimeBadge({ regime }: { regime: string | null }) {
  if (!regime) return <span className="text-[#6e7681]">—</span>;
  const b = REGIME_BADGE[regime];
  if (!b) return <span className="text-[#6e7681] text-xs">{regime}</span>;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${b.bg} ${b.text}`}>
      {b.label}
    </span>
  );
}

// ── Filter Bar ────────────────────────────────────────────────────────────────

interface Filters {
  regime: string;
  tradeType: string;
  strategy: string;
  source: string;
  asset: string;
}

const EMPTY_FILTERS: Filters = { regime: '', tradeType: '', strategy: '', source: '', asset: '' };

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
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
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

// ── Sort Header Cell ──────────────────────────────────────────────────────────

function SortTh({
  label,
  field,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  field: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSort: (field: string) => void;
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

// ── Expanded Trade Detail ─────────────────────────────────────────────────────

function TradeDetail({ trade }: { trade: Trade }) {
  return (
    <div className="px-4 py-3 bg-[#0d1117] border-t border-[#21262d] text-xs grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-[#8b949e]">
      {trade.thesis && (
        <div className="col-span-2 md:col-span-4">
          <span className="text-[#6e7681] uppercase tracking-wider mr-2">Thesis</span>
          <span className="text-[#e6edf3]">{trade.thesis}</span>
        </div>
      )}
      <div>
        <span className="text-[#6e7681] mr-1">Entry</span>
        <span>{fmtDate(trade.entryTime)}</span>
      </div>
      <div>
        <span className="text-[#6e7681] mr-1">Exit</span>
        <span>{fmtDate(trade.exitTime)}</span>
      </div>
      <div>
        <span className="text-[#6e7681] mr-1">Size</span>
        <span>{trade.size}</span>
      </div>
      <div>
        <span className="text-[#6e7681] mr-1">Hold</span>
        <span>{fmtHoldTime(trade.holdTimeSeconds)}</span>
      </div>
      {trade.invalidationPrice != null && (
        <div>
          <span className="text-[#6e7681] mr-1">Invalidation</span>
          <span>{fmtPrice(trade.invalidationPrice)}</span>
        </div>
      )}
      {trade.targetPrice && (
        <div>
          <span className="text-[#6e7681] mr-1">Target</span>
          <span>{trade.targetPrice}</span>
        </div>
      )}
      {trade.mfePrice != null && (
        <div>
          <span className="text-[#6e7681] mr-1">MFE</span>
          <span>{fmtPrice(trade.mfePrice)}</span>
          {trade.mfePnl != null && (
            <span className="ml-1 text-green-400">({fmt$(trade.mfePnl)})</span>
          )}
        </div>
      )}
      {trade.maePrice != null && (
        <div>
          <span className="text-[#6e7681] mr-1">MAE</span>
          <span>{fmtPrice(trade.maePrice)}</span>
          {trade.maePnl != null && (
            <span className="ml-1 text-red-400">({fmt$(trade.maePnl)})</span>
          )}
        </div>
      )}
      <div>
        <span className="text-[#6e7681] mr-1">Capture</span>
        <span>{trade.captureMode}</span>
      </div>
      {trade.fundingEarned != null && (
        <div>
          <span className="text-[#6e7681] mr-1">Funding Earned</span>
          <span className="text-green-400">{fmt$(trade.fundingEarned)}</span>
        </div>
      )}
      {trade.fundingPaid != null && (
        <div>
          <span className="text-[#6e7681] mr-1">Funding Paid</span>
          <span className="text-red-400">{fmt$(trade.fundingPaid)}</span>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function TradesClient({ walletAddress }: { walletAddress: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sortBy, setSortBy] = useState('exitTime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Collected filter options from loaded data
  const [assetOptions, setAssetOptions] = useState<string[]>([]);
  const [strategyOptions, setStrategyOptions] = useState<string[]>([]);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);

  const buildParams = useCallback(() => {
    const p = new URLSearchParams({ walletAddress, sortBy, sortDir, page: String(page) });
    if (filters.regime) p.set('regime', filters.regime);
    if (filters.tradeType) p.set('tradeType', filters.tradeType);
    if (filters.strategy) p.set('strategy', filters.strategy);
    if (filters.source) p.set('source', filters.source);
    if (filters.asset) p.set('asset', filters.asset);
    return p;
  }, [walletAddress, sortBy, sortDir, page, filters]);

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildParams();
      const [tradesRes, summaryRes] = await Promise.all([
        fetch(`/api/trades?${params}`),
        fetch(`/api/analytics/summary?${params}`),
      ]);
      const [tradesData, summaryData] = await Promise.all([
        tradesRes.json(),
        summaryRes.json(),
      ]);
      setTrades(tradesData.trades ?? []);
      setPagination(tradesData.pagination ?? null);
      setSummary(summaryData);

      // Accumulate filter options from the unfiltered first load
      if (
        !filters.regime && !filters.tradeType &&
        !filters.strategy && !filters.source && !filters.asset
      ) {
        const assets = [...new Set<string>((tradesData.trades ?? []).map((t: Trade) => t.asset))];
        const strategies = [...new Set<string>(
          (tradesData.trades ?? [])
            .map((t: Trade) => t.strategy?.name)
            .filter(Boolean) as string[]
        )];
        const sources = [...new Set<string>(
          (tradesData.trades ?? [])
            .map((t: Trade) => t.sourceTag)
            .filter(Boolean) as string[]
        )];
        setAssetOptions(assets.sort());
        setStrategyOptions(strategies.sort());
        setSourceOptions(sources.sort());
      }
    } finally {
      setLoading(false);
    }
  }, [buildParams, filters]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // Reset to page 1 when filters change
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

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="space-y-4">
      {/* ── Filtered Stats Bar ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Trades', value: summary?.tradeCount ?? '—' },
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

      {/* ── Filter Bar ──────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <FilterSelect
            label="Regime"
            value={filters.regime}
            onChange={(v) => handleFilterChange('regime', v)}
            options={[
              'trending_low_vol', 'trending_high_vol',
              'ranging_low_vol', 'ranging_high_vol', 'transitional',
            ]}
          />
          <FilterSelect
            label="Trade Type"
            value={filters.tradeType}
            onChange={(v) => handleFilterChange('tradeType', v)}
            options={['directional', 'carry', 'delta_neutral', 'market_making', 'liquidation_acquisition']}
          />
          <FilterSelect
            label="Strategy"
            value={filters.strategy}
            onChange={(v) => handleFilterChange('strategy', v)}
            options={strategyOptions}
          />
          <FilterSelect
            label="Source"
            value={filters.source}
            onChange={(v) => handleFilterChange('source', v)}
            options={sourceOptions}
          />
          <FilterSelect
            label="Asset"
            value={filters.asset}
            onChange={(v) => handleFilterChange('asset', v)}
            options={assetOptions}
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

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        {loading ? (
          <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">
            Loading…
          </div>
        ) : trades.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-[#6e7681] text-sm gap-2">
            <span>No trades found.</span>
            {Object.values(filters).some(Boolean) && (
              <button
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="text-xs text-blue-400 hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
                  <th className="px-4 py-3 text-left w-8" />
                  <SortTh label="Asset" field="asset" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Dir</th>
                  <th className="pb-2 pr-4 text-left">Entry</th>
                  <th className="pb-2 pr-4 text-left">Exit</th>
                  <SortTh label="P&L" field="pnlRealized" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Fees" field="fees" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Funding</th>
                  <SortTh label="Hold" field="holdTimeSeconds" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Regime</th>
                  <th className="pb-2 pr-4 text-left">Strategy</th>
                  <th className="pb-2 pr-4 text-left">Source</th>
                  <th className="pb-2 pr-4 text-left">Type</th>
                  <SortTh label="Date" field="exitTime" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {trades.map((trade) => {
                  const isExpanded = expandedId === trade.id;
                  const fundingNet = (trade.fundingEarned ?? 0) - (trade.fundingPaid ?? 0);
                  return (
                    <Fragment key={trade.id}>
                      <tr
                        onClick={() => toggleExpand(trade.id)}
                        className={`border-t border-[#21262d] cursor-pointer transition-colors ${
                          isExpanded ? 'bg-[#1c2128]' : 'hover:bg-[#1c2128]'
                        }`}
                      >
                        <td className="px-4 py-2.5 text-[#6e7681] text-xs">
                          {isExpanded ? '▾' : '▸'}
                        </td>
                        <td className="py-2.5 pr-4 font-medium text-white">{trade.asset}</td>
                        <td className="py-2.5 pr-4">
                          <span className={`text-xs font-medium ${trade.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                            {trade.direction.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-[#8b949e]">{fmtPrice(trade.entryPrice)}</td>
                        <td className="py-2.5 pr-4 text-[#8b949e]">{fmtPrice(trade.exitPrice)}</td>
                        <td className={`py-2.5 pr-4 font-medium ${pnlColor(trade.pnlRealized)}`}>
                          {fmt$(trade.pnlRealized)}
                        </td>
                        <td className="py-2.5 pr-4 text-[#6e7681] text-xs">
                          {trade.fees != null ? `-$${Math.abs(trade.fees).toFixed(2)}` : '—'}
                        </td>
                        <td className={`py-2.5 pr-4 text-xs ${fundingNet >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {trade.fundingEarned != null || trade.fundingPaid != null
                            ? fmt$(fundingNet)
                            : '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-[#6e7681] text-xs">
                          {fmtHoldTime(trade.holdTimeSeconds)}
                        </td>
                        <td className="py-2.5 pr-4">
                          <RegimeBadge regime={trade.regimeAtEntry} />
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-[#8b949e]">
                          {trade.strategy?.name ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-[#8b949e]">
                          {trade.sourceTag ?? '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-[#6e7681]">
                          {trade.tradeType ?? '—'}
                        </td>
                        <td className="py-2.5 text-xs text-[#6e7681]">
                          {fmtDate(trade.exitTime ?? trade.entryTime)}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-[#0d1117]">
                          <td colSpan={14} className="p-0">
                            <TradeDetail trade={trade} />
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

        {/* ── Pagination ────────────────────────────────────────────────── */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#21262d] text-xs text-[#6e7681]">
            <span>
              {pagination.total} trades · page {pagination.page} of {pagination.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 bg-[#21262d] rounded disabled:opacity-30 hover:text-white transition-colors"
              >
                ← Prev
              </button>
              <button
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 bg-[#21262d] rounded disabled:opacity-30 hover:text-white transition-colors"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
