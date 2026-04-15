import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth, requireOwnedPosition } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json();
    const { undoData } = body;

    if (!undoData?.targetId || !undoData?.orderAssignments) {
      return NextResponse.json({ error: 'undoData required' }, { status: 400 });
    }

    // Verify the caller owns the merge target
    const owned = await requireOwnedPosition(walletAddress, undoData.targetId);
    if (!owned.ok) return owned.response;

    // Verify all order groups referenced in orderAssignments currently belong
    // to the target position (which we already verified is owned). This prevents
    // an attacker from supplying order group IDs that belong to other users.
    const orderGroupIds = Object.keys(undoData.orderAssignments);
    if (orderGroupIds.length > 0) {
      const groups = await prisma.orderGroup.findMany({
        where: { id: { in: orderGroupIds } },
        select: { id: true, positionId: true },
      });
      const foreignGroups = groups.filter((g) => g.positionId !== undoData.targetId);
      if (foreignGroups.length > 0) {
        return NextResponse.json({ error: 'Forbidden: order group ownership mismatch' }, { status: 403 });
      }
    }

    const service = new GroupingService();
    await service.undoMerge(undoData, walletAddress);

    return NextResponse.json({ success: true });
  });
}
