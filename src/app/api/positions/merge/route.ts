import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth, requireOwnedPositions } from '@/lib/api-auth';
import { runCompute } from '@/services/compute-policy';

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

    // Fire and forget — don't await
    runCompute(walletAddress, 'mutation', merged?.journalId ?? undefined).catch((err) =>
      console.error('[compute-policy] Background fast compute failed:', err),
    );

    return NextResponse.json({ merged, undoData });
  });
}
