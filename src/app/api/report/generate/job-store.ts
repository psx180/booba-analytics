/**
 * In-memory job store for /api/report/generate.
 *
 * Each entry holds the rendered PDF buffer and lifecycle state for a single
 * wallet's report. The job id is the wallet address itself — there's a single
 * concurrent slot per wallet, which doubles as the rate-limit and the
 * "return existing job if one is already running" mechanism.
 *
 * Module-level singleton — safe within a single Node.js server process
 * (Railway in our case, not serverless).
 */

export type ReportJobState =
  | 'queued'    // accepted, hasn't started running yet
  | 'running'   // import + report generation in flight
  | 'complete'  // PDF ready in `pdf`
  | 'error';    // failed; `error` populated

export interface ReportJob {
  jobId: string;          // === walletAddress
  walletAddress: string;
  state: ReportJobState;
  pdf?: Buffer;
  error?: string;
  cached: boolean;        // true when import was skipped (fresh cache hit)
  createdAt: number;
  completedAt?: number;
  evictTimer?: NodeJS.Timeout;
}

const store = new Map<string, ReportJob>();

const EVICT_AFTER_MS = 10 * 60 * 1000; // 10 minutes after completion

export function getJob(jobId: string): ReportJob | null {
  return store.get(jobId) ?? null;
}

export function createJob(walletAddress: string, cached: boolean): ReportJob {
  // If a previous completed/error entry exists, clear its timer and replace.
  const prev = store.get(walletAddress);
  if (prev?.evictTimer) clearTimeout(prev.evictTimer);

  const job: ReportJob = {
    jobId: walletAddress,
    walletAddress,
    state: 'queued',
    cached,
    createdAt: Date.now(),
  };
  store.set(walletAddress, job);
  return job;
}

export function setJobState(
  jobId: string,
  patch: Partial<Pick<ReportJob, 'state' | 'pdf' | 'error' | 'cached' | 'completedAt'>>,
): void {
  const job = store.get(jobId);
  if (!job) return;
  Object.assign(job, patch);

  if ((patch.state === 'complete' || patch.state === 'error') && !job.evictTimer) {
    job.completedAt = Date.now();
    job.evictTimer = setTimeout(() => {
      store.delete(jobId);
    }, EVICT_AFTER_MS);
    // Allow process exit if nothing else is keeping it alive.
    job.evictTimer.unref?.();
  }
}

/** Remove a job's PDF buffer & store entry immediately. Used after download. */
export function consumeJob(jobId: string): void {
  const job = store.get(jobId);
  if (!job) return;
  if (job.evictTimer) clearTimeout(job.evictTimer);
  store.delete(jobId);
}

export function isJobActive(jobId: string): boolean {
  const job = store.get(jobId);
  return job?.state === 'queued' || job?.state === 'running';
}
