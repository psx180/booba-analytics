'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuthFetch } from '@/lib/api-client';
import { useJournal } from '../JournalContext';

/**
 * "Report ▾" dropdown — exposes the trading-report endpoint as either a
 * PDF download or a JSON view. Bearer auth is required for both, so both
 * options route through useAuthFetch + a temporary blob URL rather than
 * a plain anchor link.
 */
export default function ReportMenu() {
  const authFetch = useAuthFetch();
  const { journalId } = useJournal();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'json' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const buildUrl = (format: 'pdf' | 'json') => {
    const p = new URLSearchParams();
    if (journalId) p.set('journalId', journalId);
    p.set('format', format);
    return `/api/report?${p.toString()}`;
  };

  const downloadPdf = async () => {
    if (busy) return;
    setBusy('pdf');
    setOpen(false);
    try {
      const res = await authFetch(buildUrl('pdf'));
      if (!res.ok) {
        console.error('Report PDF request failed', res.status, await res.text());
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      // Pull the filename out of Content-Disposition when available.
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = /filename="([^"]+)"/.exec(cd);
      a.href = url;
      a.download = m ? m[1] : `trading-report-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  const viewJson = async () => {
    if (busy) return;
    setBusy('json');
    setOpen(false);
    try {
      const res = await authFetch(buildUrl('json'));
      if (!res.ok) {
        console.error('Report JSON request failed', res.status, await res.text());
        return;
      }
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      // Open in a new tab so the user can inspect it without losing the
      // dashboard. We don't revokeObjectURL immediately — the new tab
      // needs the URL alive. Browsers free it when the tab closes.
      window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy != null}
        className="bg-[#21262d] border border-[#30363d] text-sm text-[#e6edf3] rounded px-3 py-1.5 flex items-center gap-1.5 hover:border-[#4a5568] disabled:opacity-50 transition-colors whitespace-nowrap"
      >
        {/* download glyph */}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 1a.75.75 0 0 1 .75.75v6.69l1.97-1.97a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.53a.75.75 0 0 1 1.06-1.06l1.97 1.97V1.75A.75.75 0 0 1 8 1Zm-5.25 11.5a.75.75 0 0 1 .75-.75h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1-.75-.75Z" />
        </svg>
        {busy === 'pdf' ? 'Building PDF…' : busy === 'json' ? 'Loading JSON…' : 'Report'}
        <span className="text-xs">▾</span>
      </button>
      {open && !busy && (
        <div className="absolute right-0 top-full mt-1 z-30 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl min-w-[200px] overflow-hidden">
          <button
            type="button"
            onClick={downloadPdf}
            className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors"
          >
            Download PDF
          </button>
          <button
            type="button"
            onClick={viewJson}
            className="w-full text-left px-3 py-2 text-sm text-[#e6edf3] hover:bg-[#21262d] transition-colors border-t border-[#21262d]"
          >
            View JSON
          </button>
        </div>
      )}
    </div>
  );
}
