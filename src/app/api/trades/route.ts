import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Prisma } from '../../../../generated/prisma/client';
import { withAuth } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
  const sp = req.nextUrl.searchParams;

  // Filters
  const regime = sp.get('regime');
  const tradeType = sp.get('tradeType');
  const strategy = sp.get('strategy');
  const source = sp.get('source');
  const asset = sp.get('asset');
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  // Pagination
  const page = Math.max(1, parseInt(sp.get('page') ?? '1'));
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') ?? '50')));

  // Sorting
  const sortBy = sp.get('sortBy') ?? 'exitTime';
  const sortDir = sp.get('sortDir') === 'asc' ? 'asc' : 'desc';

  const allowedSortFields: Record<string, true> = {
    exitTime: true, entryTime: true, pnlRealized: true,
    asset: true, fees: true, holdTimeSeconds: true,
  };
  const orderField = allowedSortFields[sortBy] ? sortBy : 'exitTime';

  const where: Prisma.TradeWhereInput = {
    walletAddress,
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

  const [total, trades] = await Promise.all([
    prisma.trade.count({ where }),
    prisma.trade.findMany({
      where,
      include: { strategy: { select: { name: true } } },
      orderBy: { [orderField]: sortDir },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return NextResponse.json({
    trades,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  });
  });
}
