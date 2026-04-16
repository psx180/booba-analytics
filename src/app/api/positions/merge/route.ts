import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth, requireOwnedPositions } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import { timingComputer } from '@/services/analytics/metrics/timing';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json();
    const positionIds: string[] = body.positionIds;

    if (!positionIds || positionIds.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 positionIds' }, { status: 400 });
    }

    const owned = await requireOwnedPositions(walletAddress, positionIds);
    if (!owned.ok) return owned.response;

    const service = new GroupingService();
    const { merged, undoData } = await service.mergePositions(positionIds);

    // Scoped fast metrics: run only the per-position (non-batch) timing computer
    // on the single merged position. Skip Elo, xPnL, and insight detectors —
    // they require full-history context and run on the next sync or manual trigger.
    // This keeps merge well under 1 second vs. the previous wallet-wide scan.
    if (merged) {
      const updates = timingComputer.compute(merged as any);
      const nonNull = Object.fromEntries(Object.entries(updates).filter(([, v]) => v != null));
      if (Object.keys(nonNull).length > 0) {
        prisma.position
          .update({ where: { id: merged.id }, data: nonNull })
          .catch((err) => console.error('[merge] timing update failed:', err));
      }
    }

    return NextResponse.json({ merged, undoData });
  });
}
