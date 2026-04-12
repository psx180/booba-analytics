'use client';

/**
 * LiveContext — one app-wide SSE subscription to /api/ws.
 *
 * Mounted inside AuthedShell so every page (NavBar's LIVE indicator,
 * DashboardClient's open positions, any future popup trigger) reads from
 * the same subscription. Without this, each page that called
 * usePacificaLive() would open its own SSE stream, triggering a new
 * upstream Pacifica websocket per page.
 */

import { createContext, useContext } from 'react';
import { usePacificaLive, type PacificaLiveState } from '@/hooks/usePacificaLive';

const LiveContext = createContext<PacificaLiveState | null>(null);

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const state = usePacificaLive();
  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export function useLive(): PacificaLiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) {
    throw new Error('useLive must be used within a LiveProvider');
  }
  return ctx;
}
