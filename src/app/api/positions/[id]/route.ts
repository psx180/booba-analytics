import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GroupingService } from '@/services/grouping';
import { POSITION_TYPES } from '@/services/grouping/types';
import type { PositionType } from '@/services/grouping/types';
import { withAuth, requireOwnedPosition } from '@/lib/api-auth';
import { runCompute } from '@/services/compute-policy';
import { runAndStoreAdherence } from '@/services/playbooks/adherence-service';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;

    const owned = await requireOwnedPosition(walletAddress, id);
    if (!owned.ok) return owned.response;

    const service = new GroupingService();
    await service.deletePosition(id);
    return NextResponse.json({ success: true });
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;

    const owned = await requireOwnedPosition(walletAddress, id);
    if (!owned.ok) return owned.response;

    // Re-fetch with the strategy relation so callers can display the strategy name.
    const position = await prisma.position.findUnique({
      where: { id },
      include: { strategy: { select: { id: true, name: true } } },
    });

    return NextResponse.json({ position });
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;
    const body = await req.json();

    const owned = await requireOwnedPosition(walletAddress, id);
    if (!owned.ok) return owned.response;

    const service = new GroupingService();

    if (body.tradeType) {
      if (!POSITION_TYPES.includes(body.tradeType as PositionType)) {
        return NextResponse.json(
          { error: `Invalid type. Valid: ${POSITION_TYPES.join(', ')}` },
          { status: 400 },
        );
      }
      const updated = await service.reclassifyPosition(id, body.tradeType);
      return NextResponse.json(updated);
    }

    // Annotation fields
    const annotationFields = [
      'thesis', 'strategyTag', 'sourceTag', 'conviction',
      'strategyId', 'invalidationPrice', 'targetPrice',
      'emotion', 'mistakes', 'playbookId', 'confirmation',
    ] as const;
    const updateData: Record<string, string | number | null> = {};
    for (const field of annotationFields) {
      if (field in body) {
        updateData[field] = body[field] as string | number | null;
      }
    }

    if (Object.keys(updateData).length > 0) {
      // When a playbook is being un-tagged, wipe the stored adherence too —
      // a stale score on an untagged position would show up in analytics and
      // confuse the user.
      if ('playbookId' in updateData && updateData.playbookId == null) {
        updateData.adherenceScore = null;
        updateData.adherenceDetail = null;
      }

      const updated = await prisma.position.update({
        where: { id },
        data: updateData,
      });

      // Re-run adherence when the playbook tag changed. Awaited so the
      // response reflects the fresh score, letting the UI render the
      // breakdown immediately after save.
      if ('playbookId' in updateData && updateData.playbookId != null) {
        try {
          await runAndStoreAdherence(id);
        } catch (err) {
          console.error('[playbook] adherence check failed:', err);
        }
      }

      // Fire and forget — annotations changed, re-run fast compute
      runCompute(walletAddress, 'mutation', updated.journalId ?? undefined).catch((err) =>
        console.error('[compute-policy] Background fast compute failed:', err),
      );

      // Re-read so the adherence fields round-trip to the client.
      const fresh = await prisma.position.findUnique({ where: { id } });
      return NextResponse.json(fresh);
    }

    return NextResponse.json({ error: 'No valid operation specified' }, { status: 400 });
  });
}
