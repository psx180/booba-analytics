'use client';

/**
 * JournalSelector — top-nav dropdown that picks the active journal and
 * opens the Manage Journals modal. Lives in NavBar.
 *
 * Designed to be unobtrusive when there's only one journal (the default
 * "All Trades") so brand-new users don't see a confusing dropdown they
 * don't understand. As soon as a second journal exists, the dropdown
 * surfaces the names side-by-side.
 */

import { useEffect, useRef, useState } from 'react';
import { useJournal } from './JournalContext';
import ManageJournalsModal from './ManageJournalsModal';

export default function JournalSelector() {
  const { journals, journalId, setJournalId, loading } = useJournal();
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click — same pattern the trades page uses for menus.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const active = journals.find((j) => j.id === journalId) ?? null;

  return (
    <>
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={loading || journals.length === 0}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] transition-colors disabled:opacity-50"
          title="Switch journal"
        >
          <span className="text-[#6e7681] uppercase tracking-widest text-[9px]">Journal</span>
          <span className="text-white max-w-[160px] truncate">
            {loading ? 'Loading…' : active?.name ?? 'All Trades'}
          </span>
          <span className="text-[#6e7681] text-[10px]">▾</span>
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 bg-[#1c2128] border border-[#30363d] rounded shadow-xl z-30 min-w-[240px]">
            <div className="max-h-[320px] overflow-y-auto">
              {journals.map((j) => {
                const isActive = j.id === journalId;
                return (
                  <button
                    key={j.id}
                    onClick={() => {
                      setJournalId(j.id);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center justify-between gap-2 ${
                      isActive
                        ? 'bg-blue-900/30 text-white'
                        : 'text-[#e6edf3] hover:bg-[#21262d]'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{j.name}</span>
                      {j.isDefault && (
                        <span className="text-[9px] uppercase tracking-widest text-[#6e7681] shrink-0">
                          default
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] text-[#6e7681] shrink-0">
                      {j.positionCount}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="border-t border-[#30363d]">
              <button
                onClick={() => {
                  setManageOpen(true);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-xs text-[#8b949e] hover:text-white hover:bg-[#21262d] transition-colors"
              >
                Manage Journals…
              </button>
            </div>
          </div>
        )}
      </div>

      {manageOpen && <ManageJournalsModal onClose={() => setManageOpen(false)} />}
    </>
  );
}
