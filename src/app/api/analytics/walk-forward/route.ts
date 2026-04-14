import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { resolveJournalFilterId } from '@/lib/journals';
import { prisma } from '@/lib/prisma';
import { computeWalkForward } from '@/services/analytics/walk-forward';

/**
 * Walk-forward validation.
 *
 * Splits the trade history into equal-count windows and computes performance
 * metrics per window, then checks whether edge persists or has decayed.
 *
 * GET /api/analytics/walk-forward?journalId=X
 *
 * Returns WalkForwardResult, or 422 if fewer than 30 closed trades exist.
 * Cached for 5 minutes.
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

    const result = await computeWalkForward(
      prisma as any,
      walletAddress,
      journalRes.id ?? undefined,
    );

    if (result === null) {
      return NextResponse.json(
        { error: 'Walk-forward validation requires at least 30 trades.' },
        { status: 422 },
      );
    }

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  });
}
