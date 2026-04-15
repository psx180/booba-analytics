'use client';

/**
 * SyncContext — global manual-sync state.
 *
 * Mounted in AuthedShell so NavBar can render the ↻ button on every page.
 * TradesClient subscribes to onSyncComplete to know when to refresh its
 * trade list (instead of owning the button and state itself).
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { useAuthFetch } from '@/lib/api-client';

interface SyncContextValue {
  syncLoading: boolean;
  syncCooldown: boolean;
  handleManualSync: () => Promise<void>;
  /** Increments each time a sync finds new trades — subscribers can react. */
  syncImportCount: number;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const authFetch = useAuthFetch();
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncCooldown, setSyncCooldown] = useState(false);
  const [syncImportCount, setSyncImportCount] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleManualSync = useCallback(async () => {
    if (syncLoading || syncCooldown) return;
    setSyncLoading(true);
    try {
      const res = await authFetch('/api/sync', { method: 'POST' });
      const data = (await res.json()) as { imported?: number };
      if ((data.imported ?? 0) > 0) {
        setSyncImportCount((n) => n + 1);
      }
    } catch {
      // silently swallow; user can retry after cooldown
    } finally {
      setSyncLoading(false);
      setSyncCooldown(true);
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      cooldownTimer.current = setTimeout(() => setSyncCooldown(false), 10_000);
    }
  }, [syncLoading, syncCooldown, authFetch]);

  return (
    <SyncContext.Provider value={{ syncLoading, syncCooldown, handleManualSync, syncImportCount }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within a SyncProvider');
  return ctx;
}
