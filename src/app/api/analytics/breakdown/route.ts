import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { resolveJournalId } from '@/lib/journals';
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
  'date',
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

  const filters = parseFilters(sp);
  const journalId = await resolveJournalId(walletAddress, sp.get('journalId'));
  if (!journalId) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  filters.journalId = journalId;

  const service = createAnalyticsService();
  const result = await service.aggregate(
    'breakdown',
    walletAddress,
    filters,
    { groupBy },
  );
  return NextResponse.json(result);
}