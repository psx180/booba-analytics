/**
 * In-memory import progress store, keyed by wallet address.
 * Shared between POST /api/import (writer) and GET /api/import/status (reader).
 * Module-level singleton — safe within a single Node.js server process.
 */

export interface ImportProgress {
  stage: 'fetching' | 'grouping' | 'computing' | 'done' | 'error';
  message: string;
  fillsFetched: number;
  updatedAt: number;
}

export const importProgressStore = new Map<string, ImportProgress>();

export function setProgress(
  walletAddress: string,
  progress: Omit<ImportProgress, 'updatedAt'>,
): void {
  importProgressStore.set(walletAddress, { ...progress, updatedAt: Date.now() });
}

export function getProgress(walletAddress: string): ImportProgress | null {
  return importProgressStore.get(walletAddress) ?? null;
}
