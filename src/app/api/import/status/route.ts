/**
 * GET /api/import/status
 *
 * Returns the current import progress for the authenticated wallet.
 * The client polls this every 2 seconds while POST /api/import is running.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { getProgress } from '../progress-store';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const progress = getProgress(walletAddress);
    if (!progress) {
      return NextResponse.json({
        stage: 'idle',
        message: 'No import in progress',
        fillsFetched: 0,
      });
    }
    return NextResponse.json(progress);
  });
}
