import { NextRequest, NextResponse } from 'next/server';
import { detectSyndromes } from '@/services/analytics/syndromes/syndrome-detector';
import { resolveJournalFilterId } from '@/lib/journals';
import { withAuth } from '@/lib/api-auth';

/**
 * GET — return the cross-signal behavioural-syndrome diagnoses for the
 * authenticated wallet. Pure synthesis over already-stored insight data;
 * runs no statistical tests of its own.
 */
export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const sp = req.nextUrl.searchParams;
    const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
    if (!journalRes.valid) {
      return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
    }
    const result = await detectSyndromes(walletAddress, journalRes.id ?? undefined);
    return NextResponse.json(result);
  });
}
