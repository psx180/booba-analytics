import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { parseFilters } from '../_filters';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const result = await service.aggregate('equity-curve', walletAddress, parseFilters(sp));
  return NextResponse.json(result);
}