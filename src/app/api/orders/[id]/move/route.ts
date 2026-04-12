import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth, requireOwnedOrderGroup, requireOwnedPosition } from '@/lib/api-auth';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id: orderGroupId } = await params;
    const body = await req.json();
    const { targetPositionId } = body;

    if (!targetPositionId) {
      return NextResponse.json({ error: 'targetPositionId required' }, { status: 400 });
    }

    const ownedOrder = await requireOwnedOrderGroup(walletAddress, orderGroupId);
    if (!ownedOrder.ok) return ownedOrder.response;

    const ownedTarget = await requireOwnedPosition(walletAddress, targetPositionId);
    if (!ownedTarget.ok) return ownedTarget.response;

    const service = new GroupingService();
    await service.moveOrderToPosition(orderGroupId, targetPositionId);

    return NextResponse.json({ success: true });
  });
}
