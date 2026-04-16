import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { getGroupingProgress } from '../progress-store';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const progress = getGroupingProgress(walletAddress);
    if (!progress) {
      return NextResponse.json({ stage: 'idle', message: '', percent: 0 });
    }
    return NextResponse.json(progress);
  });
}
