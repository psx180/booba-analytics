import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth, requireOwnedPosition } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json();
    const { undoData } = body;

    if (!undoData?.targetId || !undoData?.orderAssignments) {
      return NextResponse.json({ error: 'undoData required' }, { status: 400 });
    }

    const owned = await requireOwnedPosition(walletAddress, undoData.targetId);
    if (!owned.ok) return owned.response;

    const service = new GroupingService();
    await service.undoMerge(undoData);

    return NextResponse.json({ success: true });
  });
}
