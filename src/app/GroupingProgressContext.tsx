'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export interface GroupingProgress {
  msg: string;
  percent: number;
  done: boolean;
}

interface GroupingProgressContextValue {
  /** Current progress, or null when no job is active (or toast was dismissed). */
  progress: GroupingProgress | null;
  /**
   * True once the user has clicked × on the toast. The polling loop in
   * TradesClient watches this flag and stops updating when it's set.
   */
  dismissed: boolean;
  /** Call when a new job starts — resets dismissed and sets initial progress. */
  startJob: (initial: GroupingProgress) => void;
  /** Update progress without resetting the dismissed flag. */
  setProgress: (p: GroupingProgress | null) => void;
  /** User clicked ×: hides toast immediately; job continues on the server. */
  dismiss: () => void;
}

const GroupingProgressContext = createContext<GroupingProgressContextValue | null>(null);

export function GroupingProgressProvider({ children }: { children: ReactNode }) {
  const [progress, setProgressState] = useState<GroupingProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const startJob = useCallback((initial: GroupingProgress) => {
    setDismissed(false);
    setProgressState(initial);
  }, []);

  const setProgress = useCallback((p: GroupingProgress | null) => {
    setProgressState(p);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setProgressState(null);
  }, []);

  return (
    <GroupingProgressContext.Provider value={{ progress, dismissed, startJob, setProgress, dismiss }}>
      {children}
    </GroupingProgressContext.Provider>
  );
}

export function useGroupingProgress(): GroupingProgressContextValue {
  const ctx = useContext(GroupingProgressContext);
  if (!ctx) throw new Error('useGroupingProgress must be used within GroupingProgressProvider');
  return ctx;
}
