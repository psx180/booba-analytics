/**
 * Single-journal endpoints.
 *
 *   GET    /api/journals/:id  — fetch one journal (with position count).
 *   PATCH  /api/journals/:id  — body: { name?, description?, filters? }
 *   DELETE /api/journals/:id  — delete a non-default journal. All positions
 *                               in it are reassigned to the wallet's default
 *                               journal (NOT deleted). The default journal
 *                               itself cannot be deleted.
 *
 * Insights stored against the deleted journal (BoobaObservation rows) are
 * also reassigned to the default journal — the underlying positions still
 * exist there and the analytics are still meaningful.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureDefaultJournal } from '@/lib/journals';
import { withAuth, requireOwnedJournal } from '@/lib/api-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;

    const owned = await requireOwnedJournal(walletAddress, id);
    if (!owned.ok) return owned.response;
    const journal = owned.journal;

    const withCount = await prisma.journal.findUnique({
      where: { id },
      include: { _count: { select: { positions: true } } },
    });

    return NextResponse.json({
      journal: {
        id: journal.id,
        walletAddress: journal.walletAddress,
        name: journal.name,
        description: journal.description,
        isDefault: journal.isDefault,
        filters: journal.filters,
        positionCount: withCount!._count.positions,
        createdAt: journal.createdAt.toISOString(),
        updatedAt: journal.updatedAt.toISOString(),
      },
    });
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const owned = await requireOwnedJournal(walletAddress, id);
    if (!owned.ok) return owned.response;

    // Build the update payload from only the fields the client actually sent;
    // missing keys are ignored (PATCH semantics).
    const updateData: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim().length > 0) {
      updateData.name = body.name.trim();
    }
    if ('description' in body) {
      updateData.description = body.description ?? null;
    }
    if ('filters' in body) {
      updateData.filters =
        body.filters == null
          ? null
          : typeof body.filters === 'string'
          ? body.filters
          : JSON.stringify(body.filters);
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'no editable fields supplied' }, { status: 400 });
    }

    const updated = await prisma.journal.update({
      where: { id },
      data: updateData,
    });
    return NextResponse.json({ journal: updated });
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;

    const owned = await requireOwnedJournal(walletAddress, id);
    if (!owned.ok) return owned.response;
    const journal = owned.journal;

    if (journal.isDefault) {
      return NextResponse.json(
        { error: 'Cannot delete the default journal' },
        { status: 400 },
      );
    }

    // Make sure the destination journal exists. ensureDefaultJournal is
    // idempotent, so this just returns the existing one in normal cases.
    const def = await ensureDefaultJournal(journal.walletAddress);

    // Move positions and observations onto the default journal in a single
    // transaction so a partial delete can't leave dangling FK references.
    const result = await prisma.$transaction(async (tx) => {
      const movedPositions = await tx.position.updateMany({
        where: { journalId: id },
        data: { journalId: def.id },
      });
      const movedObservations = await tx.boobaObservation.updateMany({
        where: { journalId: id },
        data: { journalId: def.id },
      });
      await tx.journal.delete({ where: { id } });
      return {
        movedPositions: movedPositions.count,
        movedObservations: movedObservations.count,
      };
    });

    return NextResponse.json({ success: true, ...result });
  });
}
