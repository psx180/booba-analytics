import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const walletAddress = body.walletAddress;

  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  const service = new GroupingService();
  const summary = await service.groupAllFills(walletAddress);

  return NextResponse.json(summary);
}
