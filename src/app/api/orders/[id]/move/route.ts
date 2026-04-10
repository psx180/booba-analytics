import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orderGroupId } = await params;
  const body = await req.json();
  const { targetPositionId } = body;

  if (!targetPositionId) {
    return NextResponse.json({ error: 'targetPositionId required' }, { status: 400 });
  }

  const service = new GroupingService();
  await service.moveOrderToPosition(orderGroupId, targetPositionId);

  return NextResponse.json({ success: true });
}
