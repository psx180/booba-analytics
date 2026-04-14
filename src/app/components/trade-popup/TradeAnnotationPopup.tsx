'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import PlaybookAdherenceBreakdown from './PlaybookAdherenceBreakdown';
import type { RuleResult } from '@/services/playbooks/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PopupPosition {
  id: string;
  asset: string;
  direction: string;
  pnl: number | null;
  averageEntryPrice: number | null;
  averageExitPrice: number | null;
  totalSize: number | null;
  holdTimeSeconds: number | null;
  regimeAtEntry: string | null;
  // Pre-fill annotation fields
  thesis: string | null;
  conviction: number | null;
  emotion: string | null;
  strategyId: string | null;
  sourceTag: string | null;
  invalidationPrice: number | null;
  targetPrice: string | null;
  mistakes: string | null;
  playbookId: string | null;
}

interface PositionAnnotation {
  thesis: string;
  conviction: number | null;
  emotion: string | null;
  strategyId: string | null;
  sourceTag: string;
  invalidationPrice: string;
  targetPrice: string;
  mistakes: string[];
  notes: string;
  playbookId: string | null;
}

interface Strategy {
  id: string;
  name: string;
}

interface Playbook {
  id: string;
  name: string;
}

interface AdherencePreview {
  playbookId: string;
  score: number;
  results: RuleResult[];
}

interface SectionProps {
  position: PopupPosition;
  formData: PositionAnnotation;
  strategies: Strategy[];
  playbooks: Playbook[];
  sourceTags: string[];
  onUpdate: (data: Partial<PositionAnnotation>) => void;
  onNewStrategy: (name: string) => Promise<Strategy | null>;
  adherencePreview: AdherencePreview | null;
  adherenceLoading: boolean;
}

interface PopupSection {
  id: string;
  label: string;
  component: React.FC<SectionProps>;
  defaultExpanded: boolean;
  priority: number;
}

export interface TradeAnnotationPopupProps {
  position: PopupPosition;
  onClose: () => void;
  onSaved: (message: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMOTION_OPTIONS = ['Focused', 'Confident', 'Anxious', 'FOMO', 'Revenge', 'Bored'];

const MISTAKE_OPTIONS = [
  'Entered too early',
  'Entered too late',
  'Wrong size',
  'Ignored stop',
  'No plan',
  'Chased',
  'Emotional entry',
];

const REGIME_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  trending_low_vol:  { label: 'Trending',    bg: 'bg-green-900/40',  text: 'text-green-400' },
  trending_high_vol: { label: 'Trending HV', bg: 'bg-green-900/30',  text: 'text-green-300' },
  ranging_low_vol:   { label: 'Ranging',     bg: 'bg-amber-900/40',  text: 'text-amber-400' },
  ranging_high_vol:  { label: 'Ranging HV',  bg: 'bg-amber-900/30',  text: 'text-amber-300' },
  transitional:      { label: 'Trans.',      bg: 'bg-slate-700/40',  text: 'text-slate-400' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(v: number | null) {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

function fmtPrice(v: number | null) {
  if (v == null) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function fmtHoldTime(s: number | null) {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// ── Section: Quick Capture ────────────────────────────────────────────────────

function QuickCaptureSection({
  position, formData, strategies, playbooks, sourceTags, onUpdate, onNewStrategy,
  adherencePreview, adherenceLoading,
}: SectionProps) {
  const [newStrategyMode, setNewStrategyMode] = useState(false);
  const [newStrategyName, setNewStrategyName] = useState('');
  const [creatingStrategy, setCreatingStrategy] = useState(false);
  const newStratRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (newStrategyMode) newStratRef.current?.focus();
  }, [newStrategyMode]);

  const handleCreateStrategy = async () => {
    if (!newStrategyName.trim()) return;
    setCreatingStrategy(true);
    const created = await onNewStrategy(newStrategyName.trim());
    setCreatingStrategy(false);
    if (created) {
      onUpdate({ strategyId: created.id });
      setNewStrategyMode(false);
      setNewStrategyName('');
    }
  };

  const convictionLabels = ['Low', 'Med', 'High'];

  return (
    <div className="space-y-3">
      {/* Strategy */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Strategy
        </label>
        {newStrategyMode ? (
          <div className="flex gap-2">
            <input
              ref={newStratRef}
              type="text"
              value={newStrategyName}
              onChange={(e) => setNewStrategyName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateStrategy();
                if (e.key === 'Escape') { setNewStrategyMode(false); setNewStrategyName(''); }
              }}
              placeholder="Strategy name"
              className="flex-1 bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleCreateStrategy}
              disabled={creatingStrategy || !newStrategyName.trim()}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-[#21262d] disabled:text-[#6e7681] text-white text-xs rounded transition-colors"
            >
              {creatingStrategy ? '...' : 'Add'}
            </button>
            <button
              onClick={() => { setNewStrategyMode(false); setNewStrategyName(''); }}
              className="px-2 py-1.5 text-[#6e7681] hover:text-white text-xs transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <select
            value={formData.strategyId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__new__') {
                setNewStrategyMode(true);
              } else {
                onUpdate({ strategyId: e.target.value || null });
              }
            }}
            className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value="">— No strategy —</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="__new__">+ New Strategy</option>
          </select>
        )}
      </div>

      {/* Playbook */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Playbook
        </label>
        <select
          value={formData.playbookId ?? ''}
          onChange={(e) => onUpdate({ playbookId: e.target.value || null })}
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
        >
          <option value="">— No playbook —</option>
          {playbooks.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {adherenceLoading && (
          <div className="text-[10px] text-[#6e7681] mt-1">Scoring adherence…</div>
        )}
        {adherencePreview && !adherenceLoading && (
          <div className="mt-2">
            <PlaybookAdherenceBreakdown
              score={adherencePreview.score}
              results={adherencePreview.results}
              playbookName={playbooks.find((p) => p.id === adherencePreview.playbookId)?.name}
            />
          </div>
        )}
      </div>

      {/* Thesis */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Thesis
        </label>
        <input
          type="text"
          value={formData.thesis}
          onChange={(e) => onUpdate({ thesis: e.target.value })}
          placeholder="Why did you take this trade?"
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 placeholder-[#6e7681]"
        />
      </div>

      {/* Conviction */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Conviction
        </label>
        <div className="flex gap-2">
          {convictionLabels.map((label, i) => {
            const value = i + 1;
            const active = formData.conviction === value;
            return (
              <button
                key={label}
                type="button"
                onClick={() => onUpdate({ conviction: active ? null : value })}
                className={`flex-1 py-1.5 text-xs rounded border transition-colors ${
                  active
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#6e7681] hover:text-[#e6edf3]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Emotion */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Emotion
        </label>
        <div className="flex flex-wrap gap-1.5">
          {EMOTION_OPTIONS.map((emotion) => {
            const active = formData.emotion === emotion;
            return (
              <button
                key={emotion}
                type="button"
                onClick={() => onUpdate({ emotion: active ? null : emotion })}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  active
                    ? 'bg-purple-700 border-purple-500 text-white'
                    : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#6e7681] hover:text-[#e6edf3]'
                }`}
              >
                {emotion}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Section: More Details ─────────────────────────────────────────────────────

// DetailSection ignores playbooks/preview props but accepts SectionProps
// so the registry stays uniform.
function DetailSection({ position, formData, sourceTags, onUpdate }: SectionProps) {
  return (
    <div className="space-y-3">
      {/* Source / Caller */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Source / Caller
        </label>
        <select
          value={formData.sourceTag}
          onChange={(e) => onUpdate({ sourceTag: e.target.value })}
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
        >
          <option value="">— None —</option>
          <option value="Manual">Manual</option>
          {sourceTags.filter((t) => t !== 'Manual').map((tag) => (
            <option key={tag} value={tag}>{tag}</option>
          ))}
        </select>
      </div>

      {/* Invalidation Price */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Invalidation Price
        </label>
        <input
          type="number"
          value={formData.invalidationPrice}
          onChange={(e) => onUpdate({ invalidationPrice: e.target.value })}
          placeholder={position.averageEntryPrice != null ? `e.g. near ${fmtPrice(position.averageEntryPrice)}` : 'Price where thesis is wrong'}
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 placeholder-[#6e7681]"
        />
      </div>

      {/* Target Price */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Target Price
        </label>
        <input
          type="number"
          value={formData.targetPrice}
          onChange={(e) => onUpdate({ targetPrice: e.target.value })}
          placeholder="Price target"
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 placeholder-[#6e7681]"
        />
      </div>

      {/* Mistakes */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Mistakes
        </label>
        <div className="flex flex-wrap gap-1.5">
          {MISTAKE_OPTIONS.map((mistake) => {
            const active = formData.mistakes.includes(mistake);
            return (
              <button
                key={mistake}
                type="button"
                onClick={() => {
                  const next = active
                    ? formData.mistakes.filter((m) => m !== mistake)
                    : [...formData.mistakes, mistake];
                  onUpdate({ mistakes: next });
                }}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  active
                    ? 'bg-red-900/50 border-red-500/60 text-red-300'
                    : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#6e7681] hover:text-[#e6edf3]'
                }`}
              >
                {mistake}
              </button>
            );
          })}
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Notes
        </label>
        <textarea
          value={formData.notes}
          onChange={(e) => onUpdate({ notes: e.target.value })}
          rows={3}
          placeholder="Additional notes..."
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-2 focus:outline-none focus:border-blue-500 placeholder-[#6e7681] resize-none"
        />
      </div>
    </div>
  );
}

// ── Section Registry ──────────────────────────────────────────────────────────

const POPUP_SECTIONS: PopupSection[] = [
  { id: 'quick', label: 'Quick Capture',  component: QuickCaptureSection, defaultExpanded: true,  priority: 0 },
  { id: 'detail', label: 'More Details',  component: DetailSection,        defaultExpanded: false, priority: 10 },
  // Future: { id: 'order-mgmt', label: 'Order Management', component: OrderMgmtSection, defaultExpanded: false, priority: 20 },
  // Future: { id: 'xpnl', label: 'Expected P&L', component: XpnlSection, defaultExpanded: false, priority: 30 },
];

// ── Collapsible Section Wrapper ───────────────────────────────────────────────

function SectionWrapper({
  section,
  expanded,
  onToggle,
  children,
}: {
  section: PopupSection;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-[#1c2128] transition-colors"
      >
        <span className="text-xs font-medium text-[#8b949e] uppercase tracking-widest">
          {section.label}
        </span>
        <span className="text-[#6e7681] text-xs">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-[#21262d]">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function TradeAnnotationPopup({
  position,
  onClose,
  onSaved,
}: TradeAnnotationPopupProps) {
  const authFetch = useAuthFetch();

  // Split existing thesis into one-liner + notes on load
  const [thesisOneLiner, setThesisOneLiner] = useState('');
  const [existingNotes, setExistingNotes] = useState('');
  useEffect(() => {
    const raw = position.thesis ?? '';
    const split = raw.split('\n\n');
    setThesisOneLiner(split[0] ?? '');
    setExistingNotes(split.slice(1).join('\n\n'));
  }, [position.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [formData, setFormData] = useState<PositionAnnotation>(() => ({
    thesis: position.thesis?.split('\n\n')[0] ?? '',
    conviction: position.conviction ?? null,
    emotion: position.emotion ?? null,
    strategyId: position.strategyId ?? null,
    sourceTag: position.sourceTag ?? '',
    invalidationPrice: position.invalidationPrice != null ? String(position.invalidationPrice) : '',
    targetPrice: position.targetPrice ?? '',
    mistakes: position.mistakes ? (JSON.parse(position.mistakes) as string[]) : [],
    notes: position.thesis?.includes('\n\n') ? position.thesis.split('\n\n').slice(1).join('\n\n') : '',
    playbookId: position.playbookId ?? null,
  }));

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [sourceTags, setSourceTags] = useState<string[]>([]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(
    () => Object.fromEntries(POPUP_SECTIONS.map((s) => [s.id, s.defaultExpanded])),
  );
  const [saving, setSaving] = useState(false);
  const [adherencePreview, setAdherencePreview] = useState<AdherencePreview | null>(null);
  const [adherenceLoading, setAdherenceLoading] = useState(false);

  useEffect(() => {
    authFetch('/api/strategies')
      .then((r) => r.json())
      .then((d) => {
        setStrategies(d.strategies ?? []);
        setSourceTags(d.sourceTags ?? []);
      })
      .catch(() => {});
    authFetch('/api/playbooks')
      .then((r) => r.json())
      .then((d) => setPlaybooks(d.playbooks ?? []))
      .catch(() => {});
  }, [authFetch]);

  // Preview adherence whenever the user picks a different playbook. The
  // result isn't persisted until they click Save — server re-runs the
  // check at that point so what they saw matches what gets stored.
  useEffect(() => {
    const id = formData.playbookId;
    if (!id) { setAdherencePreview(null); return; }
    let cancelled = false;
    setAdherenceLoading(true);
    authFetch('/api/playbooks/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId: position.id, playbookId: id }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.results) {
          setAdherencePreview({ playbookId: id, score: d.score ?? 0, results: d.results });
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAdherenceLoading(false); });
    return () => { cancelled = true; };
  }, [formData.playbookId, position.id, authFetch]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleUpdate = (patch: Partial<PositionAnnotation>) => {
    setFormData((prev) => ({ ...prev, ...patch }));
  };

  const handleNewStrategy = async (name: string): Promise<Strategy | null> => {
    try {
      const res = await authFetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.strategy) {
        setStrategies((prev) => [...prev, data.strategy].sort((a, b) => a.name.localeCompare(b.name)));
        return data.strategy;
      }
    } catch {}
    return null;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Combine thesis + notes
      const fullThesis = formData.notes.trim()
        ? `${formData.thesis}\n\n${formData.notes.trim()}`
        : formData.thesis;

      const patch: Record<string, unknown> = {
        thesis: fullThesis,
        conviction: formData.conviction,
        emotion: formData.emotion,
        strategyId: formData.strategyId,
        sourceTag: formData.sourceTag || null,
        invalidationPrice: formData.invalidationPrice ? parseFloat(formData.invalidationPrice) : null,
        targetPrice: formData.targetPrice || null,
        mistakes: formData.mistakes.length > 0 ? JSON.stringify(formData.mistakes) : null,
        playbookId: formData.playbookId,
      };

      await authFetch(`/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      // Contextual save message
      const strategyName = strategies.find((s) => s.id === formData.strategyId)?.name;
      const msg = strategyName
        ? `Noted — tagged as ${strategyName}`
        : formData.thesis
        ? 'Got it!'
        : 'Context saved.';

      onSaved(msg);
    } catch (err) {
      console.error('Save failed', err);
    } finally {
      setSaving(false);
    }
  };

  const regime = position.regimeAtEntry ? REGIME_BADGE[position.regimeAtEntry] : null;
  const pnlColor = position.pnl == null ? 'text-[#6e7681]' : position.pnl >= 0 ? 'text-green-400' : 'text-red-400';

  const sortedSections = [...POPUP_SECTIONS].sort((a, b) => a.priority - b.priority);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl flex flex-col"
        style={{ width: '100%', maxWidth: '500px', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#21262d] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-semibold text-white text-base">{position.asset}</span>
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
              position.direction === 'long' ? 'text-green-400 bg-green-900/30' : 'text-red-400 bg-red-900/30'
            }`}>
              {position.direction.toUpperCase()}
            </span>
            <span className={`text-sm font-medium ${pnlColor}`}>{fmt$(position.pnl)}</span>
          </div>
          <button
            onClick={onClose}
            className="text-[#6e7681] hover:text-white text-lg leading-none transition-colors ml-3 shrink-0"
          >
            ×
          </button>
        </div>

        {/* Trade summary row */}
        <div className="px-5 py-2.5 border-b border-[#21262d] flex items-center gap-4 text-xs text-[#6e7681] shrink-0 flex-wrap">
          <span>Entry <span className="text-[#8b949e]">{fmtPrice(position.averageEntryPrice)}</span></span>
          <span>Exit <span className="text-[#8b949e]">{fmtPrice(position.averageExitPrice)}</span></span>
          {position.totalSize != null && (
            <span>Size <span className="text-[#8b949e]">{position.totalSize.toFixed(4)}</span></span>
          )}
          <span>Hold <span className="text-[#8b949e]">{fmtHoldTime(position.holdTimeSeconds)}</span></span>
          {regime && (
            <span className={`inline-block px-1.5 py-0.5 rounded font-medium ${regime.bg} ${regime.text}`}>
              {regime.label}
            </span>
          )}
        </div>

        {/* Scrollable sections */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
          {sortedSections.map((section) => {
            const expanded = expandedSections[section.id] ?? section.defaultExpanded;
            const SectionComponent = section.component;
            return (
              <SectionWrapper
                key={section.id}
                section={section}
                expanded={expanded}
                onToggle={() =>
                  setExpandedSections((prev) => ({ ...prev, [section.id]: !expanded }))
                }
              >
                <SectionComponent
                  position={position}
                  formData={formData}
                  strategies={strategies}
                  playbooks={playbooks}
                  sourceTags={sourceTags}
                  onUpdate={handleUpdate}
                  onNewStrategy={handleNewStrategy}
                  adherencePreview={adherencePreview}
                  adherenceLoading={adherenceLoading}
                />
              </SectionWrapper>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[#21262d] flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="text-sm text-[#6e7681] hover:text-[#8b949e] transition-colors"
          >
            Skip
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-400 text-white text-sm font-medium rounded transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
