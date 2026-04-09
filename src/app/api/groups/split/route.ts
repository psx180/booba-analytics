import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { groupId, splitTime } = body;

  if (!groupId || !splitTime) {
    return NextResponse.json({ error: 'groupId and splitTime required' }, { status: 400 });
  }

  const service = new GroupingService();
  const [group1, group2] = await service.splitGroup(groupId, new Date(splitTime));

  return NextResponse.json({ groups: [group1, group2] });
}