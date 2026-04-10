import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { parseFilters } from '../_filters';

const VALID_DIMENSIONS = new Set([
  'regime',
  'asset',
  'strategy',
  'source',
  'tradeType',
  'entryHour',
  'entryDayOfWeek',
  'entrySession',
  'holdTimeCategory',
]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const groupBy = sp.get('groupBy') ?? 'regime';
  if (!VALID_DIMENSIONS.has(groupBy)) {
    return NextResponse.json(
      { error: `Invalid groupBy. Must be one of: ${Array.from(VALID_DIMENSIONS).join(', ')}` },
      { status: 400 },
    );
  }

  const service = createAnalyticsService();
  const result = await service.aggregate(
    'breakdown',
    walletAddress,
    parseFilters(sp),
    { groupBy },
  );
  return NextResponse.json(result);
}