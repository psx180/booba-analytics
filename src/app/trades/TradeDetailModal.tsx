'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PositionDetail {
  id: string;
  asset: string;
  direction: string;
  tradeType: string | null;
  status: string;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  totalSize: number | null;
  aggregatePnl: number | null;
  aggregateFees: number | null;
  aggregateFunding: number | null;
  holdTimeSeconds: number | null;
  mfePnl: number | null;
  mfePriceDiff?: number | null;
  maePnl: number | null;
  exitEfficiency: number | null;
  moneyLeftOnTable: number | null;
  tiltScore: number | null;
  regimeAtEntry: string | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  thesis: string | null;
  strategyTag: string | null;
  sourceTag: string | null;
  conviction: number | null;
}

interface OrderGroup {
  id: string;
  direction: string;
  totalSize: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  aggregatePnl: number | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  role: string;
  executionType: string | null;
  isEntry: boolean;
  _count: { trades: number };
}

interface Fill {
  id: string;
  direction: string;
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  entryTime: string | null;
  exitTime: string | null;
  pnlRealized: number | null;
  fees: number | null;
}

interface Insight {
  module: string;
  title: string;
  description: string;
  severity: string;
  affectedPositions: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const REGIME_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  trending_low_vol:  { label: 'Trending',    bg: 'bg-green-900/40',  text: 'text-green-400' },
  trending_high_vol: { label: 'Trending HV', bg: 'bg-green-900/30',  text: 'text-green-300' },
  ranging_low_vol:   { label: 'Ranging',     bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  ranging_high_vol:  { label: 'Ranging HV',  bg: 'bg-amber-900/30',  text: 'text-amber-300' },
  transitional:      { label: 'Trans.',      bg: 'bg-slate-700/40',  text: 'text-slate-400' },
};

const ROLE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  entry:          { bg: 'bg-blue-900/30',   text: 'text-blue-400',   label: 'Entry' },
  'take profit':  { bg: 'bg-green-900/30',  text: 'text-green-400',  label: 'Take Profit' },
  'stop loss':    { bg: 'bg-red-900/30',    text: 'text-red-400',    label: 'Stop Loss' },
  'manual close': { bg: 'bg-slate-700/40',  text: 'text-slate-400',  label: 'Manual Close' },
};

const SEVERITY_BADGE: Record<string, { bg: string; text: string }> = {
  critical: { bg: 'bg-red-900/40',    text: 'text-red-400' },
  warning:  { bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  info:     { bg: 'bg-blue-900/30',   text: 'text-blue-400' },
};

// ── Formatters ─────────────────────────────────────────────────────────────────

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

function tiltColor(score0to100: number) {
  if (score0to100 < 30) return 'text-green-400';
  if (score0to100 < 60) return 'text-amber-400';
  return 'text-red-400';
}

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

// ── Fills sub-panel ────────────────────────────────────────────────────────────

function FillsSubPanel({ orderGroupId }: { orderGroupId: string }) {
  const [fills, setFills] = useState<Fill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/orders/${orderGroupId}/fills`)
      .then((r) => r.json())
      .then((d) => setFills(d.fills ?? []))
      .finally(() => setLoading(false));
  }, [orderGroupId]);

  if (loading) {
    return <div className="px-4 py-1 text-xs text-[#6e7681]">Loading fills...</div>;
  }

  return (
    <div className="pl-4 pr-2 py-1 bg-[#0a0e13] rounded-b">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-[#6e7681]">
            <th className="pb-1 pr-3 text-left">Side</th>
            <th className="pb-1 pr-3 text-left">Size</th>
            <th className="pb-1 pr-3 text-left">Entry</th>
            <th className="pb-1 pr-3 text-left">Exit</th>
            <th className="pb-1 text-left">P&L</th>
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
              <td className={`py-1 ${f.exitPrice == null ? 'text-[#6e7681]' : pnlColor(f.pnlRealized)}`}>
                {f.exitPrice == null ? '—' : fmt$(f.pnlRealized)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Conviction Stars ───────────────────────────────────────────────────────────

function ConvictionStars({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = (hovered ?? value ?? 0) >= n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n === value ? 0 : n)}
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(null)}
            className={`text-lg transition-colors ${filled ? 'text-amber-400' : 'text-[#30363d] hover:text-amber-300'}`}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}

// ── Main Modal ─────────────────────────────────────────────────────────────────

interface TradeDetailModalProps {
  positionId: string;
  walletAddress: string;
  onClose: () => void;
}

interface CandidatePosition {
  id: string;
  asset: string;
  direction: string;
  pnl: number | null;
  firstEntryTime: string | null;
  lastExitTime: string | null;
}

export default function TradeDetailModal({ positionId, walletAddress, onClose }: TradeDetailModalProps) {
  const [position, setPosition] = useState<PositionDetail | null>(null);
  const [orders, setOrders] = useState<OrderGroup[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchDone, setFetchDone] = useState(false);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  // Editable annotation state
  const [thesis, setThesis] = useState('');
  const [strategyTag, setStrategyTag] = useState('');
  const [sourceTag, setSourceTag] = useState('');
  const [conviction, setConviction] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Move order state
  const [movingOrderId, setMovingOrderId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidatePosition[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [moveToast, setMoveToast] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fetch data
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFetchDone(false);

    Promise.all([
      fetch(`/api/positions/${positionId}`, { signal: controller.signal }).then((r) => r.json()),
      fetch(`/api/positions/${positionId}/orders`, { signal: controller.signal }).then((r) => r.json()),
      fetch(`/api/analytics/insights?walletAddress=${walletAddress}`, { signal: controller.signal }).then((r) => r.json()),
    ])
      .then(([posData, ordersData, insightData]) => {
        const pos: PositionDetail = posData.position;
        setPosition(pos);
        setThesis(pos?.thesis ?? '');
        setStrategyTag(pos?.strategyTag ?? '');
        setSourceTag(pos?.sourceTag ?? '');
        setConviction(pos?.conviction ?? null);
        setOrders(ordersData.orders ?? []);
        // Filter insights to those referencing this position
        const all: Insight[] = insightData.insights ?? [];
        setInsights(all.filter((i) => i.affectedPositions?.includes(positionId)));
        setFetchDone(true);
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') setFetchDone(true);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [positionId, walletAddress]);

  const loadCandidates = useCallback(async () => {
    if (!position) return;
    setLoadingCandidates(true);
    try {
      const res = await fetch(
        `/api/trade-units?walletAddress=${encodeURIComponent(walletAddress)}&asset=${encodeURIComponent(position.asset)}&pageSize=100`,
      );
      const data = await res.json();
      const list: CandidatePosition[] = (data.tradeUnits ?? [])
        .filter((u: { kind: string; id: string }) => u.kind === 'position' && u.id !== positionId)
        .map((u: { id: string; asset: string; direction: string; pnl: number | null; firstEntryTime: string | null; lastExitTime: string | null }) => ({
          id: u.id,
          asset: u.asset,
          direction: u.direction,
          pnl: u.pnl,
          firstEntryTime: u.firstEntryTime,
          lastExitTime: u.lastExitTime,
        }));
      setCandidates(list);
    } finally {
      setLoadingCandidates(false);
    }
  }, [position, walletAddress, positionId]);

  const handleMoveOrder = useCallback(async (orderGroupId: string, targetPositionId: string) => {
    try {
      await fetch(`/api/orders/${orderGroupId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPositionId }),
      });
      setMovingOrderId(null);

      // Check if source position still exists
      const [posRes, ordersRes] = await Promise.all([
        fetch(`/api/positions/${positionId}`),
        fetch(`/api/positions/${positionId}/orders`),
      ]);
      const posData = await posRes.json();
      if (posData.error || !posData.position) {
        onClose();
        return;
      }
      const ordersData = await ordersRes.json();
      setOrders(ordersData.orders ?? []);

      const target = candidates.find((c) => c.id === targetPositionId);
      setMoveToast(`Moved order to ${target?.asset ?? 'position'}.`);
      setTimeout(() => setMoveToast(null), 5000);
    } catch (err) {
      console.error('Move failed', err);
    }
  }, [positionId, candidates, onClose]);

  const saveAnnotations = useCallback(async (patch: Partial<{
    thesis: string; strategyTag: string; sourceTag: string; conviction: number | null;
  }>) => {
    setSaving(true);
    try {
      await fetch(`/api/positions/${positionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } finally {
      setSaving(false);
    }
  }, [positionId]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  // Derived metrics
  const tiltScore100 = position?.tiltScore != null ? Math.round(position.tiltScore * 100) : null;
  const rMultiple = (position?.aggregatePnl != null && position?.maePnl != null && position.maePnl !== 0)
    ? position.aggregatePnl / Math.abs(position.maePnl)
    : null;

  const regime = position?.regimeAtEntry ? REGIME_BADGE[position.regimeAtEntry] : null;

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div
        className="relative bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={{ width: '80vw', height: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 text-[#6e7681] hover:text-white transition-colors text-xl leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        {/* Move toast */}
        {moveToast && (
          <div className="absolute bottom-4 right-4 z-20 flex items-center gap-3 bg-[#21262d] border border-[#30363d] rounded-lg px-4 py-2.5 shadow-xl text-sm">
            <span className="text-[#e6edf3]">{moveToast}</span>
            <button onClick={() => setMoveToast(null)} className="text-[#6e7681] hover:text-white leading-none">✕</button>
          </div>
        )}

        {loading || !fetchDone ? (
          <div className="flex-1 flex items-center justify-center text-[#6e7681] text-sm">
            Loading trade details...
          </div>
        ) : !position ? (
          <div className="flex-1 flex items-center justify-center text-[#6e7681] text-sm">
            Position not found.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* ── Header ──────────────────────────────────────────────── */}
            <div className="px-6 pt-6 pb-4 border-b border-[#21262d]">
              <div className="flex flex-wrap items-start gap-3 mb-3 pr-8">
                {/* Asset + direction */}
                <h2 className="text-2xl font-bold text-white">
                  {position.asset}
                </h2>
                <span className={`mt-1 px-2.5 py-0.5 rounded text-sm font-semibold ${
                  position.direction === 'long' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
                }`}>
                  {position.direction.toUpperCase()}
                </span>

                {/* Trade type */}
                {position.tradeType && (
                  <span className={`mt-1 px-2.5 py-0.5 rounded text-xs font-medium ${typeBadgeClass(position.tradeType)}`}>
                    {position.tradeType.replace(/_/g, ' ')}
                  </span>
                )}

                {/* Status */}
                <span className={`mt-1 px-2.5 py-0.5 rounded text-xs font-medium ${
                  position.status === 'open'
                    ? 'bg-blue-900/30 text-blue-400'
                    : 'bg-[#21262d] text-[#8b949e]'
                }`}>
                  {position.status}
                </span>

                {/* Regime */}
                {regime && (
                  <span className={`mt-1 px-2.5 py-0.5 rounded text-xs font-medium ${regime.bg} ${regime.text}`}>
                    {regime.label}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-end justify-between gap-4">
                {/* Date range */}
                <div className="text-xs text-[#6e7681]">
                  {fmtDate(position.firstEntryTime)}
                  {position.lastExitTime && position.lastExitTime !== position.firstEntryTime && (
                    <> → {fmtDate(position.lastExitTime)}</>
                  )}
                </div>

                {/* P&L */}
                <div className={`text-4xl font-bold tabular-nums ${pnlColor(position.aggregatePnl)}`}>
                  {fmt$(position.aggregatePnl, '—')}
                </div>
              </div>
            </div>

            {/* ── Metrics Grid ────────────────────────────────────────── */}
            <div className="px-6 py-4 border-b border-[#21262d]">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {/* Row 1 */}
                <MetricCell label="Entry Price" value={fmtPrice(position.averageEntryPrice)} />
                <MetricCell label="Exit Price" value={fmtPrice(position.averageExitPrice)} />
                <MetricCell label="Size" value={position.totalSize != null ? position.totalSize.toFixed(4) : '—'} />
                <MetricCell label="Hold Time" value={fmtHoldTime(position.holdTimeSeconds)} />

                {/* Row 2 */}
                <MetricCell
                  label="Fees"
                  value={position.aggregateFees != null ? `-$${Math.abs(position.aggregateFees).toFixed(2)}` : '—'}
                  valueClass="text-[#8b949e]"
                />
                <MetricCell
                  label="Funding"
                  value={position.aggregateFunding != null ? fmt$(position.aggregateFunding) : '—'}
                  valueClass={position.aggregateFunding != null ? pnlColor(position.aggregateFunding) : 'text-[#6e7681]'}
                />
                <MetricCell
                  label="Exit Efficiency"
                  value={position.exitEfficiency != null ? `${(position.exitEfficiency * 100).toFixed(1)}%` : '—'}
                />
                <MetricCell
                  label="Left on Table"
                  value={position.moneyLeftOnTable != null ? `-$${Math.abs(position.moneyLeftOnTable).toFixed(2)}` : '—'}
                  valueClass="text-[#8b949e]"
                />

                {/* Row 3 */}
                <MetricCell
                  label="Tilt Score"
                  value={tiltScore100 != null ? String(tiltScore100) : '—'}
                  valueClass={tiltScore100 != null ? tiltColor(tiltScore100) : 'text-[#6e7681]'}
                />
                <MetricCell
                  label="MAE"
                  value={position.maePnl != null ? fmt$(position.maePnl) : '—'}
                  valueClass={position.maePnl != null ? pnlColor(position.maePnl) : 'text-[#6e7681]'}
                />
                <MetricCell
                  label="MFE"
                  value={position.mfePnl != null ? fmt$(position.mfePnl) : '—'}
                  valueClass={position.mfePnl != null ? pnlColor(position.mfePnl) : 'text-[#6e7681]'}
                />
                <MetricCell
                  label="R-Multiple"
                  value={rMultiple != null ? `${rMultiple >= 0 ? '+' : ''}${rMultiple.toFixed(2)}R` : '—'}
                  valueClass={rMultiple != null ? pnlColor(rMultiple) : 'text-[#6e7681]'}
                />
              </div>
            </div>

            {/* ── Orders Timeline ──────────────────────────────────────── */}
            <div className="px-6 py-4 border-b border-[#21262d]">
              <h3 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">
                Orders ({orders.length})
              </h3>
              <div className="space-y-1">
                {orders.length === 0 ? (
                  <p className="text-xs text-[#6e7681]">No orders found.</p>
                ) : (
                  orders.map((order) => {
                    const roleBadge = ROLE_BADGE[order.role];
                    const canExpand = order._count.trades > 1;
                    const isExpanded = expandedOrderId === order.id;

                    return (
                      <Fragment key={order.id}>
                        <div
                          onClick={() => canExpand && setExpandedOrderId(isExpanded ? null : order.id)}
                          className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 rounded text-xs border border-[#21262d] ${
                            canExpand ? 'cursor-pointer hover:bg-[#161b22]' : ''
                          } ${isExpanded || movingOrderId === order.id ? 'bg-[#161b22] rounded-b-none' : 'bg-[#0d1117]'}`}
                        >
                          {/* Time */}
                          <span className="text-[#6e7681] w-28 shrink-0">
                            {fmtDate(order.firstEntryTime)}
                          </span>

                          {/* Role badge */}
                          {roleBadge ? (
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${roleBadge.bg} ${roleBadge.text}`}>
                              {roleBadge.label}
                            </span>
                          ) : (
                            <span className="text-[#6e7681]">{order.role}</span>
                          )}

                          {/* Direction */}
                          <span className={order.direction === 'long' ? 'text-green-400' : 'text-red-400'}>
                            {order.direction.toUpperCase()}
                          </span>

                          {/* Size */}
                          <span className="text-[#8b949e]">{order.totalSize?.toFixed(4) ?? '—'}</span>

                          {/* Price */}
                          <span className="text-[#8b949e]">
                            @ {fmtPrice(order.averageEntryPrice ?? order.averageExitPrice)}
                          </span>

                          {/* P&L */}
                          <span className={order.isEntry ? 'text-[#6e7681]' : pnlColor(order.aggregatePnl)}>
                            {order.isEntry ? '—' : fmt$(order.aggregatePnl)}
                          </span>

                          {/* Fills count + Move button */}
                          <span className="ml-auto flex items-center gap-2">
                            {canExpand && (
                              <span className="text-[#6e7681]">
                                {order._count.trades} fills {isExpanded ? '▾' : '▸'}
                              </span>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (movingOrderId === order.id) {
                                  setMovingOrderId(null);
                                } else {
                                  setMovingOrderId(order.id);
                                  if (candidates.length === 0) loadCandidates();
                                }
                              }}
                              className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                                movingOrderId === order.id
                                  ? 'border-blue-500/50 bg-blue-900/30 text-blue-400'
                                  : 'border-[#30363d] bg-[#21262d] text-[#6e7681] hover:text-blue-400 hover:border-blue-500/30'
                              }`}
                            >
                              Move →
                            </button>
                          </span>
                        </div>

                        {/* Move target panel */}
                        {movingOrderId === order.id && (
                          <div className="border border-t-0 border-[#21262d] rounded-b bg-[#0a0e13] px-3 py-2.5">
                            <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-2">
                              Move to another position:
                            </div>
                            {loadingCandidates ? (
                              <div className="text-xs text-[#6e7681] py-1">Loading positions...</div>
                            ) : candidates.length === 0 ? (
                              <div className="text-xs text-[#6e7681] py-1">
                                No other positions on {position?.asset ?? 'this asset'}.
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {candidates.map((c) => (
                                  <button
                                    key={c.id}
                                    onClick={() => handleMoveOrder(order.id, c.id)}
                                    className="w-full text-left flex items-center gap-3 px-2.5 py-2 rounded text-xs hover:bg-[#161b22] transition-colors border border-transparent hover:border-[#21262d]"
                                  >
                                    <span className={c.direction === 'long' ? 'text-green-400' : 'text-red-400'}>
                                      {c.direction.toUpperCase()}
                                    </span>
                                    <span className="text-[#6e7681]">
                                      {fmtDate(c.firstEntryTime)}
                                      {c.lastExitTime && c.lastExitTime !== c.firstEntryTime && (
                                        <> → {fmtDate(c.lastExitTime)}</>
                                      )}
                                    </span>
                                    <span className={`ml-auto font-medium ${c.pnl == null ? 'text-[#6e7681]' : c.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      {c.pnl == null ? '—' : `${c.pnl >= 0 ? '+' : '-'}$${Math.abs(c.pnl).toFixed(2)}`}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {isExpanded && canExpand && (
                          <div className="border border-t-0 border-[#21262d] rounded-b">
                            <FillsSubPanel orderGroupId={order.id} />
                          </div>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </div>
            </div>

            {/* ── Thesis ──────────────────────────────────────────────── */}
            <div className="px-6 py-4 border-b border-[#21262d]">
              <h3 className="text-xs uppercase tracking-widest text-[#6e7681] mb-2">
                Trade Thesis
              </h3>
              <textarea
                value={thesis}
                onChange={(e) => setThesis(e.target.value)}
                onBlur={() => saveAnnotations({ thesis })}
                placeholder="What was your thesis for this trade? What was your invalidation?"
                rows={4}
                className="w-full bg-[#161b22] border border-[#30363d] text-sm text-[#e6edf3] placeholder-[#6e7681] rounded px-3 py-2 focus:outline-none focus:border-blue-500 resize-none"
              />
              {saving && <p className="text-xs text-[#6e7681] mt-1">Saving...</p>}
            </div>

            {/* ── Tags ────────────────────────────────────────────────── */}
            <div className="px-6 py-4 border-b border-[#21262d]">
              <h3 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">
                Tags
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {/* Strategy tag */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] uppercase tracking-widest text-[#6e7681]">Strategy</label>
                  <select
                    value={strategyTag}
                    onChange={(e) => setStrategyTag(e.target.value)}
                    onBlur={() => saveAnnotations({ strategyTag })}
                    className="bg-[#161b22] border border-[#30363d] text-sm text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— None —</option>
                    {/* Strategy options will be populated when the tagging system is built */}
                  </select>
                </div>

                {/* Source/caller tag */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] uppercase tracking-widest text-[#6e7681]">Source / Caller</label>
                  <input
                    type="text"
                    value={sourceTag}
                    onChange={(e) => setSourceTag(e.target.value)}
                    onBlur={() => saveAnnotations({ sourceTag })}
                    placeholder="e.g. Manual, Caller name"
                    className="bg-[#161b22] border border-[#30363d] text-sm text-[#e6edf3] placeholder-[#6e7681] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Conviction */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] uppercase tracking-widest text-[#6e7681]">Conviction</label>
                  <ConvictionStars
                    value={conviction}
                    onChange={(v) => {
                      const newVal = v === 0 ? null : v;
                      setConviction(newVal);
                      saveAnnotations({ conviction: newVal });
                    }}
                  />
                </div>
              </div>
            </div>

            {/* ── Insights ────────────────────────────────────────────── */}
            {insights.length > 0 && (
              <div className="px-6 py-4">
                <h3 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">
                  Flagged by Insights
                </h3>
                <div className="space-y-2">
                  {insights.map((insight, i) => {
                    const badge = SEVERITY_BADGE[insight.severity] ?? SEVERITY_BADGE.info;
                    return (
                      <div
                        key={i}
                        className="flex items-start gap-3 bg-[#161b22] border border-[#21262d] rounded-lg px-3 py-2.5"
                      >
                        <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${badge.bg} ${badge.text}`}>
                          {insight.severity}
                        </span>
                        <div>
                          <p className="text-xs font-medium text-white">{insight.title}</p>
                          <p className="text-xs text-[#8b949e] mt-0.5 leading-relaxed">{insight.description}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Metric Cell ────────────────────────────────────────────────────────────────

function MetricCell({
  label,
  value,
  valueClass = 'text-white',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
