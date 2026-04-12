import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveJournalFilterId } from '@/lib/journals';

const ALL_REGIMES = [
  'trending_low_vol',
  'trending_high_vol',
  'ranging_low_vol',
  'ranging_high_vol',
  'transitional',
] as const;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }

  return computeFromPositions(walletAddress, journalRes.id);
}

async function computeFromPositions(walletAddress: string, journalId: string | null) {
  // Unlinked positions — they have regimeAtEntry directly. Scope by journal.
  const posWhere: any = {
    walletAddress,
    linkedStrategyId: null,
    status: 'closed',
    aggregatePnl: { not: null },
  };
  if (journalId) posWhere.journalId = journalId;
  const positions = await prisma.position.findMany({
    where: posWhere,
    select: { aggregatePnl: true, regimeAtEntry: true },
  });

  // Linked strategies — include only when at least one of their legs is in
  // the requested journal. The displayed regime still comes from the first
  // chronological leg, matching the previous behaviour.
  const lsWhere: any = { walletAddress, status: 'closed', combinedPnl: { not: null } };
  // When journal-scoped, only include strategies that have at least one leg in this journal.
  if (journalId) lsWhere.positions = { some: { journalId } };
  const linkedStrategies = await prisma.linkedStrategy.findMany({
    where: lsWhere,
    include: {
      positions: {
        select: { regimeAtEntry: true },
        orderBy: { firstEntryTime: 'asc' },
        take: 1,
      },
    },
  });

  const byRegime = initRegimeBuckets();

  for (const p of positions) {
    addToBucket(byRegime, p.regimeAtEntry, p.aggregatePnl ?? 0);
  }

  for (const ls of linkedStrategies) {
    const regime = ls.positions[0]?.regimeAtEntry ?? null;
    addToBucket(byRegime, regime, ls.combinedPnl ?? 0);
  }

  return formatResult(byRegime);
}

type RegimeBucket = { tradeCount: number; wins: number; totalPnl: number; grossWins: number; grossLosses: number };

function initRegimeBuckets(): Record<string, RegimeBucket> {
  const buckets: Record<string, RegimeBucket> = {};
  for (const r of ALL_REGIMES) {
    buckets[r] = { tradeCount: 0, wins: 0, totalPnl: 0, grossWins: 0, grossLosses: 0 };
  }
  buckets['unknown'] = { tradeCount: 0, wins: 0, totalPnl: 0, grossWins: 0, grossLosses: 0 };
  return buckets;
}

function addToBucket(byRegime: Record<string, RegimeBucket>, regime: string | null, pnl: number) {
  const r = regime ?? 'unknown';
  if (!byRegime[r]) byRegime[r] = { tradeCount: 0, wins: 0, totalPnl: 0, grossWins: 0, grossLosses: 0 };
  const bucket = byRegime[r];
  bucket.tradeCount++;
  bucket.totalPnl += pnl;
  if (pnl > 0) { bucket.wins++; bucket.grossWins += pnl; }
  else if (pnl < 0) { bucket.grossLosses += Math.abs(pnl); }
}

function formatResult(byRegime: Record<string, RegimeBucket>) {
  const result = Object.entries(byRegime).map(([regime, stats]) => ({
    regime,
    tradeCount: stats.tradeCount,
    totalPnl: Math.round(stats.totalPnl * 100) / 100,
    winRate: stats.tradeCount > 0 ? Math.round((stats.wins / stats.tradeCount) * 10000) / 100 : 0,
    expectancy: stats.tradeCount > 0 ? Math.round((stats.totalPnl / stats.tradeCount) * 100) / 100 : 0,
    profitFactor: stats.grossLosses > 0
      ? Math.round((stats.grossWins / stats.grossLosses) * 100) / 100
      : stats.grossWins > 0 ? 999 : 0,
  }));

  return Response.json({ regimes: result });
}
