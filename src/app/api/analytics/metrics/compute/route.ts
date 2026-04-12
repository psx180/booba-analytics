import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { resolveJournalFilterId } from '@/lib/journals';
import { withAuth } from '@/lib/api-auth';

/**
 * POST /api/analytics/metrics/compute
 *
 * Body: { journalId? }
 *
 * Computes metrics + runs insight detectors for a single journal. The
 * journal scope flows all the way through tilt detection, observation
 * persistence, and the BoobaObservation rows produced — so each journal
 * gets its own independent metric history and observation store.
 */
export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json().catch(() => ({}));

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
  });
}

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const sp = req.nextUrl.searchParams;

    const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
    if (!journalRes.valid) {
      return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
    }

    const service = createAnalyticsService();
    const summary = await service.computeMetrics(walletAddress, journalRes.id ?? undefined);
    return NextResponse.json(summary);
  });
}