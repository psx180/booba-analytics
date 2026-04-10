import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const walletAddress = body.walletAddress;

  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const metricsSummary = await service.computeMetrics(walletAddress);
  const insightSummary = await service.detectInsights(walletAddress);

  return NextResponse.json({
    metrics: metricsSummary,
    insights: {
      produced: insightSummary.insights.length,
      skipped: insightSummary.skipped,
    },
  });
}

export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const summary = await service.computeMetrics(walletAddress);
  return NextResponse.json(summary);
}