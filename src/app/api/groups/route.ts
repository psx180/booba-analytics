import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '../../../../generated/prisma/client';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  // Filters
  const tradeType = sp.get('tradeType');
  const asset = sp.get('asset');
  const status = sp.get('status');
  const minConfidence = sp.get('minConfidence');
  const ruleSource = sp.get('ruleSource');
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  // Pagination
  const page = Math.max(1, parseInt(sp.get('page') ?? '1'));
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') ?? '50')));

  // Sorting
  const sortBy = sp.get('sortBy') ?? 'firstEntryTime';
  const sortDir = sp.get('sortDir') === 'asc' ? 'asc' : 'desc';

  const allowedSortFields: Record<string, true> = {
    firstEntryTime: true, lastExitTime: true, aggregatePnl: true,
    asset: true, aggregateFees: true, holdTimeSeconds: true,
    confidence: true, totalSize: true,
  };
  const orderField = allowedSortFields[sortBy] ? sortBy : 'firstEntryTime';

  const where: Prisma.TradeGroupWhereInput = {
    walletAddress,
    ...(tradeType ? { tradeType } : {}),
    ...(asset ? { asset } : {}),
    ...(status ? { status } : {}),
    ...(ruleSource ? { ruleSource } : {}),
    ...(minConfidence ? { confidence: { gte: parseFloat(minConfidence) } } : {}),
    ...(dateFrom || dateTo
      ? {
          firstEntryTime: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(dateTo) } : {}),
          },
        }
      : {}),
  };

  const [total, groups] = await Promise.all([
    prisma.tradeGroup.count({ where }),
    prisma.tradeGroup.findMany({
      where,
      include: {
        strategy: { select: { name: true } },
        _count: { select: { trades: true } },
      },
      orderBy: { [orderField]: sortDir },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return NextResponse.json({
    groups,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  });
}
