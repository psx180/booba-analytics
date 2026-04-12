import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth, requireOwnedPosition } from '@/lib/api-auth';
import { runCompute } from '@/services/compute-policy';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json();
    const { positionId, splitTime } = body;

    if (!positionId || !splitTime) {
      return NextResponse.json({ error: 'positionId and splitTime required' }, { status: 400 });
    }

    const owned = await requireOwnedPosition(walletAddress, positionId);
    if (!owned.ok) return owned.response;

    const service = new GroupingService();
    const [pos1, pos2] = await service.splitPosition(positionId, new Date(splitTime));

    // Fire and forget — don't await
    runCompute(walletAddress, 'mutation', pos1?.journalId ?? undefined).catch((err) =>
      console.error('[compute-policy] Background fast compute failed:', err),
    );

    return NextResponse.json({ positions: [pos1, pos2] });
  });
}
