import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const service = new GroupingService();
    const summary = await service.groupAllFills(walletAddress);

    return NextResponse.json(summary);
  });
}
