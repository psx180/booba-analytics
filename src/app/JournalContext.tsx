'use client';

/**
 * JournalContext — single source of truth for the active journal selection.
 *
 * The provider:
 *   1. Fetches /api/journals on mount and whenever the wallet changes.
 *   2. Picks an initial journal: localStorage[`journalId:${wallet}`] if it
 *      still exists, otherwise the wallet's default journal (server-side
 *      ensureDefaultJournal guarantees one exists).
 *   3. Persists the selection back to localStorage on every change so
 *      subsequent page loads remember it.
 *
 * Consumers (DashboardClient, TradesClient, AnalyticsClient) call useJournal()
 * to read journalId and append it to their API URLs via the appendJournal()
 * helper. They also re-fetch their data when the journalId changes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useAuthFetch } from '@/lib/api-client';

export interface JournalSummary {
  id: string;
  walletAddress: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  filters: string | null;
  positionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface JournalContextValue {
  walletAddress: string;
  journals: JournalSummary[];
  journalId: string | null;
  loading: boolean;
  /** Switch the active journal. Persists to localStorage. */
  setJournalId: (id: string) => void;
  /** Re-fetch the journal list. Call after create/delete/rename/assign. */
  refresh: () => Promise<void>;
  /**
   * Helper that returns a fresh URLSearchParams seeded with the current
   * journalId — saves every API caller from re-stringing it.
   * Pass extra params via the `extra` arg to merge them in.
   */
  buildParams: (extra?: Record<string, string | number | boolean | undefined | null>) => URLSearchParams;
}

const JournalContext = createContext<JournalContextValue | null>(null);

function storageKey(wallet: string): string {
  return `journalId:${wallet}`;
}

export function JournalProvider({
  walletAddress,
  children,
}: {
  walletAddress: string;
  children: React.ReactNode;
}) {
  const authFetch = useAuthFetch();
  const [journals, setJournals] = useState<JournalSummary[]>([]);
  const [journalId, setJournalIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchJournals = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/journals');
      const data = await res.json();
      const list: JournalSummary[] = data.journals ?? [];
      setJournals(list);

      // Honor a previously-stored selection if it still exists. Otherwise
      // fall back to the default journal (always present after the GET above).
      let initial: string | null = null;
      try {
        initial = window.localStorage.getItem(storageKey(walletAddress));
      } catch {
        // localStorage may be unavailable (SSR, privacy mode) — ignore.
      }
      const isStillValid = initial && list.some((j) => j.id === initial);
      if (isStillValid) {
        setJournalIdState(initial);
      } else {
        const def = list.find((j) => j.isDefault) ?? list[0] ?? null;
        setJournalIdState(def?.id ?? null);
      }
    } catch (err) {
      console.error('[JournalContext] failed to load journals', err);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, authFetch]);

  useEffect(() => {
    void fetchJournals();
  }, [fetchJournals]);

  const setJournalId = useCallback(
    (id: string) => {
      setJournalIdState(id);
      try {
        window.localStorage.setItem(storageKey(walletAddress), id);
      } catch {
        // ignore
      }
    },
    [walletAddress],
  );

  const buildParams = useCallback(
    (extra?: Record<string, string | number | boolean | undefined | null>) => {
      const p = new URLSearchParams();
      if (journalId) p.set('journalId', journalId);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          if (v == null || v === '') continue;
          p.set(k, String(v));
        }
      }
      return p;
    },
    [journalId],
  );

  const value = useMemo<JournalContextValue>(
    () => ({
      walletAddress,
      journals,
      journalId,
      loading,
      setJournalId,
      refresh: fetchJournals,
      buildParams,
    }),
    [walletAddress, journals, journalId, loading, setJournalId, fetchJournals, buildParams],
  );

  return <JournalContext.Provider value={value}>{children}</JournalContext.Provider>;
}

export function useJournal(): JournalContextValue {
  const ctx = useContext(JournalContext);
  if (!ctx) {
    throw new Error('useJournal must be used within a JournalProvider');
  }
  return ctx;
}

/**
 * Optional version that returns null when there's no provider in scope.
 * Useful for shared components that may render outside the journal-aware
 * tree (e.g. the NavBar shell itself).
 */
export function useJournalOptional(): JournalContextValue | null {
  return useContext(JournalContext);
}
