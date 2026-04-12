/**
 * POST /api/positions/move-journal
 *
 * Body: { positionIds: string[], targetJournalId: string }
 *
 * Reassigns the journalId of every position in the list to targetJournalId.
 * Used by the trades-page row menus and the multi-select toolbar.
 *
 * Validation:
 *   - The target journal must exist.
 *   - Every position must belong to the same wallet as the target journal —
 *     a journal can only contain its owning wallet's positions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth, requireOwnedPositions, requireOwnedJournal } from '@/lib/api-auth';
import { runCompute } from '@/services/compute-policy';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const body = await req.json().catch(() => ({}));
    const positionIds: string[] = Array.isArray(body.positionIds) ? body.positionIds : [];
    const targetJournalId: string | undefined = body.targetJournalId;

    if (positionIds.length === 0) {
      return NextResponse.json({ error: 'positionIds required' }, { status: 400 });
    }
    if (!targetJournalId) {
      return NextResponse.json({ error: 'targetJournalId required' }, { status: 400 });
    }

    const ownedJournal = await requireOwnedJournal(walletAddress, targetJournalId);
    if (!ownedJournal.ok) return ownedJournal.response;

    const ownedPositions = await requireOwnedPositions(walletAddress, positionIds);
    if (!ownedPositions.ok) return ownedPositions.response;

    const result = await prisma.position.updateMany({
      where: { id: { in: positionIds } },
      data: { journalId: targetJournalId },
    });

    // Fire and forget — positions moved between journals, re-run fast compute on target
    runCompute(walletAddress, 'mutation', targetJournalId).catch((err) =>
      console.error('[compute-policy] Background fast compute failed:', err),
    );

    return NextResponse.json({ moved: result.count, targetJournalId });
  });
}
