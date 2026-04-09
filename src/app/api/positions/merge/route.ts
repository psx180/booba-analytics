import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const positionIds: string[] = body.positionIds;

  if (!positionIds || positionIds.length < 2) {
    return NextResponse.json({ error: 'Need at least 2 positionIds' }, { status: 400 });
  }

  const service = new GroupingService();
  const merged = await service.mergePositions(positionIds);

  return NextResponse.json(merged);
}
