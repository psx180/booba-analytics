'use client';

/**
 * ManageJournalsModal — list / create / rename / delete / bulk-assign for
 * journals on the active wallet. Opened from the JournalSelector dropdown.
 *
 * The modal has two views:
 *   1. List view (default): every journal with rename, delete, and assign
 *      controls inline. A "Create New Journal" button at the top adds rows.
 *   2. Assign view: per-journal popover that lets the user pick a filter
 *      dimension (asset / trade type / regime / subaccount / date range)
 *      and post to /api/journals/:id/assign in one click.
 *
 * Every mutation calls refresh() on the JournalContext so the dropdown
 * updates immediately and downstream consumers see the new state.
 */

import { useState, useEffect } from 'react';
import { useJournal } from './JournalContext';

const REGIMES = [
  { value: 'trending_low_vol',  label: 'Trending' },
  { value: 'trending_high_vol', label: 'Trending HV' },
  { value: 'ranging_low_vol',   label: 'Ranging' },
  { value: 'ranging_high_vol',  label: 'Ranging HV' },
  { value: 'transitional',      label: 'Transitional' },
];

const TRADE_TYPES = [
  'scalp', 'directional', 'scaled_directional', 'carry_trade',
  'market_making', 'delta_neutral', 'pairs_trade', 'basis_trade',
];

interface AssignFilter {
  asset?: string;
  subaccount?: string;
  tradeType?: string;
  regime?: string;
  dateFrom?: string;
  dateTo?: string;
}

export default function ManageJournalsModal({ onClose }: { onClose: () => void }) {
  const { walletAddress, journals, refresh, setJournalId } = useJournal();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const resetMessages = () => {
    setError(null);
    setInfo(null);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setWorking(true);
    resetMessages();
    try {
      const res = await fetch('/api/journals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          name: newName.trim(),
          description: newDescription.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? 'Create failed');
      }
      const data = await res.json();
      setNewName('');
      setNewDescription('');
      setCreating(false);
      await refresh();
      // Auto-switch into the journal we just created — most users want to
      // start populating it immediately.
      if (data?.journal?.id) setJournalId(data.journal.id);
      setInfo('Journal created.');
    } catch (e: any) {
      setError(e?.message ?? 'Create failed');
    } finally {
      setWorking(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    setWorking(true);
    resetMessages();
    try {
      const res = await fetch(`/api/journals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? 'Rename failed');
      }
      setEditingId(null);
      await refresh();
      setInfo('Journal renamed.');
    } catch (e: any) {
      setError(e?.message ?? 'Rename failed');
    } finally {
      setWorking(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete journal "${name}"? Its positions will move to the default journal.`)) return;
    setWorking(true);
    resetMessages();
    try {
      const res = await fetch(`/api/journals/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? 'Delete failed');
      }
      await refresh();
      setInfo('Journal deleted.');
    } catch (e: any) {
      setError(e?.message ?? 'Delete failed');
    } finally {
      setWorking(false);
    }
  };

  const handleAssign = async (id: string, filter: AssignFilter) => {
    setWorking(true);
    resetMessages();
    try {
      const res = await fetch(`/api/journals/${id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? 'Assign failed');
      }
      const data = await res.json();
      setAssignFor(null);
      await refresh();
      setInfo(`Assigned ${data.assigned} position${data.assigned === 1 ? '' : 's'}.`);
    } catch (e: any) {
      setError(e?.message ?? 'Assign failed');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#21262d] flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-white">Manage Journals</h3>
            <p className="text-xs text-[#6e7681] mt-0.5">
              Each journal has its own equity curve, insights, and analytics.
            </p>
          </div>
          <button onClick={onClose} className="text-[#6e7681] hover:text-white text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Status banner */}
          {(error || info) && (
            <div
              className={`text-xs px-3 py-2 rounded ${
                error
                  ? 'bg-red-900/20 border border-red-500/30 text-red-300'
                  : 'bg-emerald-900/20 border border-emerald-500/30 text-emerald-300'
              }`}
            >
              {error ?? info}
            </div>
          )}

          {/* Create row */}
          {creating ? (
            <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-3 space-y-2">
              <div className="flex flex-col gap-2">
                <input
                  autoFocus
                  type="text"
                  placeholder="Journal name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                />
                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  className="bg-[#0d1117] border border-[#30363d] rounded px-2 py-1.5 text-xs text-[#e6edf3] focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setCreating(false);
                    setNewName('');
                    setNewDescription('');
                  }}
                  disabled={working}
                  className="px-3 py-1 text-xs text-[#8b949e] hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={working || !newName.trim()}
                  className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                resetMessages();
                setCreating(true);
              }}
              className="w-full text-xs text-[#8b949e] hover:text-white border border-dashed border-[#30363d] rounded-lg py-2 hover:border-[#484f58] transition-colors"
            >
              + Create New Journal
            </button>
          )}

          {/* Journal list */}
          <div className="space-y-2">
            {journals.map((j) => (
              <div
                key={j.id}
                className="bg-[#161b22] border border-[#21262d] rounded-lg p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {editingId === j.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        autoFocus
                        className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white truncate">{j.name}</span>
                        {j.isDefault && (
                          <span className="text-[9px] uppercase tracking-widest text-[#6e7681]">
                            default
                          </span>
                        )}
                      </div>
                    )}
                    {j.description && editingId !== j.id && (
                      <p className="text-xs text-[#6e7681] mt-0.5 truncate">{j.description}</p>
                    )}
                    <p className="text-[10px] text-[#6e7681] mt-1">
                      {j.positionCount} position{j.positionCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {editingId === j.id ? (
                      <>
                        <button
                          onClick={() => handleRename(j.id)}
                          disabled={working}
                          className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-2 py-1 text-xs text-[#8b949e] hover:text-white"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {!j.isDefault && (
                          <button
                            onClick={() => {
                              resetMessages();
                              setAssignFor(assignFor === j.id ? null : j.id);
                            }}
                            className="px-2 py-1 text-xs text-[#8b949e] hover:text-white border border-[#30363d] rounded"
                          >
                            Assign Trades
                          </button>
                        )}
                        <button
                          onClick={() => {
                            resetMessages();
                            setEditingId(j.id);
                            setEditName(j.name);
                          }}
                          className="px-2 py-1 text-xs text-[#8b949e] hover:text-white border border-[#30363d] rounded"
                        >
                          Rename
                        </button>
                        {!j.isDefault && (
                          <button
                            onClick={() => handleDelete(j.id, j.name)}
                            disabled={working}
                            className="px-2 py-1 text-xs text-red-400 hover:text-red-300 border border-[#30363d] rounded disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Assign sub-form */}
                {assignFor === j.id && (
                  <AssignTradesForm
                    walletAddress={walletAddress}
                    onCancel={() => setAssignFor(null)}
                    onSubmit={(f) => handleAssign(j.id, f)}
                    working={working}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#21262d] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[#e6edf3] bg-[#21262d] border border-[#30363d] rounded hover:bg-[#30363d] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Assign Trades Form ──────────────────────────────────────────────────────

interface FilterOptions {
  assets: string[];
  tradeTypes: string[];
  regimes: string[];
  subaccounts: string[];
}

function AssignTradesForm({
  walletAddress,
  onCancel,
  onSubmit,
  working,
}: {
  walletAddress: string;
  onCancel: () => void;
  onSubmit: (filter: AssignFilter) => void;
  working: boolean;
}) {
  const [asset, setAsset] = useState('');
  const [subaccount, setSubaccount] = useState('');
  const [tradeType, setTradeType] = useState('');
  const [regime, setRegime] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [options, setOptions] = useState<FilterOptions>({
    assets: [], tradeTypes: [], regimes: [], subaccounts: [],
  });

  useEffect(() => {
    fetch(`/api/journals/filter-options?walletAddress=${encodeURIComponent(walletAddress)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data && !data.error) setOptions(data);
      })
      .catch(() => {});
  }, [walletAddress]);

  const submit = () => {
    const filter: AssignFilter = {};
    if (asset) filter.asset = asset;
    if (subaccount) filter.subaccount = subaccount;
    if (tradeType) filter.tradeType = tradeType;
    if (regime) filter.regime = regime;
    if (dateFrom) filter.dateFrom = dateFrom;
    if (dateTo) filter.dateTo = dateTo;
    if (Object.keys(filter).length === 0) return;
    onSubmit(filter);
  };

  const empty = !asset && !subaccount && !tradeType && !regime && !dateFrom && !dateTo;

  const selectCls =
    'bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#e6edf3] focus:outline-none focus:border-blue-500';

  return (
    <div className="mt-3 pt-3 border-t border-[#21262d] space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-[#6e7681]">
        Move every matching position from any journal into this one
      </p>
      <div className="grid grid-cols-2 gap-2">
        <select value={asset} onChange={(e) => setAsset(e.target.value)} className={selectCls}>
          <option value="">Any asset</option>
          {options.assets.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select value={subaccount} onChange={(e) => setSubaccount(e.target.value)} className={selectCls}>
          <option value="">Any subaccount</option>
          {options.subaccounts.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={tradeType} onChange={(e) => setTradeType(e.target.value)} className={selectCls}>
          <option value="">Any trade type</option>
          {(options.tradeTypes.length > 0 ? options.tradeTypes : TRADE_TYPES).map((t) => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select value={regime} onChange={(e) => setRegime(e.target.value)} className={selectCls}>
          <option value="">Any regime</option>
          {(options.regimes.length > 0 ? options.regimes : REGIMES.map((r) => r.value)).map((r) => (
            <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className={selectCls}
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className={selectCls}
        />
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1 text-xs text-[#8b949e] hover:text-white"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={working || empty}
          className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
        >
          Assign
        </button>
      </div>
    </div>
  );
}
