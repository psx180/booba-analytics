import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { resolveJournalFilterId } from '@/lib/journals';
import { detectConvergentThemes } from '@/services/analytics/convergence';

/**
 * Convergence detection.
 *
 * Returns cross-detector themes (biggest leak, biggest strength, weekly focus)
 * derived from the summary + stored insights + what-if + walk-forward. Pure
 * meta-analysis — issues no new DB queries of its own.
 *
 * GET /api/analytics/convergence?journalId=X
 *
 * Returns ConvergenceResult. Wallet journals with fewer than 15 trades get an
 * empty `themes` array and `insufficientData: true`. Cached for 10 minutes.
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

    const result = await detectConvergentThemes(
      walletAddress,
      journalRes.id ?? undefined,
    );

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, max-age=600' },
    });
  });
}
