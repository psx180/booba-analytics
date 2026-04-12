import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { STRATEGY_TYPES } from '@/services/grouping/types';
import type { StrategyType } from '@/services/grouping/types';
import { withAuth, requireOwnedPositions } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json();
    const { positionIds, strategyType } = body;

    if (!positionIds || positionIds.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 positionIds' }, { status: 400 });
    }

    const owned = await requireOwnedPositions(walletAddress, positionIds);
    if (!owned.ok) return owned.response;

    if (!STRATEGY_TYPES.includes(strategyType as StrategyType)) {
      return NextResponse.json(
        { error: `Invalid strategyType. Valid: ${STRATEGY_TYPES.join(', ')}` },
        { status: 400 },
      );
    }

    const service = new GroupingService();
    const linked = await service.linkPositions(positionIds, strategyType as StrategyType);

    return NextResponse.json(linked);
  });
}
