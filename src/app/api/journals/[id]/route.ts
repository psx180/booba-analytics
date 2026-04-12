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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const journal = await prisma.journal.findUnique({
    where: { id },
    include: { _count: { select: { positions: true } } },
  });

  if (!journal) {
    return NextResponse.json({ error: 'Journal not found' }, { status: 404 });
  }

  return NextResponse.json({
    journal: {
      id: journal.id,
      walletAddress: journal.walletAddress,
      name: journal.name,
      description: journal.description,
      isDefault: journal.isDefault,
      filters: journal.filters,
      positionCount: journal._count.positions,
      createdAt: journal.createdAt.toISOString(),
      updatedAt: journal.updatedAt.toISOString(),
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const journal = await prisma.journal.findUnique({ where: { id } });
  if (!journal) {
    return NextResponse.json({ error: 'Journal not found' }, { status: 404 });
  }

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
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const journal = await prisma.journal.findUnique({ where: { id } });
  if (!journal) {
    return NextResponse.json({ error: 'Journal not found' }, { status: 404 });
  }
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
}
