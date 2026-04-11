import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { computeXpnlResult } from '@/services/analytics/metrics/xpnl';
import { prisma } from '@/lib/prisma';
import { parseFilters } from '../_filters';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = createAnalyticsService();
  const filters = parseFilters(sp);
  const result = await service.aggregate('equity-curve', walletAddress, filters);

  // Optional xPnL overlay — opt-in via ?withXpnl=true so existing callers
  // (regime breakdown table, weekly summary jobs) don't pay the KNN cost.
  const withXpnl = sp.get('withXpnl') === 'true';
  if (withXpnl) {
    const where: any = { walletAddress };
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
}