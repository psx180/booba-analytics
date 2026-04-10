'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TradeUnit {
  id: string;
  kind: 'position' | 'linked_strategy';
  asset: string;
  direction: string;
  tradeType: string | null;
  status: string;
  pnl: number | null;
  fees: number | null;
  funding: number | null;
  totalSize: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  holdTimeSeconds: number | null;
  confidence: number | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  regimeAtEntry: string | null;
  childCount: number;
  strategyType?: string;
  netDelta?: number | null;
  spreadPnl?: number | null;
  legs?: { id: string; asset: string; direction: string; pnl: number | null; status: string }[];
}

interface OrderGroup {
  id: string;
  asset: string;
  direction: string;
  tradeType: string | null;
  totalSize: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  aggregatePnl: number | null;
  aggregateFees: number | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  confidence: number | null;
  _count: { trades: number };
  role: string;
  executionType: string | null;
  isEntry: boolean;
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
  regimeAtEntry: string | null;
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

const POSITION_TYPES = [
  'scalp', 'directional', 'scaled_directional', 'carry_trade', 'market_making',
];

const REGIME_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  trending_low_vol:  { label: 'Trending',    bg: 'bg-green-900/40',  text: 'text-green-400' },
  trending_high_vol: { label: 'Trending HV', bg: 'bg-green-900/30',  text: 'text-green-300' },
  ranging_low_vol:   { label: 'Ranging',     bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  ranging_high_vol:  { label: 'Ranging HV',  bg: 'bg-amber-900/30',  text: 'text-amber-300' },
  transitional:      { label: 'Trans.',      bg: 'bg-slate-700/40',  text: 'text-slate-400' },
};

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

const ROLE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  entry:        { bg: 'bg-blue-900/30',  text: 'text-blue-400',  label: 'Entry' },
  'take profit': { bg: 'bg-green-900/30', text: 'text-green-400', label: 'TP' },
  'stop loss':  { bg: 'bg-red-900/30',   text: 'text-red-400',   label: 'SL' },
  'manual close': { bg: 'bg-slate-700/40', text: 'text-slate-400', label: 'Close' },
};

function typeBadgeClass(type: string | null) {
  if (!type) return 'text-[#6e7681] bg-[#21262d]';
  const colors: Record<string, string> = {
    scalp: 'text-cyan-400 bg-cyan-900/30',
    directional: 'text-blue-400 bg-blue-900/30',
    scaled_directional: 'text-indigo-400 bg-indigo-900/30',
    market_making: 'text-purple-400 bg-purple-900/30',
    carry_trade: 'text-orange-400 bg-orange-900/30',
    delta_neutral: 'text-teal-400 bg-teal-900/30',
    pairs_trade: 'text-pink-400 bg-pink-900/30',
    basis_trade: 'text-emerald-400 bg-emerald-900/30',
  };
  return colors[type] ?? 'text-[#6e7681] bg-[#21262d]';
}

// ── Filter Select ─────────────────────────────────────────────────────────────

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

// ── Sort Header ───────────────────────────────────────────────────────────────

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

// ── Fills panel (innermost drill-down) ────────────────────────────────────────

function FillsPanel({ orderGroupId }: { orderGroupId: string }) {
  const [fills, setFills] = useState<Fill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/orders/${orderGroupId}/fills`)
      .then((r) => r.json())
      .then((d) => setFills(d.fills ?? []))
      .finally(() => setLoading(false));
  }, [orderGroupId]);

  if (loading) return <div className="px-12 py-2 text-xs text-[#6e7681]">Loading fills...</div>;

  return (
    <div className="pl-16 pr-4 py-1">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[#6e7681]">
            <th className="pb-1 pr-3 text-left">Side</th>
            <th className="pb-1 pr-3 text-left">Size</th>
            <th className="pb-1 pr-3 text-left">Entry</th>
            <th className="pb-1 pr-3 text-left">Exit</th>
            <th className="pb-1 pr-3 text-left">P&L</th>
            <th className="pb-1 pr-3 text-left">Fees</th>
            <th className="pb-1 text-left">Time</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f) => (
            <tr key={f.id} className="border-t border-[#161b22]">
              <td className="py-1 pr-3">
                <span className={f.direction === 'long' ? 'text-green-400' : 'text-red-400'}>
                  {f.direction.toUpperCase()}
                </span>
              </td>
              <td className="py-1 pr-3 text-[#8b949e]">{f.size}</td>
              <td className="py-1 pr-3 text-[#8b949e]">{fmtPrice(f.entryPrice)}</td>
              <td className="py-1 pr-3 text-[#8b949e]">{fmtPrice(f.exitPrice)}</td>
              <td className={`py-1 pr-3 ${f.exitPrice == null ? 'text-[#6e7681]' : pnlColor(f.pnlRealized)}`}>
                {f.exitPrice == null ? '—' : fmt$(f.pnlRealized)}
              </td>
              <td className="py-1 pr-3 text-[#6e7681]">
                {f.fees != null ? `-$${Math.abs(f.fees).toFixed(2)}` : '—'}
              </td>
              <td className="py-1 text-[#6e7681]">{fmtDate(f.exitTime ?? f.entryTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Orders panel (middle drill-down) ──────────────────────────────────────────

function OrdersPanel({ positionId }: { positionId: string }) {
  const [orders, setOrders] = useState<OrderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/positions/${positionId}/orders`)
      .then((r) => r.json())
      .then((d) => setOrders(d.orders ?? []))
      .finally(() => setLoading(false));
  }, [positionId]);

  if (loading) return <div className="px-8 py-3 text-xs text-[#6e7681]">Loading orders...</div>;

  return (
    <div className="px-4 py-2 bg-[#0d1117]">
      <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-2 px-4">
        {orders.length} orders in this position
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
            <th className="pb-1 pr-3 text-left w-6" />
            <th className="pb-1 pr-3 text-left">Role</th>
            <th className="pb-1 pr-3 text-left">Dir</th>
            <th className="pb-1 pr-3 text-left">Fills</th>
            <th className="pb-1 pr-3 text-left">Size</th>
            <th className="pb-1 pr-3 text-left">Entry</th>
            <th className="pb-1 pr-3 text-left">Exit</th>
            <th className="pb-1 pr-3 text-left">P&L</th>
            <th className="pb-1 pr-3 text-left">Exec</th>
            <th className="pb-1 text-left">Time</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const isSingleFill = order._count.trades === 1;
            const isExpanded = expandedOrder === order.id;
            const canExpand = !isSingleFill;
            const roleBadge = ROLE_BADGE[order.role];

            return (
              <Fragment key={order.id}>
                <tr
                  onClick={() => canExpand && setExpandedOrder(isExpanded ? null : order.id)}
                  className={`border-t border-[#161b22] ${canExpand ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-[#161b22]' : canExpand ? 'hover:bg-[#161b22]' : ''}`}
                >
                  <td className="py-1 pr-3 text-[#6e7681]">
                    {canExpand ? (isExpanded ? '▾' : '▸') : ''}
                  </td>
                  <td className="py-1 pr-3">
                    {roleBadge ? (
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${roleBadge.bg} ${roleBadge.text}`}>
                        {roleBadge.label}
                      </span>
                    ) : (
                      <span className="text-[#6e7681]">{order.role}</span>
                    )}
                  </td>
                  <td className="py-1 pr-3">
                    <span className={order.direction === 'long' ? 'text-green-400' : 'text-red-400'}>
                      {order.direction.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-1 pr-3 text-[#8b949e]">{order._count.trades}</td>
                  <td className="py-1 pr-3 text-[#8b949e]">{order.totalSize?.toFixed(4) ?? '—'}</td>
                  <td className="py-1 pr-3 text-[#8b949e]">{fmtPrice(order.averageEntryPrice)}</td>
                  <td className="py-1 pr-3 text-[#8b949e]">{fmtPrice(order.averageExitPrice)}</td>
                  <td className={`py-1 pr-3 ${order.isEntry ? 'text-[#6e7681]' : pnlColor(order.aggregatePnl)}`}>
                    {order.isEntry ? '—' : fmt$(order.aggregatePnl)}
                  </td>
                  <td className="py-1 pr-3 text-[#6e7681]">
                    {order.executionType ?? '—'}
                  </td>
                  <td className="py-1 text-[#6e7681]">{fmtDate(order.lastExitTime ?? order.firstEntryTime)}</td>
                </tr>
                {isExpanded && canExpand && (
                  <tr>
                    <td colSpan={10} className="p-0">
                      <FillsPanel orderGroupId={order.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface Filters {
  tradeType: string;
  asset: string;
  status: string;
}

const EMPTY_FILTERS: Filters = { tradeType: '', asset: '', status: '' };

export default function TradesClient({ walletAddress }: { walletAddress: string }) {
  const [tradeUnits, setTradeUnits] = useState<TradeUnit[]>([]);
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

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ walletAddress, sortBy, sortDir, page: String(page) });
      if (filters.tradeType) p.set('tradeType', filters.tradeType);
      if (filters.asset) p.set('asset', filters.asset);
      if (filters.status) p.set('status', filters.status);

      const [unitsRes, summaryRes] = await Promise.all([
        fetch(`/api/trade-units?${p}`),
        fetch(`/api/analytics/summary?walletAddress=${walletAddress}`),
      ]);
      const [unitsData, summaryData] = await Promise.all([
        unitsRes.json(),
        summaryRes.json(),
      ]);

      setTradeUnits(unitsData.tradeUnits ?? []);
      setPagination(unitsData.pagination ?? null);
      // /api/analytics/summary now returns an AggregationResult envelope —
      // the flat performance stats live under .data.
      setSummary(summaryData?.data ?? null);

      if (!filters.tradeType && !filters.asset && !filters.status) {
        const assets = [...new Set<string>(
          (unitsData.tradeUnits ?? [])
            .map((u: TradeUnit) => u.asset)
            .flatMap((a: string) => a.split(' / ')),
        )];
        setAssetOptions(assets.sort());
      }
    } finally {
      setLoading(false);
    }
  }, [walletAddress, sortBy, sortDir, page, filters]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { setPage(1); }, [filters, sortBy, sortDir]);

  const handleSort = (field: string) => {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir('desc'); }
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
      await fetchData();
    } finally {
      setGroupingRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Stats Bar ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Positions', value: summary?.tradeCount ?? '—' },
          {
            label: 'Total P&L',
            value: <span className={pnlColor(summary?.totalPnl ?? null)}>{summary ? fmt$(summary.totalPnl) : '—'}</span>,
          },
          { label: 'Win Rate', value: summary ? `${(summary.winRate * 100).toFixed(1)}%` : '—' },
          {
            label: 'Expectancy',
            value: <span className={pnlColor(summary?.expectancy ?? null)}>{summary ? fmt$(summary.expectancy) : '—'}</span>,
          },
          { label: 'Profit Factor', value: summary ? summary.profitFactor.toFixed(2) : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
            <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">{label}</div>
            <div className="text-lg font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {/* ── Run Grouping ───────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Trade Grouping</h2>
            <p className="text-xs text-[#6e7681] mt-0.5">
              Fills → Orders → Positions. Link positions into strategies manually.
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
              <span className="text-white font-medium">{groupingSummary.totalFills}</span> fills →{' '}
              <span className="text-white font-medium">{groupingSummary.totalOrders}</span> orders →{' '}
              <span className="text-white font-medium">{groupingSummary.totalPositions}</span> positions.{' '}
              {groupingSummary.totalLinkedStrategies > 0 && (
                <span><span className="text-white font-medium">{groupingSummary.totalLinkedStrategies}</span> linked strategies. </span>
              )}
              <span className="text-amber-400">{groupingSummary.needsReview}</span> need review.
            </div>
            {groupingSummary.positionsByType && Object.keys(groupingSummary.positionsByType).length > 0 && (
              <div className="flex flex-wrap gap-3">
                {Object.entries(groupingSummary.positionsByType).map(([type, count]) => (
                  <span key={type} className="text-[#6e7681]">
                    {type.replace(/_/g, ' ')}: <span className="text-[#8b949e]">{count as number}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Filter Bar ─────────────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <FilterSelect
            label="Trade Type"
            value={filters.tradeType}
            onChange={(v) => setFilters((f) => ({ ...f, tradeType: v }))}
            options={[...POSITION_TYPES, 'delta_neutral', 'pairs_trade', 'basis_trade']}
          />
          <FilterSelect
            label="Asset"
            value={filters.asset}
            onChange={(v) => setFilters((f) => ({ ...f, asset: v }))}
            options={assetOptions}
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
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

      {/* ── Trade Units Table ──────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        {loading ? (
          <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">Loading...</div>
        ) : tradeUnits.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-[#6e7681] text-sm gap-2">
            <span>No trade units found. Run the grouping pipeline first.</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-[#6e7681] border-b border-[#21262d]">
                  <th className="px-4 py-3 text-left w-8" />
                  <SortTh label="Asset" field="asset" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Dir</th>
                  <th className="pb-2 pr-4 text-left">Children</th>
                  <th className="pb-2 pr-4 text-left">Entry</th>
                  <th className="pb-2 pr-4 text-left">Exit</th>
                  <SortTh label="P&L" field="pnl" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Fees" field="fees" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Hold" field="holdTimeSeconds" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Type</th>
                  <SortTh label="Conf." field="confidence" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left">Regime</th>
                  <SortTh label="Date" field="firstEntryTime" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {tradeUnits.map((unit) => {
                  const isExpanded = expandedId === unit.id;
                  const conf = confidenceBadge(unit.confidence);
                  const regime = unit.regimeAtEntry ? REGIME_BADGE[unit.regimeAtEntry] : null;
                  const isLinked = unit.kind === 'linked_strategy';

                  return (
                    <Fragment key={unit.id}>
                      <tr
                        onClick={() => setExpandedId(isExpanded ? null : unit.id)}
                        className={`border-t border-[#21262d] cursor-pointer transition-colors ${
                          isExpanded ? 'bg-[#1c2128]' : 'hover:bg-[#1c2128]'
                        }`}
                      >
                        <td className="px-4 py-2.5 text-[#6e7681] text-xs">
                          {isExpanded ? '▾' : '▸'}
                        </td>
                        <td className="py-2.5 pr-4 font-medium text-white">
                          {unit.asset}
                          {isLinked && (
                            <span className="ml-1.5 text-[10px] text-teal-400 bg-teal-900/30 px-1 py-0.5 rounded">
                              linked
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4">
                          {isLinked ? (
                            <span className="text-xs text-[#6e7681]">
                              {unit.legs?.map((l) => l.direction[0].toUpperCase()).join('/') ?? '—'}
                            </span>
                          ) : (
                            <span className={`text-xs font-medium ${unit.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                              {unit.direction.toUpperCase()}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 text-[#8b949e] text-xs">
                          {isLinked ? `${unit.childCount} legs` : `${unit.childCount} orders`}
                        </td>
                        <td className="py-2.5 pr-4 text-[#8b949e]">{fmtPrice(unit.averageEntryPrice)}</td>
                        <td className="py-2.5 pr-4 text-[#8b949e]">{fmtPrice(unit.averageExitPrice)}</td>
                        <td className={`py-2.5 pr-4 font-medium ${pnlColor(unit.pnl)}`}>{fmt$(unit.pnl)}</td>
                        <td className="py-2.5 pr-4 text-[#6e7681] text-xs">
                          {unit.fees != null ? `-$${Math.abs(unit.fees).toFixed(2)}` : '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-[#6e7681] text-xs">
                          {fmtHoldTime(unit.holdTimeSeconds)}
                        </td>
                        <td className="py-2.5 pr-4">
                          {unit.tradeType ? (
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${typeBadgeClass(unit.tradeType)}`}>
                              {unit.tradeType.replace(/_/g, ' ')}
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
                        <td className="py-2.5 pr-4">
                          {regime ? (
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${regime.bg} ${regime.text}`}>
                              {regime.label}
                            </span>
                          ) : (
                            <span className="text-[#6e7681]">—</span>
                          )}
                        </td>
                        <td className="py-2.5 text-xs text-[#6e7681]">
                          {fmtDate(unit.lastExitTime ?? unit.firstEntryTime)}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-[#0d1117]">
                          <td colSpan={13} className="p-0">
                            {isLinked && unit.legs ? (
                              <div className="px-4 py-2 space-y-2">
                                <div className="text-[10px] uppercase tracking-widest text-[#6e7681] px-4">
                                  {unit.legs.length} position legs
                                  {unit.netDelta != null && (
                                    <span className="ml-3">Net delta: <span className="text-[#8b949e]">${Math.abs(unit.netDelta).toFixed(2)}</span></span>
                                  )}
                                </div>
                                {unit.legs.map((leg) => (
                                  <div key={leg.id} className="bg-[#161b22] rounded p-3">
                                    <div className="flex items-center gap-3 text-xs mb-2">
                                      <span className="font-medium text-white">{leg.asset}</span>
                                      <span className={leg.direction === 'long' ? 'text-green-400' : 'text-red-400'}>
                                        {leg.direction.toUpperCase()}
                                      </span>
                                      <span className={pnlColor(leg.pnl)}>{fmt$(leg.pnl)}</span>
                                      <span className="text-[#6e7681]">{leg.status}</span>
                                    </div>
                                    <OrdersPanel positionId={leg.id} />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <OrdersPanel positionId={unit.id} />
                            )}
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

        {/* ── Pagination ─────────────────────────────────────────── */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#21262d] text-xs text-[#6e7681]">
            <span>
              {pagination.total} trade units · page {pagination.page} of {pagination.totalPages}
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
