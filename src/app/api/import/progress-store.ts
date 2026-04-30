/**
 * In-memory import progress store, keyed by wallet address.
 * Shared between POST /api/import (writer) and GET /api/import/status (reader),
 * plus the public /api/report/generate pipeline which reuses the same writer.
 * Module-level singleton — safe within a single Node.js server process.
 */

export type ImportStage =
  | 'fetching'
  | 'syncing'
  | 'grouping'
  | 'regimes'
  | 'computing'
  | 'rendering'
  | 'done'
  | 'error';

export type ComputingTier = 'fast' | 'slow';

export interface ImportProgress {
  stage: ImportStage;
  message: string;
  fillsFetched: number;
  // Sub-stage for stage='computing' so the report UI can show separate
  // "fast analytics" and "deep analytics" steps. Older consumers (dashboard
  // poller) ignore this field.
  computingTier?: ComputingTier;
  // Per-step counts surfaced to the report progress UI as subtitles.
  balanceEvents?: number;
  equitySnapshots?: number;
  positionsCreated?: number;
  // Set when stage='error' so the UI can surface the failure detail.
  error?: string;
  updatedAt: number;
}

export const importProgressStore = new Map<string, ImportProgress>();

export function setProgress(
  walletAddress: string,
  progress: Omit<ImportProgress, 'updatedAt'>,
): void {
  importProgressStore.set(walletAddress, { ...progress, updatedAt: Date.now() });
}

/**
 * Merge a partial update into the existing progress entry. Useful when the
 * caller wants to bump a count (e.g. positionsCreated) without restating the
 * stage/message. If no entry exists yet, the partial is treated as a full
 * starting state.
 */
export function patchProgress(
  walletAddress: string,
  patch: Partial<Omit<ImportProgress, 'updatedAt'>>,
): void {
  const prev = importProgressStore.get(walletAddress);
  const next: ImportProgress = {
    stage: patch.stage ?? prev?.stage ?? 'fetching',
    message: patch.message ?? prev?.message ?? '',
    fillsFetched: patch.fillsFetched ?? prev?.fillsFetched ?? 0,
    computingTier: patch.computingTier ?? prev?.computingTier,
    balanceEvents: patch.balanceEvents ?? prev?.balanceEvents,
    equitySnapshots: patch.equitySnapshots ?? prev?.equitySnapshots,
    positionsCreated: patch.positionsCreated ?? prev?.positionsCreated,
    error: patch.error ?? prev?.error,
    updatedAt: Date.now(),
  };
  importProgressStore.set(walletAddress, next);
}

export function getProgress(walletAddress: string): ImportProgress | null {
  return importProgressStore.get(walletAddress) ?? null;
}

export function clearProgress(walletAddress: string): void {
  importProgressStore.delete(walletAddress);
}
