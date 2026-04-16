/**
 * In-memory grouping-reset progress store, keyed by wallet address.
 * Shared between POST /api/grouping/run (writer) and GET /api/grouping/status (reader).
 * Module-level singleton — safe within a single Node.js server process.
 */

export interface GroupingProgress {
  stage: 'running' | 'done' | 'error';
  message: string;
  percent: number;
  updatedAt: number;
}

export const groupingProgressStore = new Map<string, GroupingProgress>();

export function setGroupingProgress(
  walletAddress: string,
  progress: Omit<GroupingProgress, 'updatedAt'>,
): void {
  groupingProgressStore.set(walletAddress, { ...progress, updatedAt: Date.now() });
}

export function getGroupingProgress(walletAddress: string): GroupingProgress | null {
  return groupingProgressStore.get(walletAddress) ?? null;
}

export function clearGroupingProgress(walletAddress: string): void {
  groupingProgressStore.delete(walletAddress);
}
