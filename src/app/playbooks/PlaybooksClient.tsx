'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import { RULE_TYPES } from '@/services/playbooks/rule-type-descriptors';
import { PLAYBOOK_TEMPLATES } from '@/services/playbooks/templates';
import type { PlaybookRule } from '@/services/playbooks/types';
import type { PlaybookTemplate } from '@/services/playbooks/templates';
import { useBooba } from '@/app/components/booba/BoobaContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Playbook {
  id: string;
  name: string;
  description: string | null;
  rules: string;
  totalChecks: number;
  avgAdherence: number | null;
  createdAt: string;
  updatedAt: string;
}

interface StrategyStats {
  strategyId: string;
  name: string;
  tradeCount: number;
  winRate: number | null;
  expectancy: number | null;
}

interface PlaybookAnalytics {
  sampleSize: number;
  overall: { count: number; winRate: number | null; avgPnl: number | null } | null;
  highAdherence: { count: number; winRate: number | null; avgPnl: number | null } | null;
  lowAdherence: { count: number; winRate: number | null; avgPnl: number | null } | null;
  costOfDeviation: number | null;
  notEnoughData: boolean;
  enoughDataThreshold: number;
}

// ── Rule category definitions (Part 3) ────────────────────────────────────────

const RULE_CATEGORIES = [
  {
    id: 'entry',
    label: 'Entry Conditions',
    description: 'What conditions must be true to take a trade?',
    icon: '📊',
    types: ['direction', 'asset', 'regime', 'entry_near_ema'] as string[],
  },
  {
    id: 'risk',
    label: 'Risk Management',
    description: 'How do you protect your capital?',
    icon: '⚙️',
    types: ['stop_distance', 'position_size', 'min_risk_reward'] as string[],
  },
  {
    id: 'discipline',
    label: 'Trading Discipline',
    description: 'What behavioral boundaries do you set?',
    icon: '🧠',
    types: ['time_of_day', 'max_daily_trades'] as string[],
  },
];

// ── Regime options with BTC 1h qualifier (Part 4) ────────────────────────────

const REGIME_OPTIONS = [
  { value: 'trending_low_vol',  label: 'Trending (BTC 1h)' },
  { value: 'trending_high_vol', label: 'Trending HV (BTC 1h)' },
  { value: 'ranging_low_vol',   label: 'Ranging (BTC 1h)' },
  { value: 'ranging_high_vol',  label: 'Ranging HV (BTC 1h)' },
  { value: 'transitional',      label: 'Transitional (BTC 1h)' },
];

const TIMEFRAME_OPTIONS = ['15m', '1h', '4h', '1d'];

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPct(v: number | null) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

function fmtExp(v: number | null) {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PlaybooksClient() {
  const authFetch = useAuthFetch();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [strategyStats, setStrategyStats] = useState<StrategyStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Playbook | null>(null);
  const [assetList, setAssetList] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'playbooks' | 'templates'>('playbooks');
  const [showForm, setShowForm] = useState(false);
  const [prefillName, setPrefillName] = useState('');
  const [templateToUse, setTemplateToUse] = useState<PlaybookTemplate | null>(null);

  const { openChat: openBoobaChat } = useBooba();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pbRes, posRes, statsRes] = await Promise.all([
        authFetch('/api/playbooks').then((r) => r.json()),
        authFetch('/api/positions?pageSize=1').then((r) => r.json()).catch(() => ({})),
        authFetch('/api/strategies/stats').then((r) => r.json()).catch(() => ({ stats: [] })),
      ]);
      setPlaybooks(pbRes.playbooks ?? []);
      setStrategyStats(statsRes.stats ?? []);
      const assets =
        Array.isArray(posRes.knownAssets) && posRes.knownAssets.length > 0
          ? posRes.knownAssets
          : ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'ARB', 'OP'];
      setAssetList(assets);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this playbook? Positions tagged with it will be un-tagged.')) return;
    await authFetch(`/api/playbooks/${id}`, { method: 'DELETE' });
    await load();
  }, [authFetch, load]);

  const openCreateForm = (name = '', template: PlaybookTemplate | null = null) => {
    setEditing(null);
    setPrefillName(name);
    setTemplateToUse(template);
    setShowForm(true);
    setActiveTab('playbooks');
  };

  const openEditForm = (pb: Playbook) => {
    setEditing(pb);
    setPrefillName('');
    setTemplateToUse(null);
    setShowForm(true);
    setActiveTab('playbooks');
  };

  const closeForm = () => {
    setEditing(null);
    setPrefillName('');
    setTemplateToUse(null);
    setShowForm(false);
  };

  const handleFormSaved = async () => {
    closeForm();
    await load();
  };

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6">
      {/* ── Header (Part 1) ─────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Strategies & Playbooks</h1>
        <p className="text-sm text-[#8b949e]">
          Track your strategies and define structured rules. Booba auto-checks every tagged trade
          against your playbook.
        </p>
      </div>

      {/* ── Section A: Your Strategies (Part 1) ─────────────────────────── */}
      {!loading && strategyStats.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">Your Strategies</h2>
          <div className="bg-[#161b22] border border-[#21262d] rounded-lg divide-y divide-[#21262d]">
            {strategyStats.map((s) => (
              <div key={s.strategyId} className="flex items-center justify-between px-4 py-3 gap-4 hover:bg-[#1c2128] transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{s.name}</div>
                </div>
                <div className="flex items-center gap-6 text-xs tabular-nums shrink-0">
                  <div className="text-center">
                    <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Trades</div>
                    <div className="text-white font-semibold">{s.tradeCount}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Win Rate</div>
                    <div className={`font-semibold ${s.winRate == null ? 'text-[#6e7681]' : s.winRate >= 0.5 ? 'text-green-400' : 'text-red-400'}`}>
                      {fmtPct(s.winRate)}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Exp/Trade</div>
                    <div className={`font-semibold ${s.expectancy == null ? 'text-[#6e7681]' : s.expectancy >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {fmtExp(s.expectancy)}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => openCreateForm(s.name)}
                  className="text-xs text-[#8b949e] hover:text-blue-400 transition-colors shrink-0 px-2 py-1 rounded border border-[#30363d] hover:border-blue-500/50"
                  title="Create a playbook pre-filled with this strategy name"
                >
                  ↑ Upgrade to playbook
                </button>
              </div>
            ))}
            <div className="px-4 py-2.5">
              <button
                onClick={() => openCreateForm()}
                className="text-xs text-[#6e7681] hover:text-white transition-colors"
              >
                + Create strategy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tabs: My Playbooks | Templates ──────────────────────────────── */}
      <div className="flex gap-1 mb-5 border-b border-[#21262d]">
        <button
          onClick={() => { setActiveTab('playbooks'); }}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === 'playbooks'
              ? 'border-blue-500 text-white'
              : 'border-transparent text-[#8b949e] hover:text-white'
          }`}
        >
          My Playbooks{playbooks.length > 0 ? ` (${playbooks.length})` : ''}
        </button>
        <button
          onClick={() => { setActiveTab('templates'); setShowForm(false); }}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === 'templates'
              ? 'border-blue-500 text-white'
              : 'border-transparent text-[#8b949e] hover:text-white'
          }`}
        >
          Templates
        </button>
      </div>

      {/* ── My Playbooks tab ────────────────────────────────────────────── */}
      {activeTab === 'playbooks' && (
        <div>
          {/* Form (create / edit) */}
          {showForm ? (
            <div>
              <h2 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">
                {editing ? `Edit "${editing.name}"` : 'Create New Playbook'}
              </h2>
              <PlaybookForm
                key={editing?.id ?? `new-${prefillName}-${templateToUse?.id ?? ''}`}
                existing={editing}
                templateToUse={templateToUse}
                prefillName={prefillName}
                assetList={assetList}
                onSaved={handleFormSaved}
                onCancel={closeForm}
              />
            </div>
          ) : loading ? (
            <div className="text-sm text-[#6e7681]">Loading…</div>
          ) : playbooks.length === 0 ? (
            /* Part 6: Onboarding for new users */
            <OnboardingGuide
              onCreateFromScratch={() => openCreateForm()}
              onBrowseTemplates={() => setActiveTab('templates')}
              onAskBooba={() => openBoobaChat('Help me create a playbook for my trading strategy.')}
            />
          ) : (
            /* Section B: Your Playbooks (Part 1) */
            <div>
              <h2 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">Your Playbooks</h2>
              <div className="space-y-3 mb-5">
                {playbooks.map((pb) => (
                  <PlaybookCard
                    key={pb.id}
                    playbook={pb}
                    onEdit={() => openEditForm(pb)}
                    onDelete={() => handleDelete(pb.id)}
                  />
                ))}
              </div>
              <button
                onClick={() => openCreateForm()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
              >
                + Create New Playbook
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Templates tab (Part 2) ───────────────────────────────────────── */}
      {activeTab === 'templates' && (
        <TemplatesSection onUseTemplate={(t) => openCreateForm(t.name, t)} />
      )}

    </div>
  );
}

// ── Onboarding guide (Part 6) ─────────────────────────────────────────────────

function OnboardingGuide({
  onCreateFromScratch,
  onBrowseTemplates,
  onAskBooba,
}: {
  onCreateFromScratch: () => void;
  onBrowseTemplates: () => void;
  onAskBooba: () => void;
}) {
  return (
    <div className="bg-[#161b22] border border-dashed border-[#30363d] rounded-xl px-6 py-8 text-center">
      <div className="text-base font-semibold text-white mb-2">Define Your Trading Rules</div>
      <p className="text-sm text-[#8b949e] max-w-md mx-auto mb-6">
        Playbooks are structured strategies with rules that Booba auto-checks on every trade.
        Define your entry conditions, risk management, and discipline rules — then see if
        following them actually improves your results.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={onBrowseTemplates}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
        >
          Browse Templates
        </button>
        <span className="text-[#6e7681] text-sm">or</span>
        <button
          onClick={onCreateFromScratch}
          className="px-4 py-2 border border-[#30363d] hover:border-[#6e7681] text-[#e6edf3] text-sm rounded transition-colors"
        >
          Create from Scratch
        </button>
        <span className="text-[#6e7681] text-sm">or</span>
        <button
          onClick={onAskBooba}
          className="px-4 py-2 border border-[#30363d] hover:border-purple-500/60 text-[#e6edf3] text-sm rounded transition-colors"
        >
          Ask Booba to help
        </button>
      </div>
    </div>
  );
}

// ── Playbook Card with inline analytics (Part 1 — Section B) ─────────────────

function PlaybookCard({
  playbook,
  onEdit,
  onDelete,
}: {
  playbook: Playbook;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const authFetch = useAuthFetch();
  const [analytics, setAnalytics] = useState<PlaybookAnalytics | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/playbooks/${playbook.id}/analytics`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setAnalytics(d.analytics ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [playbook.id, authFetch]);

  let ruleCount = 0;
  try { ruleCount = JSON.parse(playbook.rules).length; } catch {}

  const adherence = playbook.avgAdherence;
  const adherenceColor =
    adherence == null ? 'text-[#6e7681]' :
    adherence >= 80 ? 'text-green-400' :
    adherence >= 50 ? 'text-amber-400' : 'text-red-400';

  const hi = analytics?.highAdherence;
  const lo = analytics?.lowAdherence;
  const overall = analytics?.overall;
  const hasAnalytics = analytics && !analytics.notEnoughData;

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">
            📘 {playbook.name} ({ruleCount} rules)
          </div>
          {playbook.description && (
            <div className="text-xs text-[#8b949e] mt-0.5 line-clamp-1">{playbook.description}</div>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={onEdit}
            className="px-2 py-1 text-xs rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-white hover:border-blue-500/50 transition-colors"
          >
            Edit
          </button>
          <a
            href="/analytics"
            className="px-2 py-1 text-xs rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-white hover:border-[#6e7681] transition-colors"
          >
            View Analytics
          </a>
          <button
            onClick={onDelete}
            className="px-2 py-1 text-xs rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-red-400 hover:border-red-500/50 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-[#8b949e]">
        <span>
          <span className="text-white font-semibold">{analytics?.sampleSize ?? playbook.totalChecks}</span> trades
        </span>
        {hasAnalytics && overall?.winRate != null && (
          <span>
            <span className={`font-semibold ${overall.winRate >= 0.5 ? 'text-green-400' : 'text-red-400'}`}>
              {(overall.winRate * 100).toFixed(0)}%
            </span> WR
          </span>
        )}
        {hasAnalytics && overall?.avgPnl != null && (
          <span>
            <span className={`font-semibold ${overall.avgPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {fmtExp(overall.avgPnl)}
            </span> exp
          </span>
        )}
        <span>
          Adherence:{' '}
          <span className={`font-semibold ${adherenceColor}`}>
            {adherence == null ? '—' : `${adherence.toFixed(0)}%`}
          </span>
        </span>
      </div>

      {/* Following vs breaking (key metric) */}
      {hasAnalytics && (hi?.count ?? 0) > 0 && (lo?.count ?? 0) > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-[#21262d] space-y-1">
          <div className="flex gap-4 text-xs">
            <span>
              Following rules:{' '}
              <span className="text-green-400 font-semibold">{fmtPct(hi?.winRate ?? null)} WR</span>
            </span>
            <span>
              Breaking rules:{' '}
              <span className="text-red-400 font-semibold">{fmtPct(lo?.winRate ?? null)} WR</span>
            </span>
          </div>
          {analytics!.costOfDeviation != null && analytics!.costOfDeviation > 0 && (
            <div className="text-xs text-[#8b949e]">
              Estimated value of following rules:{' '}
              <span className="text-white font-semibold">+${analytics!.costOfDeviation.toFixed(0)}</span>
            </div>
          )}
        </div>
      )}

      {analytics?.notEnoughData && (
        <div className="mt-2 text-xs text-[#6e7681] italic">
          Need at least {analytics.enoughDataThreshold} scored trades for analytics —
          {' '}{analytics.sampleSize} so far.
        </div>
      )}
    </div>
  );
}

// ── Templates Section (Part 2) ────────────────────────────────────────────────

function TemplatesSection({ onUseTemplate }: { onUseTemplate: (t: PlaybookTemplate) => void }) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xs uppercase tracking-widest text-[#6e7681] mb-1">
          Templates — Start with a proven framework
        </h2>
        <p className="text-xs text-[#6e7681]">
          Each template uses our existing rule checkers. Customize any rules before saving.
        </p>
      </div>
      <div className="space-y-3">
        {PLAYBOOK_TEMPLATES.map((t) => (
          <TemplateCard key={t.id} template={t} onUse={() => onUseTemplate(t)} />
        ))}
      </div>
    </div>
  );
}

function TemplateCard({ template, onUse }: { template: PlaybookTemplate; onUse: () => void }) {
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-white mb-1">📋 {template.name}</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-0.5 text-xs">
          <div>
            <span className="text-[#6e7681]">Entry: </span>
            <span className="text-[#8b949e]">{template.entryConditions}</span>
          </div>
          <div>
            <span className="text-[#6e7681]">Risk: </span>
            <span className="text-[#8b949e]">{template.riskManagement}</span>
          </div>
          <div>
            <span className="text-[#6e7681]">Discipline: </span>
            <span className="text-[#8b949e]">{template.discipline}</span>
          </div>
        </div>
      </div>
      <button
        onClick={onUse}
        className="shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-colors"
      >
        Use Template
      </button>
    </div>
  );
}

// ── Playbook Form (Create + Edit) with categorized rules (Part 3) ─────────────

function PlaybookForm({
  existing,
  templateToUse,
  prefillName,
  assetList,
  onSaved,
  onCancel,
}: {
  existing: Playbook | null;
  templateToUse: PlaybookTemplate | null;
  prefillName: string;
  assetList: string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const authFetch = useAuthFetch();

  const [name, setName] = useState(() => {
    if (existing) return existing.name;
    if (templateToUse) return templateToUse.name;
    return prefillName;
  });
  const [description, setDescription] = useState(existing?.description ?? '');
  const [rules, setRules] = useState<PlaybookRule[]>(() => {
    if (existing) {
      try { return JSON.parse(existing.rules) as PlaybookRule[]; } catch { return []; }
    }
    if (templateToUse) return [...templateToUse.rules];
    return [];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Types already in the rules array (for disabling in dropdowns)
  const usedTypes = new Set(rules.map((r) => r.type));

  const handleAddRule = (type: string) => {
    if (!type || usedTypes.has(type)) return;
    const descriptor = RULE_TYPES.find((rt) => rt.type === type);
    if (!descriptor) return;
    setRules((prev) => [
      ...prev,
      {
        type,
        params: { ...descriptor.defaultParams },
        enabled: true,
        label: descriptor.defaultRuleLabel,
      },
    ]);
  };

  const updateRule = (index: number, patch: Partial<PlaybookRule>) => {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const updateParam = (index: number, key: string, value: unknown) => {
    setRules((prev) =>
      prev.map((r, i) =>
        i !== index ? r : { ...r, params: { ...r.params, [key]: value } },
      ),
    );
  };

  const removeRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) { setError('Name is required'); return; }
    if (rules.length === 0) { setError('Add at least one rule'); return; }

    setSaving(true);
    try {
      const body = JSON.stringify({
        name: name.trim(),
        description: description.trim() || null,
        rules,
      });
      const res = existing
        ? await authFetch(`/api/playbooks/${existing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        : await authFetch('/api/playbooks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? 'Save failed');
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4 space-y-4">
      {/* Name */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Trending Momentum"
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
          Description (optional)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="When does this playbook apply? What's the edge?"
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] placeholder-[#6e7681] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 resize-none"
        />
      </div>

      {/* Rules — categorized (Part 3) */}
      <div className="space-y-4">
        {RULE_CATEGORIES.map((cat) => {
          const catRules = rules
            .map((r, i) => ({ rule: r, index: i }))
            .filter(({ rule }) => cat.types.includes(rule.type));
          const availableTypes = cat.types.filter((t) => !usedTypes.has(t));

          return (
            <div key={cat.id} className="bg-[#0d1117] border border-[#30363d] rounded-lg overflow-hidden">
              {/* Category header */}
              <div className="px-3 py-2 border-b border-[#30363d] bg-[#161b22] flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <span>{cat.icon}</span>
                    <span>{cat.label}</span>
                  </div>
                  <div className="text-[10px] text-[#6e7681] mt-0.5">{cat.description}</div>
                </div>
                {/* + Add rule for this category */}
                <select
                  value=""
                  onChange={(e) => { handleAddRule(e.target.value); e.target.value = ''; }}
                  disabled={availableTypes.length === 0}
                  className="bg-[#0d1117] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500 disabled:opacity-40 shrink-0"
                >
                  <option value="">+ Add rule</option>
                  {cat.types.map((type) => {
                    const descriptor = RULE_TYPES.find((rt) => rt.type === type);
                    const alreadyAdded = usedTypes.has(type);
                    return (
                      <option key={type} value={type} disabled={alreadyAdded}>
                        {descriptor?.label ?? type}{alreadyAdded ? ' (added)' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Rules in this category */}
              <div className="p-2 space-y-2">
                {catRules.length === 0 ? (
                  <div className="text-xs text-[#6e7681] italic px-1 py-1">No rules yet.</div>
                ) : (
                  catRules.map(({ rule, index }) => (
                    <RuleRow
                      key={index}
                      index={index}
                      rule={rule}
                      assetList={assetList}
                      onUpdate={(patch) => updateRule(index, patch)}
                      onUpdateParam={(k, v) => updateParam(index, k, v)}
                      onRemove={() => removeRule(index)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Save / Cancel */}
      <div className="flex gap-2 justify-end pt-2 border-t border-[#21262d]">
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-1.5 text-sm text-[#8b949e] hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-400 text-white text-sm font-medium rounded transition-colors"
        >
          {saving ? 'Saving…' : existing ? 'Save Changes' : 'Create Playbook'}
        </button>
      </div>
    </div>
  );
}

// ── Single-rule row ───────────────────────────────────────────────────────────

function RuleRow({
  index,
  rule,
  assetList,
  onUpdate,
  onUpdateParam,
  onRemove,
}: {
  index: number;
  rule: PlaybookRule;
  assetList: string[];
  onUpdate: (patch: Partial<PlaybookRule>) => void;
  onUpdateParam: (key: string, value: unknown) => void;
  onRemove: () => void;
}) {
  const descriptor = RULE_TYPES.find((rt) => rt.type === rule.type);
  return (
    <div className={`bg-[#161b22] border border-[#21262d] rounded p-3 ${rule.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-2 mb-2">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            className="accent-blue-500"
          />
          <span className="text-[10px] uppercase tracking-widest text-[#6e7681]">Enabled</span>
        </label>
        <span className="text-xs font-semibold text-white ml-1">{descriptor?.label ?? rule.type}</span>
        <input
          type="text"
          value={rule.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="Rule label"
          className="flex-1 bg-[#0d1117] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={onRemove}
          className="text-[#8b949e] hover:text-red-400 text-base transition-colors leading-none"
          aria-label="Remove rule"
        >
          ×
        </button>
      </div>
      <RuleParams rule={rule} assetList={assetList} onUpdateParam={onUpdateParam} />
    </div>
  );
}

// ── Type-specific parameter inputs ────────────────────────────────────────────

function RuleParams({
  rule,
  assetList,
  onUpdateParam,
}: {
  rule: PlaybookRule;
  assetList: string[];
  onUpdateParam: (key: string, value: unknown) => void;
}) {
  const p = rule.params as Record<string, unknown>;

  switch (rule.type) {
    case 'direction':
      return (
        <div className="flex gap-2">
          {['LONG', 'SHORT'].map((d) => (
            <button
              key={d}
              onClick={() => onUpdateParam('direction', d)}
              className={`flex-1 py-1.5 text-xs rounded border transition-colors ${
                p.direction === d
                  ? d === 'LONG'
                    ? 'bg-green-900/40 border-green-500/50 text-green-400'
                    : 'bg-red-900/40 border-red-500/50 text-red-400'
                  : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:text-white'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      );

    case 'asset': {
      const selected = Array.isArray(p.assets) ? (p.assets as string[]) : [];
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {assetList.map((a) => {
              const active = selected.includes(a);
              return (
                <button
                  key={a}
                  onClick={() =>
                    onUpdateParam(
                      'assets',
                      active ? selected.filter((x) => x !== a) : [...selected, a],
                    )
                  }
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    active
                      ? 'bg-blue-900/40 border-blue-500/50 text-blue-300'
                      : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:text-white'
                  }`}
                >
                  {a}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder="Add custom asset (press Enter)"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const v = (e.target as HTMLInputElement).value.trim().toUpperCase();
              if (v && !selected.includes(v)) onUpdateParam('assets', [...selected, v]);
              (e.target as HTMLInputElement).value = '';
              e.preventDefault();
            }}
            className="w-full bg-[#0d1117] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
          />
        </div>
      );
    }

    case 'regime': {
      const selected = Array.isArray(p.regimes) ? (p.regimes as string[]) : [];
      return (
        <div className="space-y-2">
          {/* Part 4: tooltip explaining BTC 1h proxy */}
          <div
            className="text-[10px] text-[#6e7681] bg-[#0d1117] border border-[#21262d] rounded px-2 py-1.5 flex items-start gap-1.5"
            title="Market regime is determined from BTC 1-hour ADX/ATR analysis. This is a proxy for overall crypto market conditions."
          >
            <span className="text-blue-400 shrink-0">ℹ</span>
            <span>
              Regime is determined from BTC 1h ADX/ATR — a proxy for overall crypto market
              conditions. Hover for details.
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {REGIME_OPTIONS.map((r) => {
              const active = selected.includes(r.value);
              return (
                <button
                  key={r.value}
                  onClick={() =>
                    onUpdateParam(
                      'regimes',
                      active ? selected.filter((x) => x !== r.value) : [...selected, r.value],
                    )
                  }
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    active
                      ? 'bg-blue-900/40 border-blue-500/50 text-blue-300'
                      : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:text-white'
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    case 'time_of_day':
      return (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Start Hour (UTC)"
            value={p.startHour as number}
            min={0} max={23}
            onChange={(v) => onUpdateParam('startHour', v)}
          />
          <NumberField
            label="End Hour (UTC)"
            value={p.endHour as number}
            min={0} max={23}
            onChange={(v) => onUpdateParam('endHour', v)}
          />
        </div>
      );

    case 'max_daily_trades':
      return (
        <NumberField
          label="Max Trades per Day"
          value={p.maxTrades as number}
          min={1}
          onChange={(v) => onUpdateParam('maxTrades', v)}
        />
      );

    case 'stop_distance':
      return (
        <NumberField
          label="Max Stop Distance (%)"
          value={p.maxPercent as number}
          min={0.1} step={0.1}
          onChange={(v) => onUpdateParam('maxPercent', v)}
        />
      );

    case 'position_size':
      return (
        <NumberField
          label="Max Size (% of Equity)"
          value={p.maxPercentOfEquity as number}
          min={0.1} step={0.1}
          onChange={(v) => onUpdateParam('maxPercentOfEquity', v)}
        />
      );

    case 'min_risk_reward':
      return (
        <NumberField
          label="Minimum R:R Ratio"
          value={p.minRR as number}
          min={0.1} step={0.1}
          onChange={(v) => onUpdateParam('minRR', v)}
        />
      );

    case 'entry_near_ema':
      return (
        <div className="grid grid-cols-3 gap-2">
          <NumberField
            label="EMA Period"
            value={p.period as number}
            min={2}
            onChange={(v) => onUpdateParam('period', v)}
          />
          <NumberField
            label="Max Distance (%)"
            value={p.maxDistancePercent as number}
            min={0.1} step={0.1}
            onChange={(v) => onUpdateParam('maxDistancePercent', v)}
          />
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
              Timeframe
            </label>
            <select
              value={String(p.timeframe ?? '1h')}
              onChange={(e) => onUpdateParam('timeframe', e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
            >
              {TIMEFRAME_OPTIONS.map((tf) => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
          </div>
        </div>
      );

    default:
      return (
        <div className="text-xs text-[#6e7681] italic">
          No parameters for &quot;{rule.type}&quot;
        </div>
      );
  }
}

function NumberField({
  label, value, min, max, step = 1, onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">
        {label}
      </label>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-full bg-[#0d1117] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}
