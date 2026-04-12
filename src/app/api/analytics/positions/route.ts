import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveJournalId } from '@/lib/journals';
import { parseFilters } from '../_filters';

/**
 * GET /api/analytics/positions
 *
 * Returns closed positions with the computed analytics fields needed by the
 * frontend chart sections (scatter plot, histogram, strategy breakdown, what-if).
 * Respects the standard filter params (regime, asset, strategy, tradeType, dates).
 *
 * Journal scoping: like every other analytics route, this is journal-bound.
 * When ?journalId= is omitted we fall back to the wallet's default journal.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const journalId = await resolveJournalId(walletAddress, sp.get('journalId'));
  if (!journalId) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }

  const filters = parseFilters(sp);
  const where: Record<string, any> = { walletAddress, status: 'closed', journalId };

  if (filters.regime) where.regimeAtEntry = filters.regime;
  if (filters.asset) where.asset = filters.asset;
  if (filters.strategy) where.strategyId = filters.strategy;
  if (filters.tradeType) where.tradeType = filters.tradeType;
  if (filters.dateFrom || filters.dateTo) {
    where.firstEntryTime = {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    };
  }

  const positions = await (prisma as any).position.findMany({
    where,
    select: {
      id: true,
      aggregatePnl: true,
      mfePnl: true,
      maePnl: true,
      exitEfficiency: true,
      moneyLeftOnTable: true,
      totalSize: true,
      holdTimeSeconds: true,
      regimeAtEntry: true,
      tradeType: true,
      strategyId: true,
      firstEntryTime: true,
      entryHour: true,
      entryDayOfWeek: true,
    },
    orderBy: { firstEntryTime: 'asc' },
  });

  return NextResponse.json({ positions, count: positions.length });
}
