import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const tradeType = sp.get('tradeType');
  const asset = sp.get('asset');
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  // Check if positions exist — compute from TradeUnit view
  const positionCount = await prisma.position.count({ where: { walletAddress } });

  if (positionCount > 0) {
    return computeFromTradeUnits(walletAddress, { tradeType, asset, dateFrom, dateTo });
  }

  // Fallback to individual fills
  return computeFromFills(walletAddress, { tradeType, asset, dateFrom, dateTo });
}

async function computeFromTradeUnits(
  walletAddress: string,
  filters: { tradeType: string | null; asset: string | null; dateFrom: string | null; dateTo: string | null },
) {
  const dateFilter = (filters.dateFrom || filters.dateTo)
    ? {
        firstEntryTime: {
          ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
          ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
        },
      }
    : {};

  // Unlinked positions
  const positions = await prisma.position.findMany({
    where: {
      walletAddress,
      linkedStrategyId: null,
      status: 'closed',
      aggregatePnl: { not: null },
      ...(filters.tradeType ? { tradeType: filters.tradeType } : {}),
      ...(filters.asset ? { asset: filters.asset } : {}),
      ...dateFilter,
    },
    select: { aggregatePnl: true, lastExitTime: true, firstEntryTime: true },
    orderBy: { lastExitTime: 'asc' },
  });

  // Linked strategies
  const linkedStrategies = await prisma.linkedStrategy.findMany({
    where: {
      walletAddress,
      status: 'closed',
      combinedPnl: { not: null },
      ...(filters.tradeType ? { tradeType: filters.tradeType } : {}),
      ...dateFilter,
    },
    select: { combinedPnl: true, lastExitTime: true, firstEntryTime: true },
    orderBy: { lastExitTime: 'asc' },
  });

  // Merge into a single sorted list
  const tradeUnits = [
    ...positions.map((p) => ({ pnl: p.aggregatePnl!, exitTime: p.lastExitTime })),
    ...linkedStrategies.map((ls) => ({ pnl: ls.combinedPnl!, exitTime: ls.lastExitTime })),
  ].sort((a, b) => (a.exitTime?.getTime() ?? 0) - (b.exitTime?.getTime() ?? 0));

  return buildSummaryResponse(tradeUnits);
}

async function computeFromFills(
  walletAddress: string,
  filters: { tradeType: string | null; asset: string | null; dateFrom: string | null; dateTo: string | null },
) {
  const trades = await prisma.trade.findMany({
    where: {
      walletAddress,
      pnlRealized: { not: null },
      exitTime: { not: null },
      ...(filters.tradeType ? { tradeType: filters.tradeType } : {}),
      ...(filters.asset ? { asset: filters.asset } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? {
            exitTime: {
              ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
              ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
            },
          }
        : {}),
    },
    select: { pnlRealized: true, exitTime: true },
    orderBy: { exitTime: 'asc' },
  });

  const tradeUnits = trades.map((t) => ({ pnl: t.pnlRealized!, exitTime: t.exitTime }));
  return buildSummaryResponse(tradeUnits);
}

function buildSummaryResponse(tradeUnits: { pnl: number; exitTime: Date | null }[]) {
  if (tradeUnits.length === 0) {
    return Response.json({
      tradeCount: 0, totalPnl: 0, winRate: 0, expectancy: 0, profitFactor: 0, equityCurve: [],
    });
  }

  let totalPnl = 0;
  let wins = 0;
  let grossWins = 0;
  let grossLosses = 0;
  const equityCurve: { date: string; cumulativePnl: number }[] = [];

  for (const t of tradeUnits) {
    totalPnl += t.pnl;
    if (t.pnl > 0) { wins++; grossWins += t.pnl; }
    else if (t.pnl < 0) { grossLosses += Math.abs(t.pnl); }
    if (t.exitTime) {
      equityCurve.push({
        date: t.exitTime.toISOString(),
        cumulativePnl: Math.round(totalPnl * 100) / 100,
      });
    }
  }

  const tradeCount = tradeUnits.length;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;
  const expectancy = tradeCount > 0 ? totalPnl / tradeCount : 0;
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  return Response.json({
    tradeCount,
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate: Math.round(winRate * 10000) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    profitFactor: isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 999,
    equityCurve,
  });
}
