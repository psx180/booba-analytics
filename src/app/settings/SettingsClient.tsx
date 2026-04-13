'use client';

import { useState } from 'react';
import { useAuthFetch } from '@/lib/api-client';

// ── Reset Grouping ────────────────────────────────────────────────────────────

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

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0d1117] border border-[#21262d] rounded-xl shadow-2xl p-6 w-full max-w-md">
            <h3 className="text-base font-semibold text-white mb-2">Are you sure?</h3>
            <p className="text-sm text-[#8b949e] mb-6">
              This will rebuild all position groupings. Manual changes will be lost.
              This cannot be undone.
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

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SettingsClient() {
  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-lg font-semibold text-white">Settings</h1>
      <ResetGroupingSection />
    </div>
  );
}
