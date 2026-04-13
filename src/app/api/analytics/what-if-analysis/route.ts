import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { resolveJournalFilterId } from '@/lib/journals';
import { prisma } from '@/lib/prisma';
import { computeWhatIfCurves } from '@/services/analytics/what-if-curves';

/**
 * What-if equity curve analysis.
 *
 * Returns three counterfactual equity curves alongside the actual curve,
 * letting the user see what their cumulative P&L would have looked like
 * under optimal exits, consistent sizing, or regime filtering.
 *
 * GET /api/analytics/what-if-analysis?journalId=X
 *
 * Requires at least 10 closed positions with MFE data for the optimal-exits
 * curve. If not enough data, returns actualCurve only with nulls for the rest.
 */
export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const sp = req.nextUrl.searchParams;

    const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
    if (!journalRes.valid) {
      return NextResponse.json(
        { error: 'Journal not found for this wallet' },
        { status: 404 },
      );
    }

    const result = await computeWhatIfCurves(
      prisma as any,
      walletAddress,
      journalRes.id ?? undefined,
    );

    return NextResponse.json(result);
  });
}
