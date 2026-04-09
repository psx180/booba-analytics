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
  const source = sp.get('source');
  const asset = sp.get('asset');
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  const where: Prisma.TradeWhereInput = {
    walletAddress,
    pnlRealized: { not: null },
    exitTime: { not: null },
    ...(regime ? { regimeAtEntry: regime } : {}),
    ...(tradeType ? { tradeType } : {}),
    ...(strategy ? { strategy: { name: strategy } } : {}),
    ...(source ? { sourceTag: source } : {}),
    ...(asset ? { asset } : {}),
    ...(dateFrom || dateTo
      ? {
          exitTime: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(dateTo) } : {}),
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
    return NextResponse.json({
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

  return NextResponse.json({
    tradeCount,
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate: Math.round(winRate * 10000) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    profitFactor: isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 999,
    equityCurve,
  });
}
