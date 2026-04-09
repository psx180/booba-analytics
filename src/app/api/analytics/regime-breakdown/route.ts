import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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

  const trades = await prisma.trade.findMany({
    where: {
      walletAddress,
      pnlRealized: { not: null },
      exitTime: { not: null },
    },
    select: { pnlRealized: true, regimeAtEntry: true },
  });

  const byRegime: Record<string, { tradeCount: number; wins: number; totalPnl: number; grossWins: number; grossLosses: number }> = {};

  for (const regime of ALL_REGIMES) {
    byRegime[regime] = { tradeCount: 0, wins: 0, totalPnl: 0, grossWins: 0, grossLosses: 0 };
  }
  byRegime['unknown'] = { tradeCount: 0, wins: 0, totalPnl: 0, grossWins: 0, grossLosses: 0 };

  for (const t of trades) {
    const r = t.regimeAtEntry ?? 'unknown';
    if (!byRegime[r]) byRegime[r] = { tradeCount: 0, wins: 0, totalPnl: 0, grossWins: 0, grossLosses: 0 };
    const bucket = byRegime[r];
    const pnl = t.pnlRealized ?? 0;
    bucket.tradeCount++;
    bucket.totalPnl += pnl;
    if (pnl > 0) { bucket.wins++; bucket.grossWins += pnl; }
    else if (pnl < 0) { bucket.grossLosses += Math.abs(pnl); }
  }

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

  return NextResponse.json({ regimes: result });
}
