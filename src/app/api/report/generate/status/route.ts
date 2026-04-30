/**
 * GET /api/report/generate/status?jobId=…
 *
 * Returns the current state of a report-generation job plus the latest
 * progress entry from the import progress store. The frontend polls this
 * every 2 seconds while the report is being generated.
 *
 * Public — no auth. The jobId is the wallet address itself (which the caller
 * already knows because they typed it in).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '../job-store';
import { getProgress } from '@/app/api/import/progress-store';

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId || !/^[A-Za-z0-9]{32,88}$/.test(jobId)) {
    return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const progress = getProgress(jobId);

  return NextResponse.json({
    jobId: job.jobId,
    state: job.state,
    cached: job.cached,
    error: job.error,
    progress: progress
      ? {
          stage: progress.stage,
          message: progress.message,
          fillsFetched: progress.fillsFetched,
          computingTier: progress.computingTier,
          balanceEvents: progress.balanceEvents,
          equitySnapshots: progress.equitySnapshots,
          positionsCreated: progress.positionsCreated,
        }
      : null,
  });
}
