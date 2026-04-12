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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const positionIds: string[] = Array.isArray(body.positionIds) ? body.positionIds : [];
  const targetJournalId: string | undefined = body.targetJournalId;

  if (positionIds.length === 0) {
    return NextResponse.json({ error: 'positionIds required' }, { status: 400 });
  }
  if (!targetJournalId) {
    return NextResponse.json({ error: 'targetJournalId required' }, { status: 400 });
  }

  const journal = await prisma.journal.findUnique({ where: { id: targetJournalId } });
  if (!journal) {
    return NextResponse.json({ error: 'Target journal not found' }, { status: 404 });
  }

  // Reject the call entirely if any position belongs to a different wallet —
  // moving cross-wallet would silently corrupt the wallet → journal mapping.
  const positions = await prisma.position.findMany({
    where: { id: { in: positionIds } },
    select: { id: true, walletAddress: true },
  });
  if (positions.length !== positionIds.length) {
    return NextResponse.json({ error: 'One or more positions not found' }, { status: 404 });
  }
  const mismatched = positions.filter((p) => p.walletAddress !== journal.walletAddress);
  if (mismatched.length > 0) {
    return NextResponse.json(
      {
        error: 'Cannot move positions across wallets',
        mismatchedPositionIds: mismatched.map((p) => p.id),
      },
      { status: 400 },
    );
  }

  const result = await prisma.position.updateMany({
    where: { id: { in: positionIds } },
    data: { journalId: targetJournalId },
  });

  return NextResponse.json({ moved: result.count, targetJournalId });
}
