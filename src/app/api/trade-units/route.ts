import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveJournalFilterId } from '@/lib/journals';
import { withAuth } from '@/lib/api-auth';

/**
 * GET /api/trade-units
 *
 * Returns the union view: unlinked positions + linked strategies.
 * This is the primary endpoint for the trades table.
 *
 * Journal scope: positions are filtered by journalId. Linked strategies are
 * included when *any* of their leg positions belong to the requested
 * journal — this matches the user's mental model that linked strategies
 * "follow" the journal containing at least one of their legs.
 */
export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
  const sp = req.nextUrl.searchParams;

  const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
  if (!journalRes.valid) {
    return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
  }
  const journalId = journalRes.id; // null = wallet-wide (no journalId filter)

  const tradeType = sp.get('tradeType');
  const asset = sp.get('asset');
  const status = sp.get('status');
  const minConfidence = sp.get('minConfidence');
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');

  const page = Math.max(1, parseInt(sp.get('page') ?? '1'));
  const pageSize = Math.min(1000, Math.max(1, parseInt(sp.get('pageSize') ?? '50')));
  const sortBy = sp.get('sortBy') ?? 'firstEntryTime';
  const sortDir = sp.get('sortDir') === 'asc' ? 'asc' : 'desc';

  // Fetch unlinked positions (positions not part of any linked strategy)
  const positionWhere: any = {
    walletAddress,
    linkedStrategyId: null,
    ...(journalId ? { journalId } : {}),
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
      take: 2000,
    }),
    prisma.linkedStrategy.findMany({
      where: {
        walletAddress,
        // When journal-scoped, include strategies with at least one leg in this journal.
        ...(journalId ? { positions: { some: { journalId } } } : {}),
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
    manualTradeType?: string | null;
    status: string;
    pnl: number | null;
    fees: number | null;
    funding: number | null;
    totalSize: number | null;
    averageEntryPrice: number | null;
    averageExitPrice: number | null;
    holdTimeSeconds: number | null;
    confidence: number | null;
    groupingConfirmed?: boolean;
    firstEntryTime: string | null;
    lastExitTime: string | null;
    regimeAtEntry: string | null;
    childCount: number;
    // Annotation fields (positions only)
    thesis?: string | null;
    strategyId?: string | null;
    emotion?: string | null;
    conviction?: number | null;
    sourceTag?: string | null;
    invalidationPrice?: number | null;
    targetPrice?: string | null;
    mistakes?: string | null;
    playbookId?: string | null;
    confirmation?: string | null;
    adherenceScore?: number | null;
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
      tradeType: p.manualTradeType ?? p.tradeType,
      manualTradeType: p.manualTradeType,
      status: p.status,
      pnl: p.aggregatePnl,
      fees: p.aggregateFees,
      funding: p.aggregateFunding,
      totalSize: p.totalSize,
      averageEntryPrice: p.averageEntryPrice,
      averageExitPrice: p.averageExitPrice,
      holdTimeSeconds: p.holdTimeSeconds,
      confidence: p.confidence,
      groupingConfirmed: p.groupingConfirmed,
      firstEntryTime: p.firstEntryTime?.toISOString() ?? null,
      lastExitTime: p.lastExitTime?.toISOString() ?? null,
      regimeAtEntry: p.regimeAtEntry,
      childCount: p._count.orderGroups,
      thesis: p.thesis,
      strategyId: p.strategyId,
      emotion: p.emotion,
      conviction: p.conviction,
      sourceTag: p.sourceTag,
      invalidationPrice: p.invalidationPrice,
      targetPrice: p.targetPrice,
      mistakes: p.mistakes,
      playbookId: p.playbookId,
      confirmation: p.confirmation,
      adherenceScore: p.adherenceScore,
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
  });
}
