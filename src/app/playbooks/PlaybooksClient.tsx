'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import { RULE_TYPES } from '@/services/playbooks/rule-checkers';
import type { PlaybookRule } from '@/services/playbooks/types';
import PlaybookAnalyticsCard from './PlaybookAnalyticsCard';

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

const REGIME_OPTIONS: { value: string; label: string }[] = [
  { value: 'trending_low_vol',  label: 'Trending' },
  { value: 'trending_high_vol', label: 'Trending HV' },
  { value: 'ranging_low_vol',   label: 'Ranging' },
  { value: 'ranging_high_vol',  label: 'Ranging HV' },
  { value: 'transitional',      label: 'Transitional' },
];

const TIMEFRAME_OPTIONS = ['15m', '1h', '4h', '1d'];

export default function PlaybooksClient() {
  const authFetch = useAuthFetch();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Playbook | null>(null);
  const [assetList, setAssetList] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pbRes, posRes] = await Promise.all([
        authFetch('/api/playbooks').then((r) => r.json()),
        authFetch('/api/positions?pageSize=1').then((r) => r.json()).catch(() => ({})),
      ]);
      setPlaybooks(pbRes.playbooks ?? []);
      // Fallback common assets list when we can't derive from user history
      const assets = Array.isArray(posRes.knownAssets) && posRes.knownAssets.length > 0
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

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Playbooks</h1>
        <p className="text-sm text-[#8b949e]">
          Define the rules of your strategy. Each trade you tag gets scored against them —
          objective adherence instead of guesswork about whether you followed your plan.
        </p>
      </div>

      {/* ── Existing Playbooks ───────────────────────────────────── */}
      <div className="mb-8">
        <h2 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">Your Playbooks</h2>
        {loading ? (
          <div className="text-sm text-[#6e7681]">Loading playbooks…</div>
        ) : playbooks.length === 0 ? (
          <div className="bg-[#161b22] border border-dashed border-[#30363d] rounded-lg px-4 py-6 text-sm text-[#8b949e]">
            No playbooks yet. Create one below to start scoring your adherence.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {playbooks.map((pb) => (
              <PlaybookCard
                key={pb.id}
                playbook={pb}
                onEdit={() => setEditing(pb)}
                onDelete={() => handleDelete(pb.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Create / Edit ────────────────────────────────────────── */}
      <div className="mb-8">
        <h2 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">
          {editing ? `Edit "${editing.name}"` : 'Create New Playbook'}
        </h2>
        <PlaybookForm
          key={editing?.id ?? 'new'}
          existing={editing}
          assetList={assetList}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
          onCancel={() => setEditing(null)}
        />
      </div>

      {/* ── Analytics ───────────────────────────────────────────── */}
      {playbooks.length > 0 && (
        <div>
          <h2 className="text-xs uppercase tracking-widest text-[#6e7681] mb-3">Adherence Analytics</h2>
          <div className="grid grid-cols-1 gap-3">
            {playbooks.map((pb) => (
              <PlaybookAnalyticsCard key={pb.id} playbookId={pb.id} playbookName={pb.name} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Playbook Card ─────────────────────────────────────────────────────────

function PlaybookCard({
  playbook,
  onEdit,
  onDelete,
}: {
  playbook: Playbook;
  onEdit: () => void;
  onDelete: () => void;
}) {
  let ruleCount = 0;
  try { ruleCount = JSON.parse(playbook.rules).length; } catch {}

  const score = playbook.avgAdherence;
  const scoreColor =
    score == null ? 'text-[#6e7681]' :
    score >= 80 ? 'text-green-400' :
    score >= 50 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">{playbook.name}</div>
          {playbook.description && (
            <div className="text-xs text-[#8b949e] mt-0.5 line-clamp-2">{playbook.description}</div>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button onClick={onEdit}
            className="px-2 py-1 text-xs rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-white hover:border-blue-500/50 transition-colors">
            Edit
          </button>
          <button onClick={onDelete}
            className="px-2 py-1 text-xs rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:text-red-400 hover:border-red-500/50 transition-colors">
            Delete
          </button>
        </div>
      </div>
      <div className="flex items-center gap-4 mt-3 pt-3 border-t border-[#21262d]">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Rules</div>
          <div className="text-sm font-semibold text-white">{ruleCount}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Trades Scored</div>
          <div className="text-sm font-semibold text-white">{playbook.totalChecks}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-[#6e7681]">Avg Adherence</div>
          <div className={`text-sm font-semibold tabular-nums ${scoreColor}`}>
            {score == null ? '—' : `${score.toFixed(1)}%`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Playbook Form (Create + Edit) ─────────────────────────────────────────

function PlaybookForm({
  existing,
  assetList,
  onSaved,
  onCancel,
}: {
  existing: Playbook | null;
  assetList: string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const authFetch = useAuthFetch();
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [rules, setRules] = useState<PlaybookRule[]>(() => {
    if (!existing) return [];
    try { return JSON.parse(existing.rules) as PlaybookRule[]; } catch { return []; }
  });
  const [addType, setAddType] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddRule = (type: string) => {
    if (!type) return;
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
    setAddType('');
  };

  const updateRule = (index: number, patch: Partial<PlaybookRule>) => {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const updateParam = (index: number, key: string, value: unknown) => {
    setRules((prev) => prev.map((r, i) => {
      if (i !== index) return r;
      return { ...r, params: { ...r.params, [key]: value } };
    }));
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
        setError(data.error ?? 'Save failed');
        return;
      }
      if (!existing) {
        setName(''); setDescription(''); setRules([]);
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
        <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">Description (optional)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="When does this playbook apply? What's the edge?"
          className="w-full bg-[#0d1117] border border-[#30363d] text-sm text-[#e6edf3] placeholder-[#6e7681] rounded px-3 py-1.5 focus:outline-none focus:border-blue-500 resize-none"
        />
      </div>

      {/* Rules */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] uppercase tracking-widest text-[#6e7681]">Rules</label>
          <div className="flex items-center gap-2">
            <select
              value={addType}
              onChange={(e) => handleAddRule(e.target.value)}
              className="bg-[#0d1117] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            >
              <option value="">+ Add Rule</option>
              {RULE_TYPES.map((rt) => (
                <option key={rt.type} value={rt.type}>{rt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {rules.length === 0 ? (
          <div className="text-xs text-[#6e7681] italic py-2">No rules yet. Add one above.</div>
        ) : (
          <div className="space-y-2">
            {rules.map((rule, i) => (
              <RuleRow
                key={i}
                index={i}
                rule={rule}
                assetList={assetList}
                onUpdate={(patch) => updateRule(i, patch)}
                onUpdateParam={(k, v) => updateParam(i, k, v)}
                onRemove={() => removeRule(i)}
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Save / Cancel */}
      <div className="flex gap-2 justify-end pt-2 border-t border-[#21262d]">
        {existing && (
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-1.5 text-sm text-[#8b949e] hover:text-white transition-colors"
          >
            Cancel
          </button>
        )}
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

// ── Single-rule row with type-specific param inputs ───────────────────────

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
    <div className={`bg-[#0d1117] border border-[#30363d] rounded-lg p-3 ${rule.enabled ? '' : 'opacity-60'}`}>
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
        <span className="text-xs font-semibold text-white ml-2">{descriptor?.label ?? rule.type}</span>
        <input
          type="text"
          value={rule.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="Rule label"
          className="flex-1 bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={onRemove}
          className="text-[#8b949e] hover:text-red-400 text-sm transition-colors"
          aria-label="Remove rule"
        >×</button>
      </div>

      <RuleParams rule={rule} assetList={assetList} onUpdateParam={onUpdateParam} />
    </div>
  );
}

// ── Type-specific parameter inputs ────────────────────────────────────────

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
                  ? d === 'LONG' ? 'bg-green-900/40 border-green-500/50 text-green-400' : 'bg-red-900/40 border-red-500/50 text-red-400'
                  : 'bg-[#161b22] border-[#30363d] text-[#8b949e] hover:text-white'
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
                  onClick={() => onUpdateParam('assets', active ? selected.filter((x) => x !== a) : [...selected, a])}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    active
                      ? 'bg-blue-900/40 border-blue-500/50 text-blue-300'
                      : 'bg-[#161b22] border-[#30363d] text-[#8b949e] hover:text-white'
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
            className="w-full bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
          />
        </div>
      );
    }

    case 'regime': {
      const selected = Array.isArray(p.regimes) ? (p.regimes as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {REGIME_OPTIONS.map((r) => {
            const active = selected.includes(r.value);
            return (
              <button
                key={r.value}
                onClick={() => onUpdateParam('regimes', active ? selected.filter((x) => x !== r.value) : [...selected, r.value])}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  active
                    ? 'bg-blue-900/40 border-blue-500/50 text-blue-300'
                    : 'bg-[#161b22] border-[#30363d] text-[#8b949e] hover:text-white'
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      );
    }

    case 'time_of_day':
      return (
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Start Hour (UTC)" value={p.startHour as number} min={0} max={23} onChange={(v) => onUpdateParam('startHour', v)} />
          <NumberField label="End Hour (UTC)"   value={p.endHour   as number} min={0} max={23} onChange={(v) => onUpdateParam('endHour', v)} />
        </div>
      );

    case 'max_daily_trades':
      return <NumberField label="Max Trades per Day" value={p.maxTrades as number} min={1} onChange={(v) => onUpdateParam('maxTrades', v)} />;

    case 'stop_distance':
      return <NumberField label="Max Stop Distance (%)" value={p.maxPercent as number} min={0.1} step={0.1} onChange={(v) => onUpdateParam('maxPercent', v)} />;

    case 'position_size':
      return <NumberField label="Max Size (% of Equity)" value={p.maxPercentOfEquity as number} min={0.1} step={0.1} onChange={(v) => onUpdateParam('maxPercentOfEquity', v)} />;

    case 'min_risk_reward':
      return <NumberField label="Minimum R:R Ratio" value={p.minRR as number} min={0.1} step={0.1} onChange={(v) => onUpdateParam('minRR', v)} />;

    case 'entry_near_ema':
      return (
        <div className="grid grid-cols-3 gap-2">
          <NumberField label="EMA Period" value={p.period as number} min={2} onChange={(v) => onUpdateParam('period', v)} />
          <NumberField label="Max Distance (%)" value={p.maxDistancePercent as number} min={0.1} step={0.1} onChange={(v) => onUpdateParam('maxDistancePercent', v)} />
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">Timeframe</label>
            <select
              value={String(p.timeframe ?? '1h')}
              onChange={(e) => onUpdateParam('timeframe', e.target.value)}
              className="w-full bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
            >
              {TIMEFRAME_OPTIONS.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </div>
        </div>
      );

    default:
      return <div className="text-xs text-[#6e7681] italic">No parameters for "{rule.type}"</div>;
  }
}

function NumberField({
  label, value, min, max, step = 1, onChange,
}: {
  label: string; value: number; min?: number; max?: number; step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-widest text-[#6e7681] mb-1">{label}</label>
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
        className="w-full bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] rounded px-2 py-1 focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}
