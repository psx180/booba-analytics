/**
 * GET /api/report/generate/download?jobId=…
 *
 * Streams the rendered PDF for a completed job. Must be called after the
 * status endpoint reports state='complete'. Public — no auth (the jobId is
 * the wallet address itself).
 *
 * The job entry is consumed (deleted) after a successful download to free
 * the buffer; otherwise it would sit until the 10-minute eviction timer fires.
 */

import { NextRequest, NextResponse } from 'next/server';
import { consumeJob, getJob } from '../job-store';

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId || !/^[A-Za-z0-9]{32,88}$/.test(jobId)) {
    return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });
  }

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (job.state !== 'complete' || !job.pdf) {
    return NextResponse.json(
      { error: 'Report not ready', state: job.state },
      { status: 409 },
    );
  }

  const pdf = job.pdf;
  consumeJob(jobId);

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="trading-report-${jobId.slice(0, 8)}.pdf"`,
      'Content-Length': String(pdf.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
