import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/trade-units
 *
 * Returns the union view: unlinked positions + linked strategies.
 * This is the primary endpoint for the trades table.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const walletAddress = sp.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const tradeType = sp.get('tradeType');
  const asset = sp.get('asset');
  const status = sp.get('status');
  const minConfidence = sp.get('minConfidence');
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  const page = Math.max(1, parseInt(sp.get('page') ?? '1'));
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') ?? '50')));
  const sortBy = sp.get('sortBy') ?? 'firstEntryTime';
  const sortDir = sp.get('sortDir') === 'asc' ? 'asc' : 'desc';

  // Fetch unlinked positions (positions not part of any linked strategy)
  const positionWhere: any = {
    walletAddress,
    linkedStrategyId: null,
    ...(tradeType ? { tradeType } : {}),
    ...(asset ? { asset } : {}),
    ...(status ? { status } : {}),
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

  const [positions, linkedStrategies] = await Promise.all([
    prisma.position.findMany({
      where: positionWhere,
      include: { _count: { select: { orderGroups: true } } },
      orderBy: { [sortBy]: sortDir },
    }),
    prisma.linkedStrategy.findMany({
      where: {
        walletAddress,
        ...(status ? { status } : {}),
        ...(tradeType ? { tradeType } : {}),
        ...(dateFrom || dateTo
          ? {
              firstEntryTime: {
                ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                ...(dateTo ? { lte: new Date(dateTo) } : {}),
              },
            }
          : {}),
      },
      include: {
        positions: {
          select: { id: true, asset: true, direction: true, aggregatePnl: true, status: true },
        },
      },
    }),
  ]);

  // Build unified trade units
  type TradeUnitRow = {
    id: string;
    kind: 'position' | 'linked_strategy';
    asset: string;
    direction: string;
    tradeType: string | null;
    status: string;
    pnl: number | null;
    fees: number | null;
    funding: number | null;
    totalSize: number | null;
    averageEntryPrice: number | null;
    averageExitPrice: number | null;
    holdTimeSeconds: number | null;
    confidence: number | null;
    firstEntryTime: string | null;
    lastExitTime: string | null;
    regimeAtEntry: string | null;
    childCount: number;
    // Linked strategy extras
    strategyType?: string;
    netDelta?: number | null;
    spreadPnl?: number | null;
    legs?: { id: string; asset: string; direction: string; pnl: number | null; status: string }[];
  };

  const units: TradeUnitRow[] = [];

  for (const p of positions) {
    units.push({
      id: p.id,
      kind: 'position',
      asset: p.asset,
      direction: p.direction,
      tradeType: p.tradeType,
      status: p.status,
      pnl: p.aggregatePnl,
      fees: p.aggregateFees,
      funding: p.aggregateFunding,
      totalSize: p.totalSize,
      averageEntryPrice: p.averageEntryPrice,
      averageExitPrice: p.averageExitPrice,
      holdTimeSeconds: p.holdTimeSeconds,
      confidence: p.confidence,
      firstEntryTime: p.firstEntryTime?.toISOString() ?? null,
      lastExitTime: p.lastExitTime?.toISOString() ?? null,
      regimeAtEntry: p.regimeAtEntry,
      childCount: p._count.orderGroups,
    });
  }

  for (const ls of linkedStrategies) {
    // Filter by asset: match if ANY leg contains the asset
    if (asset && !ls.positions.some((p) => p.asset === asset)) continue;

    const assets = [...new Set(ls.positions.map((p) => p.asset))];
    units.push({
      id: ls.id,
      kind: 'linked_strategy',
      asset: assets.join(' / '),
      direction: ls.positions[0]?.direction ?? '—',
      tradeType: ls.tradeType ?? ls.strategyType,
      status: ls.status,
      pnl: ls.combinedPnl,
      fees: ls.combinedFees,
      funding: ls.combinedFunding,
      totalSize: null,
      averageEntryPrice: null,
      averageExitPrice: null,
      holdTimeSeconds: null,
      confidence: ls.confidence,
      firstEntryTime: ls.firstEntryTime?.toISOString() ?? null,
      lastExitTime: ls.lastExitTime?.toISOString() ?? null,
      regimeAtEntry: null,
      childCount: ls.positions.length,
      strategyType: ls.strategyType,
      netDelta: ls.netDelta,
      spreadPnl: ls.spreadPnl,
      legs: ls.positions.map((p) => ({
        id: p.id,
        asset: p.asset,
        direction: p.direction,
        pnl: p.aggregatePnl,
        status: p.status,
      })),
    });
  }

  // Sort the combined list
  const sortKey = sortBy as keyof TradeUnitRow;
  units.sort((a, b) => {
    const av = a[sortKey] ?? '';
    const bv = b[sortKey] ?? '';
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const total = units.length;
  const paged = units.slice((page - 1) * pageSize, page * pageSize);

  return NextResponse.json({
    tradeUnits: paged,
    pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  });
}
