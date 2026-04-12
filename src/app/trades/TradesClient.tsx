'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import TradeDetailModal from './TradeDetailModal';
import TradeAnnotationPopup, { type PopupPosition } from '@/app/components/trade-popup/TradeAnnotationPopup';
import BoobaAvatar from '@/app/components/booba/BoobaAvatar';
import { useJournal } from '../JournalContext';
import { useAuthFetch } from '@/lib/api-client';

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
  // Annotation fields (positions only)
  thesis?: string | null;
  strategyId?: string | null;
  emotion?: string | null;
  conviction?: number | null;
  sourceTag?: string | null;
  invalidationPrice?: number | null;
  targetPrice?: string | null;
  mistakes?: string | null;
  // Linked strategy extras
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

interface ToastState {
  id: number;
  msg: string;
  undoFn?: () => Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POSITION_TYPES = [
  'scalp', 'directional', 'scaled_directional', 'carry_trade', 'market_making',
];

const ALL_TRADE_TYPES = [
  'scalp', 'directional', 'scaled_directional', 'carry_trade', 'market_making', 'delta_neutral',
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
  entry:          { bg: 'bg-blue-900/30',  text: 'text-blue-400',  label: 'Entry' },
  'take profit':  { bg: 'bg-green-900/30', text: 'text-green-400', label: 'TP' },
  'stop loss':    { bg: 'bg-red-900/30',   text: 'text-red-400',   label: 'SL' },
  'manual close': { bg: 'bg-slate-700/40', text: 'text-slate-400', label: 'Close' },
};

function typeBadgeClass(type: string | null) {
  if (!type) return 'text-[#6e7681] bg-[#21262d]';
  const colors: Record<string, string> = {
    scalp:              'text-cyan-400 bg-cyan-900/30',
    directional:        'text-blue-400 bg-blue-900/30',
    scaled_directional: 'text-indigo-400 bg-indigo-900/30',
    market_making:      'text-purple-400 bg-purple-900/30',
    carry_trade:        'text-orange-400 bg-orange-900/30',
    delta_neutral:      'text-teal-400 bg-teal-900/30',
    pairs_trade:        'text-pink-400 bg-pink-900/30',
    basis_trade:        'text-emerald-400 bg-emerald-900/30',
  };
  return colors[type] ?? 'text-[#6e7681] bg-[#21262d]';
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({
  toast,
  onDismiss,
  onUndo,
}: {
  toast: ToastState;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-[#21262d] border border-[#30363d] rounded-lg px-4 py-3 shadow-xl text-sm max-w-sm">
      <span className="text-[#e6edf3] flex-1">{toast.msg}</span>
      {toast.undoFn && (
        <button
          onClick={onUndo}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded font-medium transition-colors shrink-0"
        >
          Undo
        </button>
      )}
      <button onClick={onDismiss} className="text-[#6e7681] hover:text-white transition-colors shrink-0 leading-none">
        ✕
      </button>
    </div>
  );
}

// ── Floating Toolbar ──────────────────────────────────────────────────────────

function FloatingToolbar({
  selectedIds,
  selectedUnits,
  journals,
  currentJournalId,
  onClear,
  onMerge,
  onLink,
  onSplit,
  onReclassify,
  onMoveJournal,
}: {
  selectedIds: Set<string>;
  selectedUnits: TradeUnit[];
  journals: JournalSummaryLite[];
  currentJournalId: string | null;
  onClear: () => void;
  onMerge: () => void;
  onLink: (type: 'delta_neutral' | 'pairs_trade' | 'basis_trade') => void;
  onSplit: () => void;
  onReclassify: () => void;
  onMoveJournal: (targetJournalId: string) => void;
}) {
  const count = selectedIds.size;
  const [linkOpen, setLinkOpen] = useState(false);
  const linkRef = useRef<HTMLDivElement>(null);
  const [journalOpen, setJournalOpen] = useState(false);
  const journalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (linkRef.current && !linkRef.current.contains(e.target as Node)) setLinkOpen(false);
      if (journalRef.current && !journalRef.current.contains(e.target as Node)) setJournalOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hasLinkedStrategy = selectedUnits.some((u) => u.kind === 'linked_strategy');
  const assets = new Set(selectedUnits.flatMap((u) => u.asset.split(' / ')));
  const mixedAssets = assets.size > 1;
  // Journal moves only apply to bare positions — linked strategies follow
  // their legs and shouldn't be moved as a unit.
  const canMoveJournal = !hasLinkedStrategy && journals.length > 1;

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 bg-[#13181f]/95 backdrop-blur-sm border border-[#30363d] rounded-lg px-4 py-2.5 shadow-lg">
      <span className="text-sm font-medium text-white">{count} selected</span>
      <button
        onClick={onClear}
        className="text-xs text-[#6e7681] hover:text-white transition-colors"
      >
        Clear
      </button>
      <div className="h-4 w-px bg-[#30363d]" />

      {count === 1 ? (
        <>
          <button
            onClick={onSplit}
            disabled={hasLinkedStrategy}
            className="px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 text-sm text-[#e6edf3] border border-[#30363d] rounded transition-colors"
          >
            Split
          </button>
          <button
            onClick={onReclassify}
            disabled={hasLinkedStrategy}
            className="px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 text-sm text-[#e6edf3] border border-[#30363d] rounded transition-colors"
          >
            Reclassify
          </button>
        </>
      ) : (
        <>
          <button
            onClick={onMerge}
            disabled={hasLinkedStrategy || mixedAssets}
            title={hasLinkedStrategy ? 'Cannot merge linked strategies' : mixedAssets ? 'Can only merge same-asset positions' : undefined}
            className="px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 text-sm text-[#e6edf3] border border-[#30363d] rounded transition-colors"
          >
            Merge Positions
          </button>
          <div className="relative" ref={linkRef}>
            <button
              onClick={() => setLinkOpen((o) => !o)}
              className="px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] text-sm text-[#e6edf3] border border-[#30363d] rounded transition-colors flex items-center gap-1.5"
            >
              Link as... <span className="text-[10px]">▾</span>
            </button>
            {linkOpen && (
              <div className="absolute top-full left-0 mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-20 min-w-[160px]">
                {(['pairs_trade', 'delta_neutral', 'basis_trade'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => { onLink(t); setLinkOpen(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors"
                  >
                    {t === 'pairs_trade' ? 'Pairs Trade' : t === 'delta_neutral' ? 'Delta Neutral' : 'Basis Trade'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Move-to-Journal applies to single + multi selection alike, so it
          lives outside the count===1 branch. Hidden when there's only one
          journal in the wallet (nothing to move into). */}
      {canMoveJournal && (
        <div className="relative" ref={journalRef}>
          <button
            onClick={() => setJournalOpen((o) => !o)}
            className="px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] text-sm text-[#e6edf3] border border-[#30363d] rounded transition-colors flex items-center gap-1.5"
          >
            Move to Journal... <span className="text-[10px]">▾</span>
          </button>
          {journalOpen && (
            <div className="absolute top-full left-0 mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-20 min-w-[200px]">
              {journals.map((j) => {
                const isCurrent = j.id === currentJournalId;
                return (
                  <button
                    key={j.id}
                    disabled={isCurrent}
                    onClick={() => { onMoveJournal(j.id); setJournalOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between gap-2 ${
                      isCurrent
                        ? 'text-[#6e7681] cursor-not-allowed'
                        : 'text-[#e6edf3] hover:bg-[#21262d]'
                    }`}
                  >
                    <span className="truncate">{j.name}</span>
                    {isCurrent && (
                      <span className="text-[9px] uppercase tracking-widest">current</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Three-Dot Menu ────────────────────────────────────────────────────────────

interface JournalSummaryLite {
  id: string;
  name: string;
  isDefault: boolean;
}

function ThreeDotMenu({
  unit,
  journals,
  currentJournalId,
  onViewDetails,
  onSplit,
  onReclassify,
  onDelete,
  onUnlink,
  onMoveJournal,
  onAnnotate,
}: {
  unit: TradeUnit;
  journals: JournalSummaryLite[];
  currentJournalId: string | null;
  onViewDetails: () => void;
  onSplit: () => void;
  onReclassify: () => void;
  onDelete: () => void;
  onUnlink: () => void;
  onMoveJournal: (targetJournalId: string) => void;
  onAnnotate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setMoveOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const close = () => { setOpen(false); setMoveOpen(false); };
  const isLinked = unit.kind === 'linked_strategy';
  // Linked strategies aren't moved per-row — their legs (positions) carry
  // the journal assignment, and the trade-units row simply follows.
  const canMoveJournal = !isLinked && journals.length > 1;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); setMoveOpen(false); }}
        className="p-1 text-[#6e7681] hover:text-white rounded hover:bg-[#30363d] transition-colors text-base leading-none"
        aria-label="More options"
      >
        ⋮
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30 min-w-[180px]">
          {!isLinked && (
            <button
              onClick={() => { close(); onViewDetails(); }}
              className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors"
            >
              View Details
            </button>
          )}
          {!isLinked && (
            <button
              onClick={() => { close(); onAnnotate(); }}
              className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors"
            >
              {(!unit.thesis && !unit.emotion && !unit.strategyId) ? 'Add Context' : 'Edit Context'}
            </button>
          )}
          {isLinked ? (
            <button
              onClick={() => { close(); onUnlink(); }}
              className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors"
            >
              Unlink Positions
            </button>
          ) : (
            <>
              <button
                onClick={() => { close(); onSplit(); }}
                className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors"
              >
                Split Position
              </button>
              <button
                onClick={() => { close(); onReclassify(); }}
                className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors"
              >
                Reclassify
              </button>
              {canMoveJournal && (
                <div
                  className="relative"
                  onMouseEnter={() => setMoveOpen(true)}
                  onMouseLeave={() => setMoveOpen(false)}
                >
                  <button
                    onClick={() => setMoveOpen((o) => !o)}
                    className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors flex items-center justify-between gap-2"
                  >
                    <span>Move to Journal</span>
                    <span className="text-[10px] text-[#6e7681]">▸</span>
                  </button>
                  {moveOpen && (
                    <div className="absolute right-full top-0 mr-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-40 min-w-[180px]">
                      {journals.map((j) => {
                        const isCurrent = j.id === currentJournalId;
                        return (
                          <button
                            key={j.id}
                            disabled={isCurrent}
                            onClick={() => { close(); onMoveJournal(j.id); }}
                            className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center justify-between gap-2 ${
                              isCurrent
                                ? 'text-[#6e7681] cursor-not-allowed'
                                : 'text-[#e6edf3] hover:bg-[#21262d]'
                            }`}
                          >
                            <span className="truncate">{j.name}</span>
                            {isCurrent && (
                              <span className="text-[9px] uppercase tracking-widest">current</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <div className="my-0.5 h-px bg-[#30363d]" />
              <button
                onClick={() => { close(); onDelete(); }}
                className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-[#21262d] transition-colors"
              >
                Delete Position
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Merge Dialog ──────────────────────────────────────────────────────────────

function MergeDialog({
  units,
  onConfirm,
  onCancel,
}: {
  units: TradeUnit[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const assetSet = new Set(units.map((u) => u.asset));
  const asset = assetSet.size === 1 ? units[0].asset : [...assetSet].join(', ');
  const orderCount = units.reduce((s, u) => s + u.childCount, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl p-6 w-full max-w-md">
        <h3 className="text-base font-semibold text-white mb-2">
          Merge {units.length} Positions?
        </h3>
        <p className="text-sm text-[#8b949e] mb-6">
          This will combine {orderCount} orders into a single position on {asset}. This can be undone.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-[#e6edf3] bg-[#21262d] border border-[#30363d] rounded hover:bg-[#30363d] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
          >
            Merge
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Split Dialog ──────────────────────────────────────────────────────────────

function SplitDialog({
  positionId,
  onConfirm,
  onCancel,
}: {
  positionId: string;
  onConfirm: (splitTime: string) => void;
  onCancel: () => void;
}) {
  const authFetch = useAuthFetch();
  const [orders, setOrders] = useState<OrderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [splitGap, setSplitGap] = useState<number | null>(null);

  useEffect(() => {
    authFetch(`/api/positions/${positionId}/orders`)
      .then((r) => r.json())
      .then((d) => {
        const sorted = (d.orders ?? []).slice().sort(
          (a: OrderGroup, b: OrderGroup) =>
            new Date(a.firstEntryTime ?? 0).getTime() - new Date(b.firstEntryTime ?? 0).getTime(),
        );
        setOrders(sorted);
      })
      .finally(() => setLoading(false));
  }, [positionId, authFetch]);

  const handleSplit = () => {
    if (splitGap == null || splitGap >= orders.length - 1) return;
    const afterOrder = orders[splitGap + 1];
    const afterTime = afterOrder.firstEntryTime ?? afterOrder.lastExitTime;
    if (!afterTime) return;
    const splitTime = new Date(new Date(afterTime).getTime() - 1).toISOString();
    onConfirm(splitTime);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="px-5 py-4 border-b border-[#21262d] flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">Split Position</h3>
          <button onClick={onCancel} className="text-[#6e7681] hover:text-white text-xl leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="text-sm text-[#6e7681] py-8 text-center">Loading orders...</div>
          ) : orders.length < 2 ? (
            <div className="text-sm text-[#6e7681] py-8 text-center">
              Need at least 2 orders to split this position.
            </div>
          ) : (
            <>
              <p className="text-xs text-[#8b949e] mb-3">
                Click a divider between orders to set the split point.
              </p>
              <div>
                {orders.map((order, i) => (
                  <Fragment key={order.id}>
                    <div
                      className={`flex items-center gap-3 px-3 py-2 rounded border text-xs ${
                        splitGap != null && i <= splitGap
                          ? 'border-blue-500/40 bg-blue-900/10'
                          : splitGap != null && i > splitGap
                          ? 'border-purple-500/40 bg-purple-900/10'
                          : 'border-[#21262d] bg-[#161b22]'
                      }`}
                    >
                      <span className="text-[#6e7681] w-28 shrink-0">
                        {fmtDate(order.firstEntryTime)}
                      </span>
                      <span className={order.direction === 'long' ? 'text-green-400' : 'text-red-400'}>
                        {order.direction.toUpperCase()}
                      </span>
                      <span className="text-[#8b949e]">{order.totalSize?.toFixed(4) ?? '—'}</span>
                      <span className={order.isEntry ? 'text-[#6e7681]' : pnlColor(order.aggregatePnl)}>
                        {order.isEntry ? '—' : fmt$(order.aggregatePnl)}
                      </span>
                    </div>

                    {i < orders.length - 1 && (
                      <button
                        onClick={() => setSplitGap(splitGap === i ? null : i)}
                        className={`w-full flex items-center gap-2 py-1 text-[10px] uppercase tracking-widest transition-colors group ${
                          splitGap === i ? 'text-amber-400' : 'text-[#30363d] hover:text-[#6e7681]'
                        }`}
                      >
                        <div
                          className={`flex-1 h-px transition-colors ${
                            splitGap === i ? 'bg-amber-400' : 'bg-[#21262d] group-hover:bg-[#30363d]'
                          }`}
                        />
                        <span>{splitGap === i ? '✂ split here' : '· split here ·'}</span>
                        <div
                          className={`flex-1 h-px transition-colors ${
                            splitGap === i ? 'bg-amber-400' : 'bg-[#21262d] group-hover:bg-[#30363d]'
                          }`}
                        />
                      </button>
                    )}
                  </Fragment>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[#21262d] flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-[#e6edf3] bg-[#21262d] border border-[#30363d] rounded hover:bg-[#30363d] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSplit}
            disabled={splitGap == null || orders.length < 2}
            className="px-4 py-2 text-sm text-white bg-amber-600 hover:bg-amber-500 disabled:bg-[#21262d] disabled:text-[#6e7681] rounded transition-colors"
          >
            Split Here
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reclassify Dialog ─────────────────────────────────────────────────────────

function ReclassifyDialog({
  unit,
  onConfirm,
  onCancel,
}: {
  unit: TradeUnit;
  onConfirm: (type: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl p-5 w-full max-w-xs">
        <h3 className="text-base font-semibold text-white mb-1">Reclassify Position</h3>
        <p className="text-xs text-[#6e7681] mb-4">{unit.asset}</p>
        <div className="space-y-1">
          {ALL_TRADE_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => onConfirm(t)}
              className={`w-full text-left px-3 py-2 text-sm rounded transition-colors flex items-center gap-2 ${
                t === unit.tradeType
                  ? 'bg-blue-900/30 border border-blue-500/30'
                  : 'hover:bg-[#21262d]'
              }`}
            >
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${typeBadgeClass(t)}`}
              >
                {t.replace(/_/g, ' ')}
              </span>
              {t === unit.tradeType && (
                <span className="text-xs text-[#6e7681] ml-auto">current</span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-[#e6edf3] bg-[#21262d] border border-[#30363d] rounded hover:bg-[#30363d] transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
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

// ── Fills panel ───────────────────────────────────────────────────────────────

function FillsPanel({ orderGroupId }: { orderGroupId: string }) {
  const authFetch = useAuthFetch();
  const [fills, setFills] = useState<Fill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(`/api/orders/${orderGroupId}/fills`)
      .then((r) => r.json())
      .then((d) => setFills(d.fills ?? []))
      .finally(() => setLoading(false));
  }, [orderGroupId, authFetch]);

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

// ── Orders panel ──────────────────────────────────────────────────────────────

function OrdersPanel({ positionId }: { positionId: string }) {
  const authFetch = useAuthFetch();
  const [orders, setOrders] = useState<OrderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  useEffect(() => {
    authFetch(`/api/positions/${positionId}/orders`)
      .then((r) => r.json())
      .then((d) => {
        const sorted = (d.orders ?? []).slice().sort(
          (a: OrderGroup, b: OrderGroup) =>
            new Date(a.firstEntryTime ?? 0).getTime() - new Date(b.firstEntryTime ?? 0).getTime(),
        );
        setOrders(sorted);
      })
      .finally(() => setLoading(false));
  }, [positionId, authFetch]);

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
                  <td className="py-1 pr-3 text-[#6e7681]">{order.executionType ?? '—'}</td>
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

export default function TradesClient() {
  // Active wallet + journal scope, both sourced from JournalContext. Every
  // API call routes through buildParams so the table, summary stats,
  // grouping output, and analytics fetches all stay bound to the same
  // journal — and the wallet itself is the Privy-authenticated one (or
  // the dev wallet in dev-bypass mode).
  const { journalId, journals, buildParams, refresh: refreshJournals } = useJournal();
  const authFetch = useAuthFetch();
  const [tradeUnits, setTradeUnits] = useState<TradeUnit[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sortBy, setSortBy] = useState('firstEntryTime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailPositionId, setDetailPositionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [assetOptions, setAssetOptions] = useState<string[]>([]);
  const [groupingRunning, setGroupingRunning] = useState(false);
  const [groupingSummary, setGroupingSummary] = useState<Record<string, unknown> | null>(null);

  // Group editing state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [splitPositionId, setSplitPositionId] = useState<string | null>(null);
  const [reclassifyUnit, setReclassifyUnit] = useState<TradeUnit | null>(null);
  const [analyticsStale, setAnalyticsStale] = useState(false);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [computingAnalytics, setComputingAnalytics] = useState(false);
  const [annotatePositionId, setAnnotatePositionId] = useState<string | null>(null);
  const [annotateQueue, setAnnotateQueue] = useState<string[]>([]);
  const [boobaInsight, setBoobaInsight] = useState<string | null>(null);
  const [untaggedCount, setUntaggedCount] = useState(0);
  const [untaggedIds, setUntaggedIds] = useState<string[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const p = buildParams({
        sortBy,
        sortDir,
        page: String(page),
        ...(filters.tradeType ? { tradeType: filters.tradeType } : {}),
        ...(filters.asset ? { asset: filters.asset } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      });
      const summaryParams = buildParams();

      const [unitsRes, summaryRes, untaggedRes] = await Promise.all([
        authFetch(`/api/trade-units?${p}`),
        authFetch(`/api/analytics/summary?${summaryParams}`),
        authFetch('/api/positions/untagged-count'),
      ]);
      const [unitsData, summaryData, untaggedData] = await Promise.all([
        unitsRes.json(),
        summaryRes.json(),
        untaggedRes.json(),
      ]);

      setTradeUnits(unitsData.tradeUnits ?? []);
      setPagination(unitsData.pagination ?? null);
      setSummary(summaryData?.data ?? null);
      setUntaggedCount(untaggedData.count ?? 0);
      setUntaggedIds(untaggedData.ids ?? []);

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
  }, [sortBy, sortDir, page, filters, buildParams, authFetch]);

  useEffect(() => {
    if (!journalId) return;
    fetchData();
  }, [fetchData, journalId]);
  useEffect(() => { setPage(1); }, [filters, sortBy, sortDir]);

  const handleSort = (field: string) => {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir('desc'); }
  };

  const runGrouping = async () => {
    setGroupingRunning(true);
    setGroupingSummary(null);
    try {
      const res = await authFetch('/api/grouping/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setGroupingSummary(data);
      setAnalyticsStale(false);
      await fetchData();
    } finally {
      setGroupingRunning(false);
    }
  };

  // ── Toast helpers ───────────────────────────────────────────────────────────

  const showToast = useCallback((msg: string, undoFn?: () => Promise<void>) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const id = Date.now();
    setToast({ id, msg, undoFn });
    toastTimerRef.current = setTimeout(() => setToast(null), 10000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  const flashRows = useCallback((ids: string[]) => {
    setFlashIds(new Set(ids));
    setTimeout(() => setFlashIds(new Set()), 1500);
  }, []);

  // ── Selection ───────────────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectedUnits = tradeUnits.filter((u) => selectedIds.has(u.id));

  // ── Group edit operations ───────────────────────────────────────────────────

  const handleMerge = useCallback(async () => {
    const ids = [...selectedIds];
    try {
      const res = await authFetch('/api/positions/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionIds: ids }),
      });
      const data = await res.json();
      clearSelection();
      setMergeConfirm(false);
      setAnalyticsStale(true);
      if (data.merged?.id) flashRows([data.merged.id]);
      await fetchData();

      const { undoData } = data;
      showToast(`Merged ${ids.length} positions.`, async () => {
        await authFetch('/api/positions/merge/undo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ undoData }),
        });
        setAnalyticsStale(true);
        await fetchData();
      });
    } catch (err) {
      console.error('Merge failed', err);
    }
  }, [selectedIds, clearSelection, fetchData, showToast, flashRows]);

  const handleLink = useCallback(async (strategyType: 'delta_neutral' | 'pairs_trade' | 'basis_trade') => {
    const ids = [...selectedIds].filter((id) => tradeUnits.find((u) => u.id === id)?.kind === 'position');
    if (ids.length < 2) return;
    try {
      const res = await authFetch('/api/positions/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionIds: ids, strategyType }),
      });
      const data = await res.json();
      clearSelection();
      setAnalyticsStale(true);
      await fetchData();

      const linkedId = data.id;
      showToast(
        `Linked ${ids.length} positions as ${strategyType.replace(/_/g, ' ')}.`,
        linkedId
          ? async () => {
              await authFetch(`/api/linked-strategies/${linkedId}`, { method: 'DELETE' });
              setAnalyticsStale(true);
              await fetchData();
            }
          : undefined,
      );
    } catch (err) {
      console.error('Link failed', err);
    }
  }, [selectedIds, tradeUnits, clearSelection, fetchData, showToast]);

  const handleSplit = useCallback(async (splitTime: string) => {
    const positionId = splitPositionId!;
    try {
      const res = await authFetch('/api/positions/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId, splitTime }),
      });
      const data = await res.json();
      setSplitPositionId(null);
      clearSelection();
      setAnalyticsStale(true);
      const [pos1, pos2] = data.positions ?? [];
      if (pos1) flashRows([pos1.id, pos2?.id].filter(Boolean));
      await fetchData();

      showToast('Split into 2 positions.', async () => {
        if (pos1 && pos2) {
          await authFetch('/api/positions/merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionIds: [pos1.id, pos2.id] }),
          });
          setAnalyticsStale(true);
          await fetchData();
        }
      });
    } catch (err) {
      console.error('Split failed', err);
    }
  }, [splitPositionId, clearSelection, fetchData, showToast, flashRows]);

  const handleReclassify = useCallback(async (positionId: string, tradeType: string) => {
    try {
      await authFetch(`/api/positions/${positionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeType }),
      });
      setReclassifyUnit(null);
      clearSelection();
      flashRows([positionId]);
      await fetchData();
    } catch (err) {
      console.error('Reclassify failed', err);
    }
  }, [clearSelection, fetchData, flashRows, authFetch]);

  const handleDelete = useCallback(async (positionId: string) => {
    if (!confirm('Delete this position? Its orders will become ungrouped.')) return;
    try {
      await authFetch(`/api/positions/${positionId}`, { method: 'DELETE' });
      setAnalyticsStale(true);
      await fetchData();
    } catch (err) {
      console.error('Delete failed', err);
    }
  }, [fetchData, authFetch]);

  const handleUnlink = useCallback(async (strategyId: string) => {
    if (!confirm('Remove strategy link? Individual positions will remain.')) return;
    try {
      await authFetch(`/api/linked-strategies/${strategyId}`, { method: 'DELETE' });
      setAnalyticsStale(true);
      await fetchData();
    } catch (err) {
      console.error('Unlink failed', err);
    }
  }, [fetchData, authFetch]);

  const handleComputeAnalytics = useCallback(async () => {
    setComputingAnalytics(true);
    try {
      await authFetch('/api/analytics/metrics/compute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journalId }),
      });
      setAnalyticsStale(false);
      await fetchData();
    } finally {
      setComputingAnalytics(false);
    }
  }, [journalId, fetchData, authFetch]);

  // ── Annotation popup helpers ────────────────────────────────────────────────

  const isUntagged = (unit: TradeUnit) =>
    unit.kind === 'position' && !unit.thesis && !unit.emotion && !unit.strategyId;

  const openAnnotateQueue = useCallback(() => {
    if (untaggedIds.length === 0) return;
    setAnnotateQueue(untaggedIds.slice(1));
    setAnnotatePositionId(untaggedIds[0]);
  }, [untaggedIds]);

  const handleAnnotateSaved = useCallback(async (msg: string) => {
    // Clear then set to ensure BoobaAvatar fires on repeated same message
    setBoobaInsight(null);
    setTimeout(() => setBoobaInsight(msg), 50);
    await fetchData();
    // Advance queue if in queue mode
    if (annotateQueue.length > 0) {
      setAnnotatePositionId(annotateQueue[0]);
      setAnnotateQueue((q) => q.slice(1));
    } else {
      setAnnotatePositionId(null);
    }
  }, [annotateQueue, fetchData]);

  // ── Move position(s) to a different journal ───────────────────────────────
  // Used by both the per-row three-dot menu (single id) and the floating
  // toolbar (multi-select). Refreshes the journal list afterwards so the
  // dropdown's per-journal counts stay accurate.
  const handleMoveJournal = useCallback(
    async (positionIds: string[], targetJournalId: string) => {
      if (positionIds.length === 0) return;
      try {
        const res = await authFetch('/api/positions/move-journal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positionIds, targetJournalId }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showToast(data?.error ?? 'Move failed');
          return;
        }
        const data = await res.json();
        clearSelection();
        // Positions that moved out of the active journal disappear from
        // this view immediately — refresh both the table and the journal
        // list (counts) to reflect that.
        await Promise.all([fetchData(), refreshJournals()]);
        // Moving positions between journals doesn't change what "All Trades"
        // shows (it aggregates everything), so only mark analytics stale when
        // viewing a specific sub-journal whose visible positions just changed.
        const activeIsDefault = journals.find((j) => j.id === journalId)?.isDefault ?? true;
        if (!activeIsDefault) setAnalyticsStale(true);
        const target = journals.find((j) => j.id === targetJournalId);
        showToast(
          `Moved ${data.moved} position${data.moved === 1 ? '' : 's'} to "${target?.name ?? 'journal'}".`,
        );
      } catch (err) {
        console.error('Move journal failed', err);
      }
    },
    [clearSelection, fetchData, refreshJournals, journals, showToast],
  );

  // Lite projection of journals for the menu components — they only need
  // id/name/isDefault, not the full summary type.
  const journalLite: JournalSummaryLite[] = journals.map((j) => ({
    id: j.id,
    name: j.name,
    isDefault: j.isDefault,
  }));

  const toPopupPosition = (unit: TradeUnit): PopupPosition => ({
    id: unit.id,
    asset: unit.asset,
    direction: unit.direction,
    pnl: unit.pnl,
    averageEntryPrice: unit.averageEntryPrice,
    averageExitPrice: unit.averageExitPrice,
    totalSize: unit.totalSize,
    holdTimeSeconds: unit.holdTimeSeconds,
    regimeAtEntry: unit.regimeAtEntry,
    thesis: unit.thesis ?? null,
    conviction: unit.conviction ?? null,
    emotion: unit.emotion ?? null,
    strategyId: unit.strategyId ?? null,
    sourceTag: unit.sourceTag ?? null,
    invalidationPrice: unit.invalidationPrice ?? null,
    targetPrice: unit.targetPrice ?? null,
    mistakes: unit.mistakes ?? null,
  });

  // Resolve annotatePositionId → PopupPosition.
  // Prefer the already-loaded trade unit (current page). If not on this page,
  // fetch from the positions API. Store in state so the popup can render.
  const [annotatePosition, setAnnotatePosition] = useState<PopupPosition | null>(null);

  useEffect(() => {
    if (!annotatePositionId) {
      setAnnotatePosition(null);
      return;
    }
    const inPage = tradeUnits.find((u) => u.id === annotatePositionId);
    if (inPage) {
      setAnnotatePosition(toPopupPosition(inPage));
      return;
    }
    // Not in current page — fetch from API
    let cancelled = false;
    authFetch(`/api/positions/${annotatePositionId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d.position) return;
        const p = d.position;
        setAnnotatePosition({
          id: p.id,
          asset: p.asset,
          direction: p.direction,
          pnl: p.aggregatePnl ?? null,
          averageEntryPrice: p.averageEntryPrice ?? null,
          averageExitPrice: p.averageExitPrice ?? null,
          totalSize: p.totalSize ?? null,
          holdTimeSeconds: p.holdTimeSeconds ?? null,
          regimeAtEntry: p.regimeAtEntry ?? null,
          thesis: p.thesis ?? null,
          conviction: p.conviction ?? null,
          emotion: p.emotion ?? null,
          strategyId: p.strategyId ?? null,
          sourceTag: p.sourceTag ?? null,
          invalidationPrice: p.invalidationPrice ?? null,
          targetPrice: p.targetPrice ?? null,
          mistakes: p.mistakes ?? null,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [annotatePositionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      {/* Dialogs */}
      {annotatePosition && (
        <TradeAnnotationPopup
          position={annotatePosition}
          onClose={() => { setAnnotatePositionId(null); setAnnotateQueue([]); }}
          onSaved={handleAnnotateSaved}
        />
      )}
      {detailPositionId && (
        <TradeDetailModal
          positionId={detailPositionId}
          onClose={() => setDetailPositionId(null)}
        />
      )}
      {mergeConfirm && (
        <MergeDialog
          units={selectedUnits}
          onConfirm={handleMerge}
          onCancel={() => setMergeConfirm(false)}
        />
      )}
      {splitPositionId && (
        <SplitDialog
          positionId={splitPositionId}
          onConfirm={handleSplit}
          onCancel={() => setSplitPositionId(null)}
        />
      )}
      {reclassifyUnit && (
        <ReclassifyDialog
          unit={reclassifyUnit}
          onConfirm={(type) => handleReclassify(reclassifyUnit.id, type)}
          onCancel={() => setReclassifyUnit(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <Toast
          toast={toast}
          onDismiss={dismissToast}
          onUndo={async () => {
            if (toast.undoFn) await toast.undoFn();
            dismissToast();
          }}
        />
      )}

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

      {/* ── Stale Analytics Banner ─────────────────────────────────── */}
      {analyticsStale && (
        <div className="flex items-center justify-between bg-amber-900/20 border border-amber-500/30 rounded-lg px-4 py-2.5">
          <span className="text-sm text-amber-300">
            Grouping changed. Click &apos;Compute Analytics&apos; to update insights.
          </span>
          <button
            onClick={handleComputeAnalytics}
            disabled={computingAnalytics}
            className="text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-900 text-white rounded transition-colors shrink-0 ml-4"
          >
            {computingAnalytics ? 'Computing...' : 'Compute Analytics'}
          </button>
        </div>
      )}

      {/* ── Untagged Trades Banner ─────────────────────────────────── */}
      {!loading && untaggedCount > 0 && (
        <div className="flex items-center justify-between bg-yellow-900/20 border border-yellow-500/30 rounded-lg px-4 py-2.5">
          <span className="text-sm text-yellow-300">
            {untaggedCount} trade{untaggedCount === 1 ? '' : 's'} have no context.
            Adding strategy and thesis helps Booba learn your patterns.
          </span>
          <button
            onClick={openAnnotateQueue}
            className="text-xs px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white rounded transition-colors shrink-0 ml-4"
          >
            Tag All
          </button>
        </div>
      )}

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
              <span className="text-white font-medium">{groupingSummary.totalFills as number}</span> fills →{' '}
              <span className="text-white font-medium">{groupingSummary.totalOrders as number}</span> orders →{' '}
              <span className="text-white font-medium">{groupingSummary.totalPositions as number}</span> positions.{' '}
              {(groupingSummary.totalLinkedStrategies as number) > 0 && (
                <span>
                  <span className="text-white font-medium">{groupingSummary.totalLinkedStrategies as number}</span> linked strategies.{' '}
                </span>
              )}
              <span className="text-amber-400">{groupingSummary.needsReview as number}</span> need review.
            </div>
            {Boolean(groupingSummary.positionsByType) && Object.keys(groupingSummary.positionsByType as object).length > 0 && (
              <div className="flex flex-wrap gap-3">
                {Object.entries(groupingSummary.positionsByType as Record<string, unknown>).map(([type, count]) => (
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

      {/* ── Floating Toolbar ───────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <FloatingToolbar
          selectedIds={selectedIds}
          selectedUnits={selectedUnits}
          journals={journalLite}
          currentJournalId={journalId}
          onClear={clearSelection}
          onMerge={() => setMergeConfirm(true)}
          onLink={handleLink}
          onSplit={() => {
            const id = [...selectedIds][0];
            setSplitPositionId(id);
          }}
          onReclassify={() => {
            const id = [...selectedIds][0];
            const unit = tradeUnits.find((u) => u.id === id);
            if (unit) setReclassifyUnit(unit);
          }}
          onMoveJournal={(targetJournalId) =>
            handleMoveJournal(
              [...selectedIds].filter(
                (id) => tradeUnits.find((u) => u.id === id)?.kind === 'position',
              ),
              targetJournalId,
            )
          }
        />
      )}

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
                  <th className="px-1 py-3 text-left w-4" />
                  <th className="px-3 py-3 text-left w-8" />
                  <th className="px-3 py-3 text-left w-8" />
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
                  <th className="pb-2 pr-4 text-left w-10" />
                </tr>
              </thead>
              <tbody>
                {tradeUnits.map((unit) => {
                  const isExpanded = expandedId === unit.id;
                  const isSelected = selectedIds.has(unit.id);
                  const isFlashing = flashIds.has(unit.id);
                  const conf = confidenceBadge(unit.confidence);
                  const regime = unit.regimeAtEntry ? REGIME_BADGE[unit.regimeAtEntry] : null;
                  const isLinked = unit.kind === 'linked_strategy';

                  return (
                    <Fragment key={unit.id}>
                      <tr
                        onClick={() => setExpandedId(isExpanded ? null : unit.id)}
                        className={`border-t border-[#21262d] cursor-pointer transition-colors ${
                          isFlashing
                            ? 'bg-blue-900/20'
                            : isSelected
                            ? 'bg-[#1c2128]'
                            : isExpanded
                            ? 'bg-[#1c2128]'
                            : 'hover:bg-[#1c2128]'
                        }`}
                        style={isSelected ? { boxShadow: 'inset 3px 0 0 #3b82f6' } : undefined}
                      >
                        {/* Untagged badge */}
                        <td
                          className="px-1 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {isUntagged(unit) && (
                            <button
                              title="Add context"
                              onClick={() => setAnnotatePositionId(unit.id)}
                              className="w-2.5 h-2.5 rounded-full bg-yellow-400 hover:bg-yellow-300 transition-colors block"
                            />
                          )}
                        </td>

                        {/* Checkbox */}
                        <td
                          className="px-3 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(unit.id)}
                            className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                          />
                        </td>

                        {/* Expand toggle */}
                        <td className="px-1 py-2.5 text-[#6e7681] text-xs w-4">
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

                        {/* Three-dot menu */}
                        <td
                          className="py-2.5 pr-3 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ThreeDotMenu
                            unit={unit}
                            journals={journalLite}
                            currentJournalId={journalId}
                            onViewDetails={() => setDetailPositionId(unit.id)}
                            onSplit={() => setSplitPositionId(unit.id)}
                            onReclassify={() => setReclassifyUnit(unit)}
                            onDelete={() => handleDelete(unit.id)}
                            onUnlink={() => handleUnlink(unit.id)}
                            onMoveJournal={(targetJournalId) =>
                              handleMoveJournal([unit.id], targetJournalId)
                            }
                            onAnnotate={() => setAnnotatePositionId(unit.id)}
                          />
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-[#0d1117]">
                          <td colSpan={16} className="p-0">
                            {isLinked && unit.legs ? (
                              <div className="px-4 py-2 space-y-2">
                                <div className="text-[10px] uppercase tracking-widest text-[#6e7681] px-4">
                                  {unit.legs.length} position legs
                                  {unit.netDelta != null && (
                                    <span className="ml-3">
                                      Net delta: <span className="text-[#8b949e]">${Math.abs(unit.netDelta).toFixed(2)}</span>
                                    </span>
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

      {/* ── Booba Avatar ───────────────────────────────────────────── */}
      <BoobaAvatar
        healthScore={70}
        insight={boobaInsight}
      />
    </div>
  );
}
