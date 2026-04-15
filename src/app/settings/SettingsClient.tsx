'use client';

import { useState, useEffect } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import { useJournalOptional } from '@/app/JournalContext';
import { useAccount } from '@/contexts/AccountContext';

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="text-[10px] uppercase tracking-widest text-[#6e7681] font-medium mb-3 mt-1">
      {title}
    </div>
  );
}

// ── TRADING: Grouping threshold ───────────────────────────────────────────────

const THRESHOLD_OPTIONS: { label: string; value: number }[] = [
  { label: '30 min', value: 0.5 },
  { label: '1 h',   value: 1 },
  { label: '2 h',   value: 2 },
  { label: '4 h',   value: 4 },
  { label: '8 h',   value: 8 },
  { label: '24 h',  value: 24 },
];

const THRESHOLD_KEY = 'groupingThresholdHours';
const DEFAULT_THRESHOLD = 4;

function GroupingThresholdSection() {
  const [value, setValue] = useState<number>(DEFAULT_THRESHOLD);

  useEffect(() => {
    const stored = localStorage.getItem(THRESHOLD_KEY);
    if (stored) {
      const n = parseFloat(stored);
      if (!isNaN(n)) setValue(n);
    }
  }, []);

  const handleChange = (v: number) => {
    setValue(v);
    localStorage.setItem(THRESHOLD_KEY, String(v));
  };

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Grouping Time Threshold</h2>
      <p className="text-xs text-[#8b949e] mb-4 max-w-lg">
        Group orders into positions when they're within this time window.
      </p>
      <div className="flex flex-wrap gap-2">
        {THRESHOLD_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleChange(opt.value)}
            className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
              value === opt.value
                ? 'bg-blue-700 border-blue-600 text-white'
                : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:text-white hover:bg-[#30363d]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── TRADING: Show Experimental ────────────────────────────────────────────────

const EXPERIMENTAL_KEY = 'showExperimental';

function ShowExperimentalSection() {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(EXPERIMENTAL_KEY);
    setEnabled(stored !== 'false');
  }, []);

  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem(EXPERIMENTAL_KEY, String(next));
  };

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white mb-1">Show Experimental Features</h2>
          <p className="text-xs text-[#8b949e] max-w-lg">
            Enable features that are still in development. May be unstable.
          </p>
        </div>
        <button
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            enabled ? 'bg-blue-600' : 'bg-[#30363d]'
          }`}
          role="switch"
          aria-checked={enabled}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
    </div>
  );
}

// ── DATA: Reset Grouping ──────────────────────────────────────────────────────

function ResetGroupingSection() {
  const authFetch = useAuthFetch();
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleConfirm = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await authFetch('/api/grouping/run', { method: 'POST' });
      if (res.ok) {
        setResult('Grouping rebuilt successfully. Reloading…');
        setShowConfirm(false);
        setTimeout(() => window.location.reload(), 1_500);
      } else {
        setResult('Reset failed — check the server logs.');
      }
    } catch {
      setResult('Reset failed — check the server logs.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Reset Trade Grouping</h2>
      <p className="text-xs text-[#8b949e] mb-4 max-w-lg">
        Rebuild all position groupings from raw fills. Manual merges, splits, and links will be lost.
      </p>

      {result && (
        <p className={`text-xs mb-4 ${result.includes('failed') ? 'text-red-400' : 'text-emerald-400'}`}>
          {result}
        </p>
      )}

      <button
        onClick={() => setShowConfirm(true)}
        className="px-4 py-2 text-sm font-medium text-white bg-red-700 hover:bg-red-600 rounded transition-colors"
      >
        Reset Grouping
      </button>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl p-6 w-full max-w-md">
            <h3 className="text-base font-semibold text-white mb-2">Are you sure?</h3>
            <p className="text-sm text-[#8b949e] mb-6">
              This will rebuild all position groupings. Manual changes will be lost. This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={loading}
                className="px-4 py-2 text-sm text-[#e6edf3] bg-[#21262d] border border-[#30363d] rounded hover:bg-[#30363d] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium text-white bg-red-700 hover:bg-red-600 rounded transition-colors disabled:opacity-50 disabled:cursor-wait"
              >
                {loading ? 'Rebuilding…' : 'Reset Grouping'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── DATA: Re-import Trades ────────────────────────────────────────────────────

function ReImportSection() {
  const authFetch = useAuthFetch();
  const { network } = useAccount();
  const journal = useJournalOptional();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleReImport = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const body: Record<string, unknown> = { regimes: true };

      // When on testnet, or when a specific journal is active, route imported
      // positions into the currently-selected journal.
      if (journal?.journalId) {
        body.journalId = journal.journalId;
      }

      const res = await authFetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        const positions = data.summary?.totalPositions ?? 0;
        setStatus({ ok: true, msg: `Done — ${positions} positions refreshed.` });
      } else {
        setStatus({ ok: false, msg: 'Import failed — check the server logs.' });
      }
    } catch {
      setStatus({ ok: false, msg: 'Import failed — check the server logs.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Re-import Trades</h2>
      <p className="text-xs text-[#8b949e] mb-4 max-w-lg">
        Force re-fetch all trades from Pacifica.
        {network === 'testnet' && (
          <span className="ml-1 text-orange-400">Currently on Testnet.</span>
        )}
      </p>

      {status && (
        <p className={`text-xs mb-4 ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {status.msg}
        </p>
      )}

      <button
        onClick={handleReImport}
        disabled={loading}
        className="px-4 py-2 text-sm font-medium text-white bg-[#1f6feb] hover:bg-[#388bfd] rounded transition-colors disabled:opacity-50 disabled:cursor-wait"
      >
        {loading ? (
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Importing…
          </span>
        ) : (
          'Re-import Trades'
        )}
      </button>
    </div>
  );
}

// ── ABOUT: Replay Intro Tour ──────────────────────────────────────────────────

function ReplayIntroTourSection() {
  const [done, setDone] = useState(false);

  const handleReset = () => {
    localStorage.removeItem('hasSeenAppIntro');
    setDone(true);
  };

  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-lg p-5">
      <h2 className="text-sm font-semibold text-white mb-1">Replay Intro Tour</h2>
      <p className="text-xs text-[#8b949e] mb-4 max-w-lg">
        Play the Booba intro and guided tour again.
      </p>

      {done && (
        <p className="text-xs text-emerald-400 mb-4">
          Done — refresh the page to replay the tour.
        </p>
      )}

      <button
        onClick={handleReset}
        className="px-4 py-2 text-sm font-medium text-white bg-[#1f6feb] hover:bg-[#388bfd] rounded transition-colors"
      >
        Replay Intro Tour
      </button>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SettingsClient() {
  return (
    <div className="space-y-8 max-w-2xl">
      {/* TRADING */}
      <section>
        <SectionHeader title="Trading" />
        <div className="space-y-4">
          <GroupingThresholdSection />
          <ShowExperimentalSection />
        </div>
      </section>

      {/* DATA */}
      <section>
        <SectionHeader title="Data" />
        <div className="space-y-4">
          <ResetGroupingSection />
          <ReImportSection />
        </div>
      </section>

      {/* ABOUT */}
      <section>
        <SectionHeader title="About" />
        <div className="space-y-4">
          <ReplayIntroTourSection />
        </div>
      </section>
    </div>
  );
}
