import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { resolveJournalFilterId } from '@/lib/journals';

/**
 * POST /api/analytics/metrics/compute
 *
 * Body: { walletAddress, journalId? }
 *
 * Computes metrics + runs insight detectors for a single journal. The
 * journal scope flows all the way through tilt detection, observation
 * persistence, and the BoobaObservation rows produced — so each journal
 * gets its own independent metric history and observation store.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const walletAddress = body.walletAddress;

  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const journalRes = await resolveJournalFilterId(walletAddress, body.journalId ?? null);
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  const journalScope = journalRes.id ?? undefined;

  const service = createAnalyticsService();
  const metricsSummary = await service.computeMetrics(walletAddress, journalScope);
  const insightSummary = await service.detectInsights(walletAddress, journalScope);

  return NextResponse.json({
    metrics: metricsSummary,
    insights: {
      produced: insightSummary.insights.length,
      skipped: insightSummary.skipped,
    },
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }

  const service = createAnalyticsService();
  const summary = await service.computeMetrics(walletAddress, journalRes.id ?? undefined);
  return NextResponse.json(summary);
}