import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth } from '@/lib/api-auth';
import { runCompute } from '@/services/compute-policy';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const service = new GroupingService();
    const summary = await service.groupAllFills(walletAddress);

    // Fire and forget — grouping changed, re-run fast compute wallet-wide
    runCompute(walletAddress, 'mutation').catch((err) =>
      console.error('[compute-policy] Background fast compute failed:', err),
    );

    return NextResponse.json(summary);
  });
}
