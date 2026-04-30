/**
 * POST /api/report/generate
 *
 * Public endpoint (no auth) that runs the full import + analytics pipeline for
 * any Pacifica wallet address and produces a PDF report.
 *
 * Approach B (polling): this POST kicks off the work in the background and
 * returns a jobId immediately. The frontend then polls
 * GET /api/report/generate/status?jobId=… for progress and finally fetches
 * GET /api/report/generate/download?jobId=… for the PDF.
 *
 * Concurrency: jobId === walletAddress, so there is one concurrent slot per
 * wallet. If a job is already running for the same wallet, this endpoint
 * returns its id rather than starting a new one.
 *
 * Caching: if the wallet already has positions in the database AND the most
 * recent position was created within the last hour, the import phase is
 * skipped and we go straight to report generation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runImportPipeline } from '@/services/import/import-pipeline';
import { setProgress, clearProgress } from '@/app/api/import/progress-store';
import {
  createJob,
  getJob,
  isJobActive,
  setJobState,
} from './job-store';

const FRESHNESS_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const walletAddress: string | undefined = body.walletAddress;

  if (!walletAddress || !/^[A-Za-z0-9]{32,88}$/.test(walletAddress)) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  // Concurrency lock: if a job for this wallet is already running, return
  // its id rather than kicking off a duplicate pipeline.
  if (isJobActive(walletAddress)) {
    const existing = getJob(walletAddress)!;
    return NextResponse.json({
      jobId: existing.jobId,
      cached: existing.cached,
      reused: true,
    });
  }

  // Freshness check: skip the import phase entirely if positions exist and
  // the most recent one was created in the last hour. createdAt reflects the
  // last grouping run rather than the wallet's last trade — fine as a
  // "did we import recently" gate.
  const { prisma } = await import('@/lib/prisma');
  const latestPosition = await prisma.position.findFirst({
    where: { walletAddress },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const cached = latestPosition !== null
    && (Date.now() - latestPosition.createdAt.getTime()) < FRESHNESS_WINDOW_MS;

  // Reset any prior progress entry from a previous run so the UI starts clean.
  clearProgress(walletAddress);

  const job = createJob(walletAddress, cached);

  // Kick off the work in the background and return immediately.
  // On Railway (persistent Node process) the work continues running after the
  // response closes — this would not be safe on serverless function platforms.
  runJob(walletAddress, cached).catch((err) => {
    console.error('[report/generate] Job failed:', err);
    setJobState(walletAddress, {
      state: 'error',
      error: err instanceof Error ? err.message : 'Report generation failed',
    });
    setProgress(walletAddress, {
      stage: 'error',
      message: err instanceof Error ? err.message : 'Report generation failed',
      fillsFetched: 0,
      error: err instanceof Error ? err.message : 'Report generation failed',
    });
  });

  return NextResponse.json({
    jobId: job.jobId,
    cached,
    reused: false,
  });
}

async function runJob(walletAddress: string, cached: boolean): Promise<void> {
  setJobState(walletAddress, { state: 'running' });

  if (!cached) {
    // Full import pipeline — slow analytics tier is awaited so the report
    // reflects every metric (regime stats, MFE/MAE, etc.).
    await runImportPipeline(walletAddress, {
      awaitSlowTier: true,
      withRegimes: true,
      network: 'mainnet',
    });
  }

  // 6. Render the report
  setProgress(walletAddress, {
    stage: 'rendering',
    message: 'Generating report…',
    fillsFetched: 0,
  });

  const { generateReport } = await import('@/services/report/report-service');
  const { renderReportPdf } = await import('@/services/report/pdf-renderer');

  const report = await generateReport(walletAddress);
  const pdf = await renderReportPdf(report);

  setJobState(walletAddress, { state: 'complete', pdf });
  setProgress(walletAddress, {
    stage: 'done',
    message: 'Report ready',
    fillsFetched: 0,
  });
}
