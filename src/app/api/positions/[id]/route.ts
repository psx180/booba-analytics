import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { POSITION_TYPES } from '@/services/grouping/types';
import type { PositionType } from '@/services/grouping/types';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();
  const service = new GroupingService();

  if (body.tradeType) {
    if (!POSITION_TYPES.includes(body.tradeType as PositionType)) {
      return NextResponse.json(
        { error: `Invalid type. Valid: ${POSITION_TYPES.join(', ')}` },
        { status: 400 },
      );
    }
    const updated = await service.reclassifyPosition(id, body.tradeType);
    return NextResponse.json(updated);
  }

  return NextResponse.json({ error: 'No valid operation specified' }, { status: 400 });
}
