import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { groupIds, linkType } = body;

  if (!groupIds || groupIds.length < 2) {
    return NextResponse.json({ error: 'Need at least 2 groupIds' }, { status: 400 });
  }

  if (linkType !== 'delta_neutral' && linkType !== 'pairs_trade') {
    return NextResponse.json({ error: 'linkType must be delta_neutral or pairs_trade' }, { status: 400 });
  }

  const service = new GroupingService();
  const linked = await service.linkGroups(groupIds, linkType);

  return NextResponse.json({ groups: linked });
}