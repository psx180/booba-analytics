import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { positionId, splitTime } = body;

  if (!positionId || !splitTime) {
    return NextResponse.json({ error: 'positionId and splitTime required' }, { status: 400 });
  }

  const service = new GroupingService();
  const [pos1, pos2] = await service.splitPosition(positionId, new Date(splitTime));

  return NextResponse.json({ positions: [pos1, pos2] });
}
