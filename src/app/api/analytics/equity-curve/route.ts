import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { computeXpnlResult } from '@/services/analytics/metrics/xpnl';
import { prisma } from '@/lib/prisma';
import { resolveJournalFilterId } from '@/lib/journals';
import { parseFilters } from '../_filters';
import { withAuth } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
  const sp = req.nextUrl.searchParams;

  const service = createAnalyticsService();
  const filters = parseFilters(sp);
  // Journal scope — default journal returns id=null → wallet-wide view.
  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  if (journalRes.id) filters.journalId = journalRes.id;

  const result = await service.aggregate('equity-curve', walletAddress, filters);

  // Optional xPnL overlay — opt-in via ?withXpnl=true so existing callers
  // (regime breakdown table, weekly summary jobs) don't pay the KNN cost.
  const withXpnl = sp.get('withXpnl') === 'true';
  if (withXpnl) {
    const where: any = { walletAddress };
    if (journalRes.id) where.journalId = journalRes.id;
    if (filters.regime) where.regimeAtEntry = filters.regime;
    if (filters.asset) where.asset = filters.asset;
    if (filters.strategy) where.strategyId = filters.strategy;
    if (filters.tradeType) where.tradeType = filters.tradeType;
    if (filters.dateFrom || filters.dateTo) {
      where.firstEntryTime = {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo   ? { lte: filters.dateTo }   : {}),
      };
    }
    const positions = await prisma.position.findMany({ where });
    const xpnlResult = computeXpnlResult(positions as any);
    return NextResponse.json({ ...result, xpnl: xpnlResult });
  }

  return NextResponse.json(result);
  });
}