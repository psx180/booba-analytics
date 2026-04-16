'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface BoobaState {
  healthScore: number;
  insight: string | null;
  insightMood: string | null;
  insightLink: string | null;
}

interface BoobaContextValue extends BoobaState {
  chatOpen: boolean;
  prefillMessage: string | undefined;
  openChat: (prefillMessage?: string) => void;
  closeChat: () => void;
  /** Pages push their computed health/insight here so AppShell can render it */
  setBoobaState: (state: Partial<BoobaState>) => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const BoobaContext = createContext<BoobaContextValue>({
  healthScore: 50,
  insight: null,
  insightMood: null,
  insightLink: null,
  chatOpen: false,
  prefillMessage: undefined,
  openChat: () => {},
  closeChat: () => {},
  setBoobaState: () => {},
});

// ── Provider ──────────────────────────────────────────────────────────────────

export function BoobaProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BoobaState>({
    healthScore: 50,
    insight: null,
    insightMood: null,
    insightLink: null,
  });
  const [chatOpen, setChatOpen] = useState(false);
  const [prefillMessage, setPrefillMessage] = useState<string | undefined>(undefined);

  const openChat = useCallback((prefill?: string) => {
    setPrefillMessage(prefill);
    setChatOpen(true);
  }, []);

  const closeChat = useCallback(() => {
    setChatOpen(false);
    setPrefillMessage(undefined);
  }, []);

  const setBoobaState = useCallback((partial: Partial<BoobaState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  return (
    <BoobaContext.Provider value={{ ...state, chatOpen, prefillMessage, openChat, closeChat, setBoobaState }}>
      {children}
    </BoobaContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBooba() {
  return useContext(BoobaContext);
}
