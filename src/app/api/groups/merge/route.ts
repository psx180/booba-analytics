import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const groupIds: string[] = body.groupIds;

  if (!groupIds || groupIds.length < 2) {
    return NextResponse.json({ error: 'Need at least 2 groupIds' }, { status: 400 });
  }

  const service = new GroupingService();
  const merged = await service.mergeGroups(groupIds);

  return NextResponse.json(merged);
}