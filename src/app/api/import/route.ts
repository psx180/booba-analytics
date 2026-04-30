/**
 * POST /api/import
 *
 * Runs the trade-import pipeline for the authenticated wallet.
 *
 * The actual pipeline body lives in `src/services/import/import-pipeline.ts`
 * so the public report-generation endpoint can reuse it. This route just
 * does the auth + body parsing wrapper.
 *
 * Body (optional):
 *   { regimes?: boolean, journalId?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { runImportPipeline } from '@/services/import/import-pipeline';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json().catch(() => ({}));
    const withRegimes = body.regimes !== false;
    const targetJournalId: string | undefined =
      typeof body.journalId === 'string' ? body.journalId : undefined;
    const network = req.headers.get('X-Pacifica-Network') === 'testnet' ? 'testnet' : 'mainnet';

    // Dashboard import: slow analytics tier is fire-and-forget so the user
    // lands on the dashboard fast. The dashboard banner polls analyticsStatus
    // and clears itself once the background compute sets status='ready'.
    const { summary, steps } = await runImportPipeline(walletAddress, {
      awaitSlowTier: false,
      withRegimes,
      targetJournalId,
      network,
    });

    return NextResponse.json({ summary, steps });
  });
}
