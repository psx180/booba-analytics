import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { TRADE_TYPES } from '@/services/grouping/types';
import type { TradeType } from '@/services/grouping/types';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();

  const service = new GroupingService();

  // Reclassify
  if (body.tradeType) {
    if (!TRADE_TYPES.includes(body.tradeType as TradeType)) {
      return NextResponse.json({ error: `Invalid trade type. Valid: ${TRADE_TYPES.join(', ')}` }, { status: 400 });
    }
    const updated = await service.reclassifyGroup(id, body.tradeType as TradeType);
    return NextResponse.json(updated);
  }

  // Move fill
  if (body.moveFillId) {
    await service.moveFillToGroup(body.moveFillId, id);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'No valid operation specified' }, { status: 400 });
}