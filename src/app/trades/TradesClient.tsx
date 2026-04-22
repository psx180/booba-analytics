'use client';

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { useSearchParams } from 'next/navigation';
import TradeDetailModal from './TradeDetailModal';
import TradeAnnotationPopup, { type PopupPosition } from '@/app/components/trade-popup/TradeAnnotationPopup';
import { useBooba } from '@/app/components/booba/BoobaContext';
import { useGroupingProgress } from '../GroupingProgressContext';
import { useJournal } from '../JournalContext';
import { useLive } from '../LiveContext';
import { useSync } from '@/contexts/SyncContext';
import { useAuthFetch } from '@/lib/api-client';
import {
  useTradesFilter,
  type TradesFilter,
  EMPTY_TRADES_FILTER,
  isFilterActive,
  serializeFilterToUrl,
  parseFilterFromUrl,
} from '@/contexts/TradesFilterContext';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TradeUnit {
  id: string;
  kind: 'position' | 'linked_strategy';
  asset: string;
  direction: string;
  tradeType: string | null;
  manualTradeType?: string | null;
  status: string;
  pnl: number | null;
  fees: number | null;
  funding: number | null;
  totalSize: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  holdTimeSeconds: number | null;
  confidence: number | null;
  groupingConfirmed: boolean;
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
  playbookId?: string | null;
  confirmation?: string | null;
  adherenceScore?: number | null;
  builderCodes?: string[];
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
  'scalp', 'directional', 'scaled_directional', 'carry_trade', 'market_making', 'liquidated',
];

const ALL_TRADE_TYPES = [
  'scalp', 'directional', 'scaled_directional', 'carry_trade', 'market_making', 'delta_neutral',
];

// Options shown in the click-to-edit trade type popover
const MANUAL_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'scalp',              label: 'scalp' },
  { value: 'directional',        label: 'directional' },
  { value: 'scaled_directional', label: 'scaled directional' },
  { value: 'carry_trade',        label: 'carry' },
  { value: 'position',           label: 'position' },
  { value: 'reversal',           label: 'reversal' },
  { value: 'breakout',           label: 'breakout' },
  { value: 'other',              label: 'other' },
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

/**
 * Grouping confidence indicator.
 * Returns null (no icon) for high-confidence or unknown groupings.
 * Returns a descriptor for medium/low confidence or user-confirmed.
 */
function groupingIndicator(
  confirmed: boolean,
  c: number | null,
): { icon: string; color: string; title: string } | null {
  if (confirmed) return { icon: '✓', color: 'text-green-400', title: 'User-confirmed grouping' };
  if (c == null || c > 0.8) return null; // high confidence — no icon needed
  if (c >= 0.5) return { icon: '⚠', color: 'text-yellow-400', title: `Medium grouping confidence (${Math.round(c * 100)}%)` };
  return { icon: '●', color: 'text-red-400', title: `Low grouping confidence (${Math.round(c * 100)}%) — consider reviewing` };
}

const ROLE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  entry:          { bg: 'bg-blue-900/30',  text: 'text-blue-400',  label: 'Entry' },
  'take profit':  { bg: 'bg-green-900/30', text: 'text-green-400', label: 'TP' },
  'stop loss':    { bg: 'bg-red-900/30',   text: 'text-red-400',   label: 'SL' },
  'manual close': { bg: 'bg-slate-700/40', text: 'text-slate-400', label: 'Close' },
};

/** True when a position is marked open but its last exit is >24h in the past — likely orphaned. */
function isPossiblyOrphaned(unit: { status: string; lastExitTime: string | null }): boolean {
  if (unit.status !== 'open' || !unit.lastExitTime) return false;
  return Date.now() - new Date(unit.lastExitTime).getTime() > 24 * 60 * 60 * 1000;
}

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
    liquidated:         'text-red-400 bg-red-900/40 font-semibold',
    position:           'text-yellow-400 bg-yellow-900/30',
    reversal:           'text-rose-400 bg-rose-900/30',
    breakout:           'text-violet-400 bg-violet-900/30',
    other:              'text-[#8b949e] bg-[#21262d]',
  };
  return colors[type] ?? 'text-[#6e7681] bg-[#21262d]';
}

function typeBadgeLabel(type: string): string {
  if (type === 'liquidated') return 'LIQUIDATED';
  if (type === 'carry_trade') return 'carry';
  return type.replace(/_/g, ' ');
}

// ── Trade Type Chip (click-to-edit) ───────────────────────────────────────────

function TradeTypeChip({
  unit,
  onSelect,
}: {
  unit: TradeUnit;
  onSelect: (positionId: string, value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isManual = unit.kind === 'position' && unit.manualTradeType != null;
  const isLinked = unit.kind === 'linked_strategy';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        disabled={isLinked}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={isManual ? 'Manual override — click to change' : 'Auto-detected — click to override'}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${
          unit.tradeType ? typeBadgeClass(unit.tradeType) : 'text-[#6e7681] bg-[#21262d]'
        } ${isLinked ? '' : 'hover:ring-1 hover:ring-white/20 cursor-pointer'}`}
      >
        {unit.tradeType ? typeBadgeLabel(unit.tradeType) : '—'}
        <span className="opacity-60 text-[10px]">{isManual ? '📝' : unit.tradeType ? '📊' : ''}</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-50 bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl py-1 w-44"
          onClick={(e) => e.stopPropagation()}
        >
          {MANUAL_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onSelect(unit.id, opt.value);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-[#21262d] transition-colors ${
                unit.tradeType === opt.value ? 'text-white' : 'text-[#8b949e]'
              }`}
            >
              <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${typeBadgeClass(opt.value)}`}>
                {opt.label}
              </span>
              {unit.tradeType === opt.value && (
                <span className="ml-auto text-[10px] text-[#6e7681]">
                  {isManual ? 'override' : 'auto'}
                </span>
              )}
            </button>
          ))}
          {isManual && (
            <>
              <div className="border-t border-[#30363d] my-1" />
              <button
                onClick={() => { onSelect(unit.id, null); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-xs text-[#6e7681] hover:bg-[#21262d] hover:text-[#8b949e] transition-colors"
              >
                Clear override (back to auto)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const EXEC_TYPE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  single:       { bg: 'bg-[#21262d]',        text: 'text-[#8b949e]',    label: 'single' },
  partial_fill: { bg: 'bg-blue-900/25',       text: 'text-blue-400',     label: 'partial' },
  twap:         { bg: 'bg-purple-900/30',     text: 'text-purple-400',   label: 'TWAP' },
  // Exchange-reported execution types
  market:       { bg: 'bg-[#21262d]',        text: 'text-[#8b949e]',    label: 'market' },
  limit:        { bg: 'bg-slate-700/30',      text: 'text-slate-400',    label: 'limit' },
  ioc:          { bg: 'bg-amber-900/25',      text: 'text-amber-400',    label: 'IOC' },
  fok:          { bg: 'bg-amber-900/25',      text: 'text-amber-400',    label: 'FOK' },
};

function execTypeBadge(type: string | null): { bg: string; text: string; label: string } | null {
  if (!type) return null;
  return EXEC_TYPE_BADGE[type.toLowerCase()] ?? { bg: 'bg-[#21262d]', text: 'text-[#6e7681]', label: type };
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
  isMerging,
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
  isMerging: boolean;
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
            disabled={hasLinkedStrategy || mixedAssets || isMerging}
            title={hasLinkedStrategy ? 'Cannot merge linked strategies' : mixedAssets ? 'Can only merge same-asset positions' : undefined}
            className="px-3 py-1.5 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 text-sm text-[#e6edf3] border border-[#30363d] rounded transition-colors flex items-center gap-1.5"
          >
            {isMerging ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Merging…
              </>
            ) : (
              'Merge Positions'
            )}
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

      {/* Hidden — single journal for now, testnet disabled */}
      {/*
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
      */}
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
              {/* Hidden — single journal for now, testnet disabled */}
              {/*
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
              */}
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

// ── Chip Filter Bar ────────────────────────────────────────────────────────────

type FilterType =
  | 'direction' | 'regime' | 'asset' | 'tradeType' | 'status'
  | 'dateRange' | 'strategy' | 'playbook' | 'pnl' | 'signal' | 'builderCode';

const ALL_FILTER_TYPES: FilterType[] = [
  'direction', 'regime', 'asset', 'tradeType', 'status',
  'dateRange', 'strategy', 'playbook', 'pnl', 'signal', 'builderCode',
];

const FILTER_TYPE_LABELS: Record<FilterType, string> = {
  direction: 'Direction', regime: 'Regime', asset: 'Asset',
  tradeType: 'Trade Type', status: 'Status', dateRange: 'Date Range',
  strategy: 'Strategy', playbook: 'Playbook', pnl: 'P&L', signal: 'Signal',
  builderCode: 'Builder Code',
};

function isFilterTypeActive(type: FilterType, f: TradesFilter): boolean {
  switch (type) {
    case 'direction': return f.direction !== '';
    case 'regime': return f.regimes.length > 0;
    case 'asset': return f.assets.length > 0;
    case 'tradeType': return f.tradeTypes.length > 0;
    case 'status': return f.status !== '';
    case 'dateRange': return f.dateFrom !== '' || f.dateTo !== '';
    case 'strategy': return f.strategyIds.length > 0;
    case 'playbook': return f.playbookId !== '';
    case 'pnl': return f.pnlFilter !== '';
    case 'signal': return f.signalSource !== '';
    case 'builderCode': return f.builderCodes.length > 0;
  }
}

function clearFilterType(type: FilterType, f: TradesFilter): TradesFilter {
  switch (type) {
    case 'direction': return { ...f, direction: '' };
    case 'regime': return { ...f, regimes: [] };
    case 'asset': return { ...f, assets: [] };
    case 'tradeType': return { ...f, tradeTypes: [] };
    case 'status': return { ...f, status: '' };
    case 'dateRange': return { ...f, dateFrom: '', dateTo: '' };
    case 'strategy': return { ...f, strategyIds: [] };
    case 'playbook': return { ...f, playbookId: '', playbookAdherence: '' };
    case 'pnl': return { ...f, pnlFilter: '', pnlMin: '', pnlMax: '' };
    case 'signal': return { ...f, signalSource: '', signalCaller: '' };
    case 'builderCode': return { ...f, builderCodes: [], builderCodeExclude: false };
  }
}

function getChipLabel(
  type: FilterType,
  f: TradesFilter,
  strategies: { id: string; name: string }[],
  playbooks: { id: string; name: string }[],
): string {
  switch (type) {
    case 'direction': return f.direction === 'long' ? 'Long' : 'Short';
    case 'regime':
      if (f.regimes.length === 1) return REGIME_BADGE[f.regimes[0]]?.label ?? f.regimes[0];
      return `Regimes (${f.regimes.length})`;
    case 'asset':
      if (f.assets.length === 1) return f.assets[0];
      return `Assets (${f.assets.length})`;
    case 'tradeType':
      if (f.tradeTypes.length === 1) return f.tradeTypes[0].replace(/_/g, ' ');
      return `Types (${f.tradeTypes.length})`;
    case 'status': return f.status === 'open' ? 'Open' : 'Closed';
    case 'dateRange': {
      const fmt = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (f.dateFrom && f.dateTo) return `${fmt(f.dateFrom)} – ${fmt(f.dateTo)}`;
      if (f.dateFrom) return `From ${fmt(f.dateFrom)}`;
      return `To ${fmt(f.dateTo)}`;
    }
    case 'strategy':
      if (f.strategyIds.length === 1) return strategies.find((s) => s.id === f.strategyIds[0])?.name ?? 'Strategy';
      return `Strategies (${f.strategyIds.length})`;
    case 'playbook': {
      const name = playbooks.find((p) => p.id === f.playbookId)?.name ?? 'Playbook';
      if (f.playbookAdherence === 'high') return `${name} >80%`;
      if (f.playbookAdherence === 'low') return `${name} <50%`;
      return name;
    }
    case 'pnl':
      if (f.pnlFilter === 'winners') return 'Winners';
      if (f.pnlFilter === 'losers') return 'Losers';
      return `${f.pnlMin ? `$${f.pnlMin}` : '-∞'} – ${f.pnlMax ? `$${f.pnlMax}` : '+∞'}`;
    case 'signal':
      if (f.signalCaller) return f.signalCaller;
      return f.signalSource === 'has_signal' ? 'Has Signal' : 'No Signal';
    case 'builderCode': {
      const prefix = f.builderCodeExclude ? 'Excl. ' : '';
      if (f.builderCodes.length === 1) return `${prefix}${f.builderCodes[0]}`;
      return `${prefix}Builder (${f.builderCodes.length})`;
    }
  }
}

// ── Per-type filter editors ──────────────────────────────────────────────────

function FilterEditor({
  type, filter, setFilter, assetOptions, strategies, playbooks, sourceTags, builderCodeOptions, onClose,
}: {
  type: FilterType;
  filter: TradesFilter;
  setFilter: (f: TradesFilter) => void;
  assetOptions: string[];
  strategies: { id: string; name: string }[];
  playbooks: { id: string; name: string }[];
  sourceTags: string[];
  builderCodeOptions: string[];
  onClose: () => void;
}) {
  const sel = 'w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500';
  const inp = 'w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500';
  const btn = (active: boolean) =>
    `w-full text-left px-3 py-1.5 text-sm rounded transition-colors ${active ? 'bg-blue-600 text-white' : 'text-[#e6edf3] hover:bg-[#21262d]'}`;

  switch (type) {
    case 'direction':
      return (
        <div className="p-2 w-36 space-y-0.5">
          {(['long', 'short'] as const).map((d) => (
            <button key={d} className={btn(filter.direction === d)}
              onClick={() => { setFilter({ ...filter, direction: filter.direction === d ? '' : d }); onClose(); }}>
              {d === 'long' ? 'Long' : 'Short'}
            </button>
          ))}
        </div>
      );

    case 'status':
      return (
        <div className="p-2 w-36 space-y-0.5">
          {(['open', 'closed'] as const).map((s) => (
            <button key={s} className={btn(filter.status === s)}
              onClick={() => { setFilter({ ...filter, status: filter.status === s ? '' : s }); onClose(); }}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      );

    case 'regime':
      return (
        <div className="p-2 w-52 space-y-0.5">
          {Object.entries(REGIME_BADGE).map(([value, { label }]) => (
            <label key={value} className="flex items-center gap-2 px-2 py-1.5 text-sm text-[#e6edf3] hover:bg-[#21262d] cursor-pointer rounded">
              <input type="checkbox" className="accent-blue-500 w-3.5 h-3.5"
                checked={filter.regimes.includes(value)}
                onChange={() => {
                  const next = filter.regimes.includes(value)
                    ? filter.regimes.filter((r) => r !== value)
                    : [...filter.regimes, value];
                  setFilter({ ...filter, regimes: next });
                }} />
              {label}
            </label>
          ))}
        </div>
      );

    case 'asset':
      return (
        <div className="p-2 w-44 max-h-56 overflow-y-auto space-y-0.5">
          {assetOptions.map((a) => (
            <label key={a} className="flex items-center gap-2 px-2 py-1.5 text-sm text-[#e6edf3] hover:bg-[#21262d] cursor-pointer rounded">
              <input type="checkbox" className="accent-blue-500 w-3.5 h-3.5"
                checked={filter.assets.includes(a)}
                onChange={() => {
                  const next = filter.assets.includes(a)
                    ? filter.assets.filter((x) => x !== a)
                    : [...filter.assets, a];
                  setFilter({ ...filter, assets: next });
                }} />
              {a}
            </label>
          ))}
        </div>
      );

    case 'tradeType':
      return (
        <div className="p-2 w-52 max-h-56 overflow-y-auto space-y-0.5">
          {[...POSITION_TYPES, 'delta_neutral', 'pairs_trade', 'basis_trade'].map((t) => (
            <label key={t} className="flex items-center gap-2 px-2 py-1.5 text-sm text-[#e6edf3] hover:bg-[#21262d] cursor-pointer rounded">
              <input type="checkbox" className="accent-blue-500 w-3.5 h-3.5"
                checked={filter.tradeTypes.includes(t)}
                onChange={() => {
                  const next = filter.tradeTypes.includes(t)
                    ? filter.tradeTypes.filter((x) => x !== t)
                    : [...filter.tradeTypes, t];
                  setFilter({ ...filter, tradeTypes: next });
                }} />
              {t.replace(/_/g, ' ')}
            </label>
          ))}
        </div>
      );

    case 'dateRange':
      return (
        <div className="p-3 w-72 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">From</label>
              <input type="date" value={filter.dateFrom} onChange={(e) => setFilter({ ...filter, dateFrom: e.target.value })} className={inp} />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">To</label>
              <input type="date" value={filter.dateTo} onChange={(e) => setFilter({ ...filter, dateTo: e.target.value })} className={inp} />
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {[
              { label: 'Today', preset: 'today' }, { label: 'This Week', preset: 'week' },
              { label: 'This Month', preset: 'month' }, { label: '30d', preset: '30d' }, { label: '90d', preset: '90d' },
            ].map(({ label, preset }) => (
              <button key={preset} onClick={() => { const d = getPresetDates(preset); setFilter({ ...filter, ...d }); onClose(); }}
                className="px-2.5 py-1 text-xs bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] rounded border border-[#30363d] transition-colors">
                {label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="w-full text-center text-xs text-blue-400 hover:text-blue-300 py-1 transition-colors">Apply</button>
        </div>
      );

    case 'strategy':
      return (
        <div className="p-2 w-52 max-h-56 overflow-y-auto space-y-0.5">
          {strategies.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[#6e7681]">No strategies yet</p>
          ) : strategies.map((s) => (
            <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 text-sm text-[#e6edf3] hover:bg-[#21262d] cursor-pointer rounded">
              <input type="checkbox" className="accent-blue-500 w-3.5 h-3.5"
                checked={filter.strategyIds.includes(s.id)}
                onChange={() => {
                  const next = filter.strategyIds.includes(s.id)
                    ? filter.strategyIds.filter((x) => x !== s.id)
                    : [...filter.strategyIds, s.id];
                  setFilter({ ...filter, strategyIds: next });
                }} />
              {s.name}
            </label>
          ))}
        </div>
      );

    case 'playbook':
      return (
        <div className="p-2 w-56 space-y-1">
          <select value={filter.playbookId} onChange={(e) => setFilter({ ...filter, playbookId: e.target.value, playbookAdherence: '' })} className={sel}>
            <option value="">— No playbook —</option>
            {playbooks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {filter.playbookId && (
            <select value={filter.playbookAdherence} onChange={(e) => setFilter({ ...filter, playbookAdherence: e.target.value as TradesFilter['playbookAdherence'] })} className={sel}>
              <option value="">Any adherence</option>
              <option value="high">&gt;80%</option>
              <option value="low">&lt;50%</option>
            </select>
          )}
          <button onClick={onClose} className="w-full text-center text-xs text-blue-400 hover:text-blue-300 py-1 transition-colors">Apply</button>
        </div>
      );

    case 'pnl':
      return (
        <div className="p-2 w-44 space-y-1">
          {(['winners', 'losers'] as const).map((v) => (
            <button key={v} className={btn(filter.pnlFilter === v)}
              onClick={() => { setFilter({ ...filter, pnlFilter: filter.pnlFilter === v ? '' : v, pnlMin: '', pnlMax: '' }); onClose(); }}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
          <div className="border-t border-[#30363d] pt-2 mt-1 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest text-[#6e7681]">Custom range</p>
            <div className="grid grid-cols-2 gap-1">
              <input type="number" placeholder="-∞" value={filter.pnlMin}
                onChange={(e) => setFilter({ ...filter, pnlFilter: 'custom', pnlMin: e.target.value })}
                className={inp + ' text-xs'} />
              <input type="number" placeholder="+∞" value={filter.pnlMax}
                onChange={(e) => setFilter({ ...filter, pnlFilter: 'custom', pnlMax: e.target.value })}
                className={inp + ' text-xs'} />
            </div>
            <button onClick={onClose} className="w-full text-center text-xs text-blue-400 hover:text-blue-300 py-0.5 transition-colors">Apply</button>
          </div>
        </div>
      );

    case 'signal':
      return (
        <div className="p-2 w-48 space-y-1">
          {(['has_signal', 'no_signal'] as const).map((v) => (
            <button key={v} className={btn(filter.signalSource === v)}
              onClick={() => { setFilter({ ...filter, signalSource: filter.signalSource === v ? '' : v, signalCaller: '' }); if (v === 'no_signal') onClose(); }}>
              {v === 'has_signal' ? 'Has Signal' : 'No Signal'}
            </button>
          ))}
          {filter.signalSource === 'has_signal' && sourceTags.length > 0 && (
            <select value={filter.signalCaller} onChange={(e) => setFilter({ ...filter, signalCaller: e.target.value })} className={sel + ' mt-1'}>
              <option value="">Any caller</option>
              {sourceTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {filter.signalSource === 'has_signal' && <button onClick={onClose} className="w-full text-center text-xs text-blue-400 hover:text-blue-300 py-0.5 transition-colors">Apply</button>}
        </div>
      );

    case 'builderCode':
      return (
        <div className="p-2 w-52 space-y-1.5">
          <div className="flex gap-1 pb-1 border-b border-[#30363d]">
            <button
              className={`flex-1 py-1 text-xs rounded transition-colors ${!filter.builderCodeExclude ? 'bg-blue-700 text-white' : 'text-[#8b949e] hover:bg-[#21262d]'}`}
              onClick={() => setFilter({ ...filter, builderCodeExclude: false })}
            >
              Include
            </button>
            <button
              className={`flex-1 py-1 text-xs rounded transition-colors ${filter.builderCodeExclude ? 'bg-red-800 text-white' : 'text-[#8b949e] hover:bg-[#21262d]'}`}
              onClick={() => setFilter({ ...filter, builderCodeExclude: true })}
            >
              Exclude
            </button>
          </div>
          {builderCodeOptions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[#6e7681]">No builder codes in your trades</p>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {builderCodeOptions.map((code) => (
                <label key={code} className="flex items-center gap-2 px-2 py-1.5 text-sm text-[#e6edf3] hover:bg-[#21262d] cursor-pointer rounded">
                  <input
                    type="checkbox"
                    className="accent-blue-500 w-3.5 h-3.5"
                    checked={filter.builderCodes.includes(code)}
                    onChange={() => {
                      const next = filter.builderCodes.includes(code)
                        ? filter.builderCodes.filter((x) => x !== code)
                        : [...filter.builderCodes, code];
                      setFilter({ ...filter, builderCodes: next });
                    }}
                  />
                  {code}
                </label>
              ))}
            </div>
          )}
        </div>
      );
  }
}

// ── Grouping Settings Popover ─────────────────────────────────────────────────

const GROUPING_THRESHOLD_KEY = 'groupingThresholdHours';
const GROUPING_THRESHOLD_OPTIONS: { label: string; value: number }[] = [
  { label: '30m', value: 0.5 },
  { label: '1h',  value: 1 },
  { label: '2h',  value: 2 },
  { label: '4h',  value: 4 },
  { label: '8h',  value: 8 },
  { label: '24h', value: 24 },
];

function GroupingSettingsPopover({ onGroupingReset }: { onGroupingReset: () => void }) {
  const [open, setOpen] = useState(false);
  const [threshold, setThreshold] = useState(4);
  const ref = useRef<HTMLDivElement>(null);
  const { progress } = useGroupingProgress();

  useEffect(() => {
    const stored = localStorage.getItem(GROUPING_THRESHOLD_KEY);
    if (stored) {
      const n = parseFloat(stored);
      if (!isNaN(n)) setThreshold(n);
    }
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleThreshold = (v: number) => {
    setThreshold(v);
    localStorage.setItem(GROUPING_THRESHOLD_KEY, String(v));
  };

  const handleResetClick = () => {
    setOpen(false); // close popover immediately; toast takes over
    onGroupingReset();
  };

  const isResetting = progress !== null && !progress.done;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Grouping settings"
        className={`w-8 h-8 flex items-center justify-center rounded text-base transition-colors ${
          open ? 'bg-[#30363d] text-white' : 'bg-[#21262d] text-[#8b949e] hover:text-white hover:bg-[#30363d]'
        }`}
      >
        ⚙
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded-lg shadow-xl z-20 w-56 p-3 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-2">
              Grouping Threshold
            </div>
            <div className="flex flex-wrap gap-1.5">
              {GROUPING_THRESHOLD_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleThreshold(opt.value)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    threshold === opt.value
                      ? 'bg-blue-700 text-white'
                      : 'bg-[#21262d] text-[#8b949e] hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-[#30363d] pt-2">
            <button
              onClick={handleResetClick}
              disabled={isResetting}
              className="w-full text-left px-2 py-1.5 text-xs text-[#e6edf3] hover:bg-[#21262d] rounded transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <span>⟳</span>
              <span>Reset Grouping</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main chip bar component ──────────────────────────────────────────────────

// Asset, Direction, Date Range are always visible as buttons/chips.
// The remaining filters live behind + Add Filter.
const PINNED_FILTER_TYPES: FilterType[] = ['asset', 'direction', 'dateRange'];
const OVERFLOW_FILTER_TYPES: FilterType[] = ALL_FILTER_TYPES.filter(
  (t) => !PINNED_FILTER_TYPES.includes(t),
);

function ChipFilterBar({
  filter, setFilter, assetOptions, strategies, playbooks, sourceTags, builderCodeOptions,
  savedFilters, setSavedFilters, walletAddress,
}: {
  filter: TradesFilter;
  setFilter: (f: TradesFilter) => void;
  assetOptions: string[];
  strategies: { id: string; name: string }[];
  playbooks: { id: string; name: string }[];
  sourceTags: string[];
  builderCodeOptions: string[];
  savedFilters: SavedFilter[];
  setSavedFilters: (sf: SavedFilter[]) => void;
  walletAddress: string;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [editingType, setEditingType] = useState<FilterType | null>(null);
  const [savedDropOpen, setSavedDropOpen] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);

  const activeOverflowTypes = OVERFLOW_FILTER_TYPES.filter((t) => isFilterTypeActive(t, filter));
  const inactiveOverflowTypes = OVERFLOW_FILTER_TYPES.filter((t) => !isFilterTypeActive(t, filter));

  const matchesSaved = savedFilters.some(
    (sf) => JSON.stringify(sf.filter) === JSON.stringify(filter),
  );

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
      if (editRef.current && !editRef.current.contains(e.target as Node)) setEditingType(null);
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) setSavedDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <>
      {saveModalOpen && (
        <SaveFilterModal
          onSave={(name) => {
            const next = [...savedFilters.filter((sf) => sf.name !== name), { name, filter }];
            setSavedFilters(next);
            persistSavedFilters(walletAddress, next);
            setSaveModalOpen(false);
          }}
          onCancel={() => setSaveModalOpen(false)}
        />
      )}

      {/* No overflow-x-auto here — that clips absolute-positioned dropdowns */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">

          {/* ── Pinned filters: always visible ── */}
          {PINNED_FILTER_TYPES.map((type) => {
            const active = isFilterTypeActive(type, filter);
            const isEditing = editingType === type;
            return (
              <div
                key={type}
                className="relative shrink-0"
                ref={isEditing ? editRef : undefined}
              >
                {active ? (
                  <div className="flex items-center bg-blue-900/20 border border-blue-700/40 rounded text-xs">
                    <button
                      onClick={() => setEditingType(isEditing ? null : type)}
                      className="px-2.5 py-1.5 text-blue-300 hover:text-white transition-colors whitespace-nowrap"
                    >
                      {getChipLabel(type, filter, strategies, playbooks)}
                    </button>
                    <button
                      onClick={() => { setFilter(clearFilterType(type, filter)); if (isEditing) setEditingType(null); }}
                      className="pr-2 pl-1 text-blue-400/60 hover:text-red-400 transition-colors leading-none"
                      title={`Remove ${FILTER_TYPE_LABELS[type]} filter`}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setEditingType(isEditing ? null : type)}
                    className="px-2.5 py-1.5 text-xs text-[#8b949e] hover:text-white bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded transition-colors whitespace-nowrap"
                  >
                    {FILTER_TYPE_LABELS[type]}
                  </button>
                )}
                {isEditing && (
                  <div className="absolute left-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30">
                    <FilterEditor type={type} filter={filter} setFilter={setFilter}
                      assetOptions={assetOptions} strategies={strategies} playbooks={playbooks}
                      sourceTags={sourceTags} builderCodeOptions={builderCodeOptions} onClose={() => setEditingType(null)} />
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Active overflow chips ── */}
          {activeOverflowTypes.map((type) => {
            const isEditing = editingType === type;
            return (
              <div key={type} className="relative shrink-0" ref={isEditing ? editRef : undefined}>
                <div className="flex items-center bg-blue-900/20 border border-blue-700/40 rounded text-xs">
                  <button
                    onClick={() => setEditingType(isEditing ? null : type)}
                    className="px-2.5 py-1.5 text-blue-300 hover:text-white transition-colors whitespace-nowrap"
                  >
                    {getChipLabel(type, filter, strategies, playbooks)}
                  </button>
                  <button
                    onClick={() => { setFilter(clearFilterType(type, filter)); if (isEditing) setEditingType(null); }}
                    className="pr-2 pl-1 text-blue-400/60 hover:text-red-400 transition-colors leading-none"
                    title={`Remove ${FILTER_TYPE_LABELS[type]} filter`}
                  >
                    ×
                  </button>
                </div>
                {isEditing && (
                  <div className="absolute left-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30">
                    <FilterEditor type={type} filter={filter} setFilter={setFilter}
                      assetOptions={assetOptions} strategies={strategies} playbooks={playbooks}
                      sourceTags={sourceTags} builderCodeOptions={builderCodeOptions} onClose={() => setEditingType(null)} />
                  </div>
                )}
              </div>
            );
          })}

          {/* ── + Add Filter (inactive overflow types only) ── */}
          {inactiveOverflowTypes.length > 0 && (
            <div className="relative shrink-0" ref={addRef}>
              <button
                onClick={() => { setAddOpen((o) => !o); setEditingType(null); }}
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-[#8b949e] hover:text-white bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded transition-colors whitespace-nowrap"
              >
                <span>+</span> Add Filter
              </button>
              {addOpen && (
                <div className="absolute left-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30 min-w-[160px]">
                  {inactiveOverflowTypes.map((t) => (
                    <button key={t} onClick={() => { setEditingType(t); setAddOpen(false); }}
                      className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors">
                      {FILTER_TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Inline editor for overflow type selected but not yet active ── */}
          {editingType !== null && OVERFLOW_FILTER_TYPES.includes(editingType) && !isFilterTypeActive(editingType, filter) && (
            <div className="relative shrink-0" ref={editRef}>
              <div className="absolute left-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30">
                <FilterEditor type={editingType} filter={filter} setFilter={setFilter}
                  assetOptions={assetOptions} strategies={strategies} playbooks={playbooks}
                  sourceTags={sourceTags} builderCodeOptions={builderCodeOptions} onClose={() => setEditingType(null)} />
              </div>
              <span className="text-xs text-[#6e7681] px-2">{FILTER_TYPE_LABELS[editingType]}</span>
            </div>
          )}

          {/* ── Right side: clear all + save ── */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {isFilterActive(filter) && (
              <button onClick={() => setFilter(EMPTY_TRADES_FILTER)}
                className="text-xs text-[#6e7681] hover:text-white transition-colors whitespace-nowrap">
                × Clear all
              </button>
            )}
            <div className="relative" ref={saveRef}>
              <button
                onClick={() => setSavedDropOpen((o) => !o)}
                title={matchesSaved ? 'Current filter is saved' : 'Save or load filters'}
                className={`text-base leading-none transition-colors px-1 py-1 rounded hover:bg-[#21262d] ${matchesSaved ? 'text-amber-400' : 'text-[#6e7681] hover:text-white'}`}
              >
                {matchesSaved ? '★' : '☆'}
              </button>
              {savedDropOpen && (
                <div className="absolute right-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30 min-w-[200px]">
                  {savedFilters.length > 0 && (
                    <>
                      {savedFilters.map((sf) => (
                        <div key={sf.name} className="flex items-center group">
                          <button
                            onClick={() => { setFilter(sf.filter); setSavedDropOpen(false); }}
                            className="flex-1 text-left px-3 py-2 text-xs text-[#e6edf3] hover:bg-[#21262d] truncate transition-colors">
                            {sf.name}
                          </button>
                          <button
                            onClick={() => {
                              const next = savedFilters.filter((s) => s.name !== sf.name);
                              setSavedFilters(next);
                              persistSavedFilters(walletAddress, next);
                            }}
                            className="px-2 py-2 text-[#6e7681] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                            title="Delete">
                            ✕
                          </button>
                        </div>
                      ))}
                      <div className="h-px bg-[#30363d]" />
                    </>
                  )}
                  <button
                    onClick={() => { setSaveModalOpen(true); setSavedDropOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs text-[#8b949e] hover:text-white hover:bg-[#21262d] transition-colors">
                    {isFilterActive(filter) ? 'Save current filters…' : 'No active filters to save'}
                  </button>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </>
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
                  <td className="py-1 pr-3">
                    {(() => {
                      const b = execTypeBadge(order.executionType);
                      return b ? (
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${b.bg} ${b.text}`}>
                          {b.label}
                        </span>
                      ) : (
                        <span className="text-[#6e7681]">—</span>
                      );
                    })()}
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

// ── Client-side filter logic ──────────────────────────────────────────────────

const CLIENT_PAGE_SIZE = 50;

function getPresetDates(preset: string): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  switch (preset) {
    case 'today': return { dateFrom: today, dateTo: today };
    case 'week': {
      const d = new Date(now);
      d.setDate(now.getDate() - now.getDay());
      return { dateFrom: d.toISOString().split('T')[0], dateTo: today };
    }
    case 'month': {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { dateFrom: d.toISOString().split('T')[0], dateTo: today };
    }
    case '30d': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { dateFrom: d.toISOString().split('T')[0], dateTo: today };
    }
    case '90d': {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return { dateFrom: d.toISOString().split('T')[0], dateTo: today };
    }
    default: return { dateFrom: '', dateTo: '' };
  }
}

function applyTradesFilter(units: TradeUnit[], f: TradesFilter): TradeUnit[] {
  return units.filter((u) => {
    // Direction
    if (f.direction && u.direction.toLowerCase() !== f.direction) return false;
    // Trade types (multi-select)
    if (f.tradeTypes.length > 0) {
      if (!u.tradeType || !f.tradeTypes.includes(u.tradeType)) return false;
    }
    // Assets (multi-select) — linked strategies have "BTC / ETH" so check each part
    if (f.assets.length > 0) {
      const unitAssets = u.asset.split(' / ');
      if (!f.assets.some((a) => unitAssets.includes(a))) return false;
    }
    // Regimes (multi-select)
    if (f.regimes.length > 0) {
      if (!u.regimeAtEntry || !f.regimes.includes(u.regimeAtEntry)) return false;
    }
    // Status
    if (f.status && u.status !== f.status) return false;
    // Strategy (multi-select by ID)
    if (f.strategyIds.length > 0) {
      if (!u.strategyId || !f.strategyIds.includes(u.strategyId)) return false;
    }
    // Playbook
    if (f.playbookId) {
      if (u.playbookId !== f.playbookId) return false;
      if (f.playbookAdherence === 'high' && (u.adherenceScore ?? 0) < 80) return false;
      if (f.playbookAdherence === 'low' && (u.adherenceScore ?? 100) >= 50) return false;
    }
    // Date range — compare against exit time (or entry time for open positions)
    const ts = u.lastExitTime ?? u.firstEntryTime;
    if (f.dateFrom && ts && new Date(ts) < new Date(f.dateFrom)) return false;
    if (f.dateTo && ts) {
      const toEnd = new Date(f.dateTo);
      toEnd.setHours(23, 59, 59, 999);
      if (new Date(ts) > toEnd) return false;
    }
    // P&L filter
    if (f.pnlFilter === 'winners' && (u.pnl ?? 0) <= 0) return false;
    if (f.pnlFilter === 'losers' && (u.pnl ?? 0) >= 0) return false;
    if (f.pnlFilter === 'custom') {
      const lo = parseFloat(f.pnlMin);
      const hi = parseFloat(f.pnlMax);
      if (!isNaN(lo) && (u.pnl ?? 0) < lo) return false;
      if (!isNaN(hi) && (u.pnl ?? 0) > hi) return false;
    }
    // Signal source
    if (f.signalSource === 'has_signal' && !u.sourceTag) return false;
    if (f.signalSource === 'no_signal' && u.sourceTag) return false;
    if (f.signalSource === 'has_signal' && f.signalCaller && u.sourceTag !== f.signalCaller) return false;
    // Builder code (positions where any fill has this builder code)
    if (f.builderCodes.length > 0) {
      const unitCodes = u.builderCodes ?? [];
      const hasMatch = f.builderCodes.some((bc) => unitCodes.includes(bc));
      if (f.builderCodeExclude ? hasMatch : !hasMatch) return false;
    }
    return true;
  });
}

interface SavedFilter {
  name: string;
  filter: TradesFilter;
}

function savedFiltersKey(wallet: string) { return `savedTradesFilters:${wallet}`; }
function loadSavedFilters(wallet: string): SavedFilter[] {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(savedFiltersKey(wallet)) : null;
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function persistSavedFilters(wallet: string, filters: SavedFilter[]) {
  localStorage.setItem(savedFiltersKey(wallet), JSON.stringify(filters));
}

// ── Save Filter Modal ─────────────────────────────────────────────────────────

function SaveFilterModal({
  onSave,
  onCancel,
}: {
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl p-5 w-full max-w-xs">
        <h3 className="text-base font-semibold text-white mb-3">Save Current Filters</h3>
        <input
          autoFocus
          type="text"
          placeholder="Filter name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name.trim()); }}
          className="w-full bg-[#21262d] border border-[#30363d] rounded px-3 py-2 text-sm text-[#e6edf3] placeholder-[#6e7681] focus:outline-none focus:border-blue-500 mb-4"
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-[#e6edf3] bg-[#21262d] border border-[#30363d] rounded hover:bg-[#30363d] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (name.trim()) onSave(name.trim()); }}
            disabled={!name.trim()}
            className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function TradesClient() {
  // Active wallet + journal scope, both sourced from JournalContext. Every
  // API call routes through buildParams so the table, summary stats,
  // grouping output, and analytics fetches all stay bound to the same
  // journal — and the wallet itself is the Privy-authenticated one (or
  // the dev wallet in dev-bypass mode).
  const { journalId, journals, buildParams, refresh: refreshJournals, walletAddress } = useJournal();
  const { lastSyncImport } = useLive();
  const { syncImportCount } = useSync();
  const authFetch = useAuthFetch();
  const { filter, setFilter } = useTradesFilter();
  const searchParams = useSearchParams();
  const { setBoobaState } = useBooba();
  const { startJob, setProgress, dismissed } = useGroupingProgress();
  // All trade units fetched from server — filtering/sorting done client-side.
  const [allTradeUnits, setAllTradeUnits] = useState<TradeUnit[]>([]);
  const [sortBy, setSortBy] = useState('firstEntryTime');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailPositionId, setDetailPositionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Group editing state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const resetPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirror `dismissed` in a ref so the setInterval closure always reads the
  // latest value without stale-closure issues.
  const dismissedRef = useRef(dismissed);
  useEffect(() => { dismissedRef.current = dismissed; }, [dismissed]);
  const [splitPositionId, setSplitPositionId] = useState<string | null>(null);
  const [reclassifyUnit, setReclassifyUnit] = useState<TradeUnit | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [annotatePositionId, setAnnotatePositionId] = useState<string | null>(null);
  const [annotateQueue, setAnnotateQueue] = useState<string[]>([]);
  const setBoobaInsight = useCallback((msg: string | null) => {
    setBoobaState({ insight: msg, healthScore: 70 });
  }, [setBoobaState]);

  // On mount: set health score to the trades-page default and clear any leftover insight
  useEffect(() => {
    setBoobaState({ healthScore: 70, insight: null });
  }, [setBoobaState]); // eslint-disable-line react-hooks/exhaustive-deps

  const [untaggedCount, setUntaggedCount] = useState(0);
  const [untaggedIds, setUntaggedIds] = useState<string[]>([]);
  const hasMountSynced = useRef(false);
  // Filter dropdown data
  const [strategies, setStrategies] = useState<{ id: string; name: string }[]>([]);
  const [sourceTags, setSourceTags] = useState<string[]>([]);
  const [playbooks, setPlaybooks] = useState<{ id: string; name: string }[]>([]);
  // Saved filters (localStorage)
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(() =>
    loadSavedFilters(walletAddress),
  );

  // ── Fetch all trade units (no filter params — filtered client-side) ──────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const p = buildParams({ pageSize: '1000', page: '1' });

      const [unitsRes, untaggedRes] = await Promise.all([
        authFetch(`/api/trade-units?${p}`),
        authFetch('/api/positions/untagged-count'),
      ]);
      const [unitsData, untaggedData] = await Promise.all([
        unitsRes.json(),
        untaggedRes.json(),
      ]);

      setAllTradeUnits(unitsData.tradeUnits ?? []);
      setUntaggedCount(untaggedData.count ?? 0);
      setUntaggedIds(untaggedData.ids ?? []);
    } finally {
      setLoading(false);
    }
  }, [buildParams, authFetch]);

  useEffect(() => {
    if (!journalId) return;
    fetchData();
  }, [fetchData, journalId]);
  useEffect(() => { setPage(1); }, [filter, sortBy, sortDir]);

  // ── Mount-time sync ─────────────────────────────────────────────────────
  // Non-blocking: page data loads from cache/DB immediately, then this runs
  // in the background to catch any fills missed while the app was closed.
  useEffect(() => {
    if (!journalId || hasMountSynced.current) return;
    hasMountSynced.current = true;
    authFetch('/api/sync', { method: 'POST' })
      .then((r) => r.json())
      .then((data: { imported?: number }) => {
        if ((data.imported ?? 0) > 0) fetchData();
      })
      .catch(() => {});
  // fetchData and authFetch are stable callbacks — including them satisfies
  // the linter without causing re-runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalId]);

  // ── React to background polling sync finds ──────────────────────────────
  // When the 60-second poller in usePacificaLive finds new trades it bumps
  // lastSyncImport. Refresh the table so the new fills appear.
  const lastSyncImportRef = useRef(lastSyncImport);
  useEffect(() => {
    if (lastSyncImport === lastSyncImportRef.current) return;
    lastSyncImportRef.current = lastSyncImport;
    fetchData();
    showToast('New trades synced — list refreshed.');
  // fetchData / showToast are stable; lastSyncImport drives the logic.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSyncImport]);

  // ── React to manual sync (from NavBar ↻ button) ─────────────────────────
  const syncImportCountRef = useRef(syncImportCount);
  useEffect(() => {
    if (syncImportCount === syncImportCountRef.current) return;
    syncImportCountRef.current = syncImportCount;
    fetchData();
    showToast('Sync complete — list refreshed.');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncImportCount]);

  const handleSort = (field: string) => {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir('desc'); }
  };

  // ── Strategies & playbooks for filter dropdowns ─────────────────────────────
  useEffect(() => {
    authFetch('/api/strategies')
      .then((r) => r.json())
      .then((d) => { setStrategies(d.strategies ?? []); setSourceTags(d.sourceTags ?? []); })
      .catch(() => {});
  // authFetch is stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    authFetch('/api/playbooks')
      .then((r) => r.json())
      .then((d) => setPlaybooks(d.playbooks ?? []))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── URL sync: parse on mount and on URL change, serialize on filter change ──
  // searchParams updates when router.push/replace changes the URL (e.g. Booba
  // navigating to /trades?assets=BTC from another page). window.history
  // .replaceState (used in the write-back effect below) does NOT update
  // useSearchParams, so there is no read↔write loop.
  useEffect(() => {
    const parsed = parseFilterFromUrl(new URLSearchParams(searchParams.toString()));
    setFilter({ ...EMPTY_TRADES_FILTER, ...parsed });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const qs = serializeFilterToUrl(filter).toString();
    const newUrl = qs
      ? `${window.location.pathname}?${qs}`
      : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
  }, [filter]);


  // ── Client-side derived data ───────────────────────────────────────────────

  // Sorted + filtered + paginated views of allTradeUnits.
  const sortedAllUnits = useMemo(() => {
    return [...allTradeUnits].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortBy] ?? '';
      const bv = (b as unknown as Record<string, unknown>)[sortBy] ?? '';
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [allTradeUnits, sortBy, sortDir]);

  const filteredUnits = useMemo(
    () => applyTradesFilter(sortedAllUnits, filter),
    [sortedAllUnits, filter],
  );

  const displayedUnits = useMemo(
    () => filteredUnits.slice((page - 1) * CLIENT_PAGE_SIZE, page * CLIENT_PAGE_SIZE),
    [filteredUnits, page],
  );

  const clientPagination = useMemo(() => ({
    total: filteredUnits.length,
    page,
    pageSize: CLIENT_PAGE_SIZE,
    totalPages: Math.ceil(filteredUnits.length / CLIENT_PAGE_SIZE),
  }), [filteredUnits.length, page]);

  // Stats bar reflects the filtered view, not the whole journal.
  const filteredSummary = useMemo<Summary | null>(() => {
    if (filteredUnits.length === 0) return null;
    const closed = filteredUnits.filter((u) => u.status === 'closed' && u.pnl != null);
    const winners = closed.filter((u) => (u.pnl ?? 0) > 0);
    const losses = closed.filter((u) => (u.pnl ?? 0) < 0);
    const grossWins = winners.reduce((s, u) => s + (u.pnl ?? 0), 0);
    const grossLosses = Math.abs(losses.reduce((s, u) => s + (u.pnl ?? 0), 0));
    return {
      tradeCount: filteredUnits.length,
      totalPnl: filteredUnits.reduce((s, u) => s + (u.pnl ?? 0), 0),
      winRate: closed.length ? winners.length / closed.length : 0,
      expectancy: closed.length
        ? closed.reduce((s, u) => s + (u.pnl ?? 0), 0) / closed.length
        : 0,
      profitFactor: grossLosses ? grossWins / grossLosses : grossWins > 0 ? 999 : 0,
    };
  }, [filteredUnits]);

  // Asset options derived from all loaded units (not filtered set).
  const assetOptions = useMemo(() => {
    return [
      ...new Set(allTradeUnits.flatMap((u) => u.asset.split(' / '))),
    ].sort();
  }, [allTradeUnits]);

  const builderCodeOptions = useMemo(() => {
    return [...new Set(allTradeUnits.flatMap((u) => u.builderCodes ?? []))].sort();
  }, [allTradeUnits]);

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

  const selectedUnits = allTradeUnits.filter((u) => selectedIds.has(u.id));

  // ── Group edit operations ───────────────────────────────────────────────────

  const handleMerge = useCallback(async () => {
    const ids = [...selectedIds];
    setIsMerging(true);
    setMergeConfirm(false); // close dialog immediately so user sees spinner
    try {
      const res = await authFetch('/api/positions/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionIds: ids }),
      });
      const data = await res.json();
      clearSelection();
      if (data.merged?.id) flashRows([data.merged.id]);
      await fetchData();

      const { undoData } = data;
      showToast(`Merged ${ids.length} positions.`, async () => {
        await authFetch('/api/positions/merge/undo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ undoData }),
        });
        await fetchData();
      });
    } catch (err) {
      console.error('Merge failed', err);
    } finally {
      setIsMerging(false);
    }
  }, [selectedIds, clearSelection, fetchData, showToast, flashRows, authFetch]);

  const handleLink = useCallback(async (strategyType: 'delta_neutral' | 'pairs_trade' | 'basis_trade') => {
    const ids = [...selectedIds].filter((id) => allTradeUnits.find((u) => u.id === id)?.kind === 'position');
    if (ids.length < 2) return;
    try {
      const res = await authFetch('/api/positions/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionIds: ids, strategyType }),
      });
      const data = await res.json();
      clearSelection();
      await fetchData();

      const linkedId = data.id;
      showToast(
        `Linked ${ids.length} positions as ${strategyType.replace(/_/g, ' ')}.`,
        linkedId
          ? async () => {
              await authFetch(`/api/linked-strategies/${linkedId}`, { method: 'DELETE' });
              await fetchData();
            }
          : undefined,
      );
    } catch (err) {
      console.error('Link failed', err);
    }
  }, [selectedIds, allTradeUnits, clearSelection, fetchData, showToast]);

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

  const handleManualTradeType = useCallback(async (positionId: string, value: string | null) => {
    // Optimistic update for set; refetch handles clear (we don't have the auto type stored locally)
    if (value !== null) {
      setAllTradeUnits((prev) =>
        prev.map((u) => u.id === positionId ? { ...u, tradeType: value, manualTradeType: value } : u),
      );
    }
    try {
      await authFetch(`/api/positions/${positionId}/trade-type`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualTradeType: value }),
      });
      flashRows([positionId]);
      if (value === null) await fetchData(); // need server to resolve auto type
    } catch (err) {
      console.error('Manual trade type failed', err);
      await fetchData(); // rollback optimistic update
    }
  }, [fetchData, flashRows, authFetch, setAllTradeUnits]);

  const handleDelete = useCallback(async (positionId: string) => {
    if (!confirm('Delete this position? Its orders will become ungrouped.')) return;
    try {
      await authFetch(`/api/positions/${positionId}`, { method: 'DELETE' });
      await fetchData();
    } catch (err) {
      console.error('Delete failed', err);
    }
  }, [fetchData, authFetch]);

  const handleUnlink = useCallback(async (strategyId: string) => {
    if (!confirm('Remove strategy link? Individual positions will remain.')) return;
    try {
      await authFetch(`/api/linked-strategies/${strategyId}`, { method: 'DELETE' });
      await fetchData();
    } catch (err) {
      console.error('Unlink failed', err);
    }
  }, [fetchData, authFetch]);


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

  const handleResetGrouping = useCallback(() => {
    // Clear any existing poll
    if (resetPollRef.current) {
      clearInterval(resetPollRef.current);
      resetPollRef.current = null;
    }

    authFetch('/api/grouping/run', { method: 'POST' })
      .then((res) => {
        if (!res.ok) throw new Error('Reset failed to start');
        startJob({ msg: 'Starting…', percent: 5, done: false });

        // Poll every 2s until the job completes or errors.
        // Each tick checks `dismissed` (from context via the ref below) so we
        // stop updating the toast if the user has closed it.
        const poll = setInterval(async () => {
          if (dismissedRef.current) {
            clearInterval(poll);
            resetPollRef.current = null;
            return;
          }
          try {
            const statusRes = await authFetch('/api/grouping/status');
            const status = await statusRes.json();

            if (status.stage === 'done') {
              clearInterval(poll);
              resetPollRef.current = null;
              setProgress({ msg: status.message, percent: 100, done: true });
              fetchData();
              setTimeout(() => setProgress(null), 3000);
            } else if (status.stage === 'error') {
              clearInterval(poll);
              resetPollRef.current = null;
              setProgress({ msg: status.message, percent: 0, done: true });
              setTimeout(() => setProgress(null), 6000);
            } else {
              setProgress({
                msg: status.message || 'Rebuilding…',
                percent: status.percent ?? 15,
                done: false,
              });
            }
          } catch {
            // Transient poll error — keep polling
          }
        }, 2000);
        resetPollRef.current = poll;
      })
      .catch(() => {
        startJob({ msg: 'Reset failed to start.', percent: 0, done: true });
        setTimeout(() => setProgress(null), 6000);
      });
  }, [authFetch, fetchData, startJob, setProgress]);

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
    playbookId: unit.playbookId ?? null,
    confirmation: unit.confirmation ?? null,
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
    const inPage = allTradeUnits.find((u) => u.id === annotatePositionId);
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
          playbookId: p.playbookId ?? null,
          confirmation: p.confirmation ?? null,
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

      {/* ── Stats Bar — reflects currently filtered view ──────────── */}
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Positions', value: filteredSummary?.tradeCount ?? allTradeUnits.length ?? '—' },
            {
              label: 'Total P&L',
              value: <span className={pnlColor(filteredSummary?.totalPnl ?? null)}>{filteredSummary ? fmt$(filteredSummary.totalPnl) : '—'}</span>,
            },
            { label: 'Win Rate', value: filteredSummary ? `${(filteredSummary.winRate * 100).toFixed(1)}%` : '—' },
            {
              label: 'Expectancy',
              value: <span className={pnlColor(filteredSummary?.expectancy ?? null)}>{filteredSummary ? fmt$(filteredSummary.expectancy) : '—'}</span>,
            },
            { label: 'Profit Factor', value: filteredSummary ? (filteredSummary.profitFactor >= 999 ? '∞' : filteredSummary.profitFactor.toFixed(2)) : '—' },
          ].map(({ label, value }) => (
            <div key={label} className="bg-[#161b22] border border-[#21262d] rounded-lg px-4 py-3">
              <div className="text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">{label}</div>
              <div className="text-lg font-semibold">{value}</div>
            </div>
          ))}
        </div>
        {isFilterActive(filter) && (
          <p className="text-[10px] text-[#6e7681] text-right">
            Showing stats for filtered view ({filteredUnits.length} of {allTradeUnits.length} positions)
          </p>
        )}
      </div>

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

      {/* ── Filter Bar + Grouping Settings ───────────────────────── */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <ChipFilterBar
            filter={filter}
            setFilter={(f) => { setFilter(f); setPage(1); }}
            assetOptions={assetOptions}
            strategies={strategies}
            playbooks={playbooks}
            sourceTags={sourceTags}
            builderCodeOptions={builderCodeOptions}
            savedFilters={savedFilters}
            setSavedFilters={(next) => { setSavedFilters(next); persistSavedFilters(walletAddress, next); }}
            walletAddress={walletAddress}
          />
        </div>
        <GroupingSettingsPopover onGroupingReset={handleResetGrouping} />
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
            const unit = allTradeUnits.find((u) => u.id === id);
            if (unit) setReclassifyUnit(unit);
          }}
          onMoveJournal={(targetJournalId) =>
            handleMoveJournal(
              [...selectedIds].filter(
                (id) => allTradeUnits.find((u) => u.id === id)?.kind === 'position',
              ),
              targetJournalId,
            )
          }
          isMerging={isMerging}
        />
      )}

      {/* ── Trade Units Table ──────────────────────────────────────── */}
      <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
        {/* Subtle refetch indicator: shown when data is reloading but rows are already displayed */}
        {loading && allTradeUnits.length > 0 && (
          <div className="h-0.5 bg-[#21262d] overflow-hidden">
            <div className="h-full bg-blue-500/60 animate-pulse w-1/2 rounded-full" />
          </div>
        )}
        {loading && allTradeUnits.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-[#6e7681] text-sm">Loading...</div>
        ) : allTradeUnits.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-[#6e7681] text-sm gap-2">
            <span>No trade units found. Run the grouping pipeline first.</span>
          </div>
        ) : filteredUnits.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-[#6e7681] text-sm gap-2">
            <span>No trades match the active filters.</span>
            <button
              onClick={() => setFilter(EMPTY_TRADES_FILTER)}
              className="text-xs text-blue-400 hover:text-blue-300 underline transition-colors"
            >
              Clear filters
            </button>
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
                  <th
                    className="pb-2 pr-4 text-left"
                    title="Grouping confidence: ✓ user-confirmed · ⚠ medium confidence · ● low confidence · (blank) high confidence"
                  >
                    <span className="flex items-center gap-1 text-[10px]">
                      <span className="text-green-400">✓</span>
                      <span className="text-yellow-400">⚠</span>
                      <span className="text-red-400 text-[8px]">●</span>
                    </span>
                  </th>
                  <th className="pb-2 pr-4 text-left">Regime</th>
                  <SortTh label="Date" field="firstEntryTime" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="pb-2 pr-4 text-left w-10" />
                </tr>
              </thead>
              <tbody>
                {displayedUnits.map((unit) => {
                  const isExpanded = expandedId === unit.id;
                  const isSelected = selectedIds.has(unit.id);
                  const isFlashing = flashIds.has(unit.id);
                  const groupingInd = groupingIndicator(unit.groupingConfirmed, unit.confidence);
                  const regime = unit.regimeAtEntry ? REGIME_BADGE[unit.regimeAtEntry] : null;
                  const possiblyOrphaned = isPossiblyOrphaned(unit);
                  const isLinked = unit.kind === 'linked_strategy';

                  return (
                    <Fragment key={unit.id}>
                      <tr
                        onClick={() => !isLinked && setDetailPositionId(unit.id)}
                        className={`border-t border-[#21262d] transition-colors ${
                          isLinked ? '' : 'cursor-pointer'
                        } ${
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

                        {/* Accordion chevron — clicking ONLY this toggles the expand; row click opens modal */}
                        <td
                          className="px-1 py-2.5 text-[#6e7681] text-xs w-4"
                          onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : unit.id); }}
                        >
                          <span className="cursor-pointer hover:text-white transition-colors select-none">
                            {isExpanded ? '▾' : '▸'}
                          </span>
                        </td>

                        <td className="py-2.5 pr-4 font-medium text-white">
                          {unit.asset}
                          {isLinked && (
                            <span className="ml-1.5 text-[10px] text-teal-400 bg-teal-900/30 px-1 py-0.5 rounded">
                              linked
                            </span>
                          )}
                          {possiblyOrphaned && (
                            <span
                              className="ml-1.5 text-[10px] text-yellow-400 bg-yellow-900/20 border border-yellow-700/40 px-1 py-0.5 rounded"
                              title="This position appears closed but still shows as open — its closing fills may have been moved to another journal."
                            >
                              ⚠ possibly closed
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
                        <td className="py-2.5 pr-4" onClick={(e) => e.stopPropagation()}>
                          <TradeTypeChip unit={unit} onSelect={handleManualTradeType} />
                        </td>
                        <td className="py-2.5 pr-4">
                          {groupingInd ? (
                            <span
                              className={`text-sm leading-none ${groupingInd.color}`}
                              title={groupingInd.title}
                            >
                              {groupingInd.icon}
                            </span>
                          ) : null}
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
        {clientPagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#21262d] text-xs text-[#6e7681]">
            <span>
              {clientPagination.total} trade units · page {clientPagination.page} of {clientPagination.totalPages}
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
                disabled={page >= clientPagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 bg-[#21262d] rounded disabled:opacity-30 hover:text-white transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Booba avatar + chat are rendered globally by AppShell/BoobaShellLayer */}
    </div>
  );
}
