import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';

/**
 * GET  — return stored insights (from booba_observations).
 * POST — re-run all insight detectors, persist, return the fresh results.
 */

export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const insights = await service.getStoredInsights(walletAddress);
  return NextResponse.json({ insights });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const walletAddress = body.walletAddress;
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const summary = await service.detectInsights(walletAddress);
  return NextResponse.json(summary);
}