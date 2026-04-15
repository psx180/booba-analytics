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
  confirmation: string | null;
}

interface PositionAnnotation {
  thesis: string;
  conviction: number | null;
  emotion: string | null;
  strategyId: string | null;
  playbookId: string | null;
  confirmation: string;
  sourceTag: string;
  invalidationPrice: string;
  targetPrice: string;
  mistakes: string[];
  notes: string;
}

interface Strategy {
  id: string;
  name: string;
}

interface Playbook {
  id: string;
  name: string;
  rules: string; // JSON string — used to compute rule count
}

interface AdherencePreview {
  playbookId: string;
  score: number;
  results: RuleResult[];
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

function getRuleCount(rules: string): number {
  try {
    const arr = JSON.parse(rules);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

// ── Section Wrapper ───────────────────────────────────────────────────────────

function SectionWrapper({
  label,
  expanded,
  onToggle,
  children,
}: {
  label: string;
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
          {label}
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

  const [formData, setFormData] = useState<PositionAnnotation>(() => {
    // Split existing thesis: first para → thesis, rest → notes
    const raw = position.thesis ?? '';
    const parts = raw.split('\n\n');
    const thesis = parts[0] ?? '';
    const notes = parts.slice(1).join('\n\n');
    return {
      thesis,
      conviction: position.conviction ?? null,
      emotion: position.emotion ?? null,
      strategyId: position.strategyId ?? null,
      playbookId: position.playbookId ?? null,
      confirmation: position.confirmation ?? '',
      sourceTag: position.sourceTag ?? '',
      invalidationPrice: position.invalidationPrice != null ? String(position.invalidationPrice) : '',
      targetPrice: position.targetPrice ?? '',
      mistakes: position.mistakes ? (JSON.parse(position.mistakes) as string[]) : [],
      notes,
    };
  });

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [sourceTags, setSourceTags] = useState<string[]>([]);

  // Section expansion — REFLECT always open, others collapsed
  const [expanded, setExpanded] = useState({ reflect: true, myplan: false, source: false });

  const [newStrategyMode, setNewStrategyMode] = useState(false);
  const [newStrategyName, setNewStrategyName] = useState('');
  const [creatingStrategy, setCreatingStrategy] = useState(false);
  const newStratRef = useRef<HTMLInputElement>(null);

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

  // Auto-expand MY PLAN when a playbook is selected
  useEffect(() => {
    if (formData.playbookId) {
      setExpanded((prev) => ({ ...prev, myplan: true }));
    }
  }, [formData.playbookId]);

  // Preview adherence whenever playbookId changes
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

  useEffect(() => {
    if (newStrategyMode) newStratRef.current?.focus();
  }, [newStrategyMode]);

  const handleUpdate = (patch: Partial<PositionAnnotation>) => {
    setFormData((prev) => ({ ...prev, ...patch }));
  };

  const toggleSection = (key: keyof typeof expanded) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // ── Merged strategy/playbook dropdown ──────────────────────────────────────

  const mergedValue = formData.playbookId
    ? `p:${formData.playbookId}`
    : formData.strategyId
    ? `s:${formData.strategyId}`
    : '';

  const handleMergedChange = (val: string) => {
    if (val === '__new__') {
      setNewStrategyMode(true);
      return;
    }
    if (val === '') {
      handleUpdate({ strategyId: null, playbookId: null });
    } else if (val.startsWith('s:')) {
      handleUpdate({ strategyId: val.slice(2), playbookId: null });
    } else if (val.startsWith('p:')) {
      handleUpdate({ strategyId: null, playbookId: val.slice(2) });
    }
  };

  const handleCreateStrategy = async () => {
    if (!newStrategyName.trim()) return;
    setCreatingStrategy(true);
    try {
      const res = await authFetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newStrategyName.trim() }),
      });
      const data = await res.json();
      if (data.strategy) {
        setStrategies((prev) => [...prev, data.strategy].sort((a, b) => a.name.localeCompare(b.name)));
        handleUpdate({ strategyId: data.strategy.id, playbookId: null });
        setNewStrategyMode(false);
        setNewStrategyName('');
      }
    } catch {}
    setCreatingStrategy(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
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
        confirmation: formData.confirmation || null,
      };

      await authFetch(`/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      const strategyName = strategies.find((s) => s.id === formData.strategyId)?.name;
      const playbookName = playbooks.find((p) => p.id === formData.playbookId)?.name;
      const msg = playbookName
        ? `Noted — checked against ${playbookName}`
        : strategyName
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
  const convictionLabels = ['Low', 'Med', 'High'];

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

          {/* ── REFLECT (always open) ── */}
          <SectionWrapper label="Reflect" expanded={expanded.reflect} onToggle={() => toggleSection('reflect')}>
            <div className="space-y-3 mt-2">
              {/* Thesis — large textarea, first */}
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Thesis
                </label>
                <textarea
                  value={formData.thesis}
                  onChange={(e) => handleUpdate({ thesis: e.target.value })}
                  rows={4}
                  placeholder="Why did you take this trade?"
                  className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-2 focus:outline-none focus:border-blue-500 placeholder-[#6e7681] resize-none"
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
                        onClick={() => handleUpdate({ conviction: active ? null : value })}
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
                        onClick={() => handleUpdate({ emotion: active ? null : emotion })}
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
                          handleUpdate({ mistakes: next });
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
            </div>
          </SectionWrapper>

          {/* ── MY PLAN (collapsed, auto-opens when playbook picked) ── */}
          <SectionWrapper label="My Plan" expanded={expanded.myplan} onToggle={() => toggleSection('myplan')}>
            <div className="space-y-3 mt-2">
              {/* Strategy / Playbook merged dropdown */}
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Strategy / Playbook
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
                      ✕
                    </button>
                  </div>
                ) : (
                  <select
                    value={mergedValue}
                    onChange={(e) => handleMergedChange(e.target.value)}
                    className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— None —</option>
                    <optgroup label="Strategies">
                      {strategies.map((s) => (
                        <option key={s.id} value={`s:${s.id}`}>{s.name}</option>
                      ))}
                      <option value="__new__">+ New Strategy</option>
                    </optgroup>
                    {playbooks.length > 0 && (
                      <optgroup label="Playbooks">
                        {playbooks.map((p) => (
                          <option key={p.id} value={`p:${p.id}`}>
                            📘 {p.name} ({getRuleCount(p.rules)} rules)
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}

                {/* Adherence preview */}
                {adherenceLoading && (
                  <div className="text-[10px] text-[#6e7681] mt-1.5">Scoring adherence…</div>
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

              {/* Confirmation */}
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Confirmation
                </label>
                <input
                  type="text"
                  value={formData.confirmation}
                  onChange={(e) => handleUpdate({ confirmation: e.target.value })}
                  placeholder="What confirmed the entry?"
                  className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 placeholder-[#6e7681]"
                />
              </div>

              {/* Planned Stop */}
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Planned Stop
                </label>
                <input
                  type="number"
                  value={formData.invalidationPrice}
                  onChange={(e) => handleUpdate({ invalidationPrice: e.target.value })}
                  placeholder={
                    position.averageEntryPrice != null
                      ? `e.g. near ${fmtPrice(position.averageEntryPrice)}`
                      : 'Price where thesis is wrong'
                  }
                  className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 placeholder-[#6e7681]"
                />
              </div>

              {/* Planned Target */}
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Planned Target
                </label>
                <input
                  type="number"
                  value={formData.targetPrice}
                  onChange={(e) => handleUpdate({ targetPrice: e.target.value })}
                  placeholder="Price target"
                  className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 placeholder-[#6e7681]"
                />
              </div>
            </div>
          </SectionWrapper>

          {/* ── SOURCE & NOTES (collapsed) ── */}
          <SectionWrapper label="Source & Notes" expanded={expanded.source} onToggle={() => toggleSection('source')}>
            <div className="space-y-3 mt-2">
              {/* Source / Caller */}
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Source / Caller
                </label>
                <select
                  value={formData.sourceTag}
                  onChange={(e) => handleUpdate({ sourceTag: e.target.value })}
                  className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                >
                  <option value="">— None —</option>
                  <option value="Manual">Manual</option>
                  {sourceTags.filter((t) => t !== 'Manual').map((tag) => (
                    <option key={tag} value={tag}>{tag}</option>
                  ))}
                </select>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
                  Notes
                </label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => handleUpdate({ notes: e.target.value })}
                  rows={3}
                  placeholder="Additional notes…"
                  className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-2 focus:outline-none focus:border-blue-500 placeholder-[#6e7681] resize-none"
                />
              </div>
            </div>
          </SectionWrapper>

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
