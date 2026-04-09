import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '../../../../../generated/prisma/client';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const regime = sp.get('regime');
  const tradeType = sp.get('tradeType');
  const strategy = sp.get('strategy');
  const asset = sp.get('asset');
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  // Check if groups exist for this wallet — if so, compute from groups
  const groupCount = await prisma.tradeGroup.count({ where: { walletAddress } });

  if (groupCount > 0) {
    return computeFromGroups(walletAddress, { tradeType, strategy, asset, dateFrom, dateTo });
  }

  // Fallback to computing from individual fills (pre-grouping)
  return computeFromFills(walletAddress, { regime, tradeType, strategy, asset, dateFrom, dateTo });
}

async function computeFromGroups(
  walletAddress: string,
  filters: { tradeType: string | null; strategy: string | null; asset: string | null; dateFrom: string | null; dateTo: string | null },
) {
  const where: Prisma.TradeGroupWhereInput = {
    walletAddress,
    status: 'closed',
    aggregatePnl: { not: null },
    ...(filters.tradeType ? { tradeType: filters.tradeType } : {}),
    ...(filters.strategy ? { strategy: { name: filters.strategy } } : {}),
    ...(filters.asset ? { asset: filters.asset } : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          lastExitTime: {
            ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
            ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
          },
        }
      : {}),
  };

  const groups = await prisma.tradeGroup.findMany({
    where,
    select: { aggregatePnl: true, lastExitTime: true },
    orderBy: { lastExitTime: 'asc' },
  });

  if (groups.length === 0) {
    return Response.json({
      tradeCount: 0,
      totalPnl: 0,
      winRate: 0,
      expectancy: 0,
      profitFactor: 0,
      equityCurve: [],
    });
  }

  let totalPnl = 0;
  let wins = 0;
  let grossWins = 0;
  let grossLosses = 0;
  const equityCurve: { date: string; cumulativePnl: number }[] = [];

  for (const g of groups) {
    const pnl = g.aggregatePnl ?? 0;
    totalPnl += pnl;
    if (pnl > 0) { wins++; grossWins += pnl; }
    else if (pnl < 0) { grossLosses += Math.abs(pnl); }
    if (g.lastExitTime) {
      equityCurve.push({
        date: g.lastExitTime.toISOString(),
        cumulativePnl: Math.round(totalPnl * 100) / 100,
      });
    }
  }

  const tradeCount = groups.length;
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

async function computeFromFills(
  walletAddress: string,
  filters: { regime: string | null; tradeType: string | null; strategy: string | null; asset: string | null; dateFrom: string | null; dateTo: string | null },
) {
  const where: Prisma.TradeWhereInput = {
    walletAddress,
    pnlRealized: { not: null },
    exitTime: { not: null },
    ...(filters.regime ? { regimeAtEntry: filters.regime } : {}),
    ...(filters.tradeType ? { tradeType: filters.tradeType } : {}),
    ...(filters.strategy ? { strategy: { name: filters.strategy } } : {}),
    ...(filters.asset ? { asset: filters.asset } : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          exitTime: {
            ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
            ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
          },
        }
      : {}),
  };

  const trades = await prisma.trade.findMany({
    where,
    select: { pnlRealized: true, exitTime: true, fees: true },
    orderBy: { exitTime: 'asc' },
  });

  if (trades.length === 0) {
    return Response.json({
      tradeCount: 0,
      totalPnl: 0,
      winRate: 0,
      expectancy: 0,
      profitFactor: 0,
      equityCurve: [],
    });
  }

  let totalPnl = 0;
  let wins = 0;
  let grossWins = 0;
  let grossLosses = 0;
  const equityCurve: { date: string; cumulativePnl: number }[] = [];

  for (const t of trades) {
    const pnl = t.pnlRealized ?? 0;
    totalPnl += pnl;
    if (pnl > 0) { wins++; grossWins += pnl; }
    else if (pnl < 0) { grossLosses += Math.abs(pnl); }
    equityCurve.push({
      date: t.exitTime!.toISOString(),
      cumulativePnl: Math.round(totalPnl * 100) / 100,
    });
  }

  const tradeCount = trades.length;
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
