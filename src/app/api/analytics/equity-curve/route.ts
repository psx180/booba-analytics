import { NextRequest, NextResponse } from 'next/server';
import { createAnalyticsService } from '@/services/analytics';
import { computeXpnlResult } from '@/services/analytics/metrics/xpnl';
import { prisma } from '@/lib/prisma';
import { resolveJournalFilterId } from '@/lib/journals';
import { parseFilters } from '../_filters';
import { withAuth } from '@/lib/api-auth';

const EQUITY_PROVIDER_MODE = process.env.EQUITY_PROVIDER_MODE ?? 'legacy';

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

  // Route through the async equity provider for non-legacy modes (snapshot-twr,
  // starting-capital). Legacy keeps the byte-identical sync aggregator path so
  // existing callers see no change unless they opt in via env.
  const useAsync = EQUITY_PROVIDER_MODE !== 'legacy';
  const result = useAsync
    ? await service.aggregateEquityCurveAsync(walletAddress, filters)
    : await service.aggregate('equity-curve', walletAddress, filters);

  // When the snapshot-twr provider is active, attach cash-flow context so the
  // dashboard can show "Starting capital: $X / Deposited: $Y / Withdrawn: $Z"
  // and clarify the returns method. The provider itself stays pure and
  // unaware of the API contract — context lives at the route boundary.
  if (EQUITY_PROVIDER_MODE === 'snapshot-twr') {
    const balanceEvents = await prisma.balanceEvent.findMany({
      where: { walletAddress },
      select: { eventType: true, amount: true },
    });
    let totalDeposited = 0;
    let totalWithdrawn = 0;
    for (const ev of balanceEvents) {
      const lower = ev.eventType.toLowerCase();
      if (lower.includes('deposit')) totalDeposited += Math.abs(ev.amount);
      else if (lower.includes('withdraw')) totalWithdrawn += Math.abs(ev.amount);
    }
    result.data = {
      ...(result.data ?? {}),
      cashFlowSummary: {
        totalDeposited: round2(totalDeposited),
        totalWithdrawn: round2(totalWithdrawn),
        startingCapitalSource:
          // If the snapshot-twr provider produced a non-zero startingCapital
          // we can attribute it to Pacifica equity history; else it came from
          // the deposits-sum or the $10k floor fallback.
          (result.data?.startingCapital ?? 0) > 0 ? 'pacifica' : 'fallback',
      },
      returnsMethod: 'twr',
      provider: 'snapshot-twr',
    };
  }

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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}