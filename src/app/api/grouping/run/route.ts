import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth } from '@/lib/api-auth';
import { runCompute } from '@/services/compute-policy';
import { setGroupingProgress, clearGroupingProgress } from '../progress-store';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    // Clear stale progress and mark as started so the client can begin polling.
    clearGroupingProgress(walletAddress);
    setGroupingProgress(walletAddress, { stage: 'running', message: 'Starting…', percent: 5 });

    // Kick off the full rebuild in a detached async function so the route
    // returns immediately. The client polls GET /api/grouping/status for updates.
    (async () => {
      try {
        const service = new GroupingService();
        const summary = await service.groupAllFills(walletAddress, (percent, message) => {
          setGroupingProgress(walletAddress, { stage: 'running', message, percent });
        });

        setGroupingProgress(walletAddress, {
          stage: 'running',
          message: 'Recomputing analytics…',
          percent: 80,
        });

        await runCompute(walletAddress, 'mutation');

        setGroupingProgress(walletAddress, {
          stage: 'done',
          message: `Done — ${summary.totalPositions} positions rebuilt.`,
          percent: 100,
        });
      } catch (err) {
        console.error('[grouping/run] Background reset failed:', err);
        setGroupingProgress(walletAddress, {
          stage: 'error',
          message: 'Reset failed. Please try again.',
          percent: 0,
        });
      }
    })();

    return NextResponse.json({ started: true });
  });
}
