import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { undoData } = body;

  if (!undoData?.targetId || !undoData?.orderAssignments) {
    return NextResponse.json({ error: 'undoData required' }, { status: 400 });
  }

  const service = new GroupingService();
  await service.undoMerge(undoData);

  return NextResponse.json({ success: true });
}
