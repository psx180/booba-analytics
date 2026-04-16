import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth, requireOwnedPosition } from '@/lib/api-auth';
import { runCompute } from '@/services/compute-policy';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;
    const body = await req.json();

    const owned = await requireOwnedPosition(walletAddress, id);
    if (!owned.ok) return owned.response;

    // null clears the override; any string sets it
    if (!('manualTradeType' in body)) {
      return NextResponse.json(
        { error: 'Request body must include manualTradeType (string or null)' },
        { status: 400 },
      );
    }

    const { manualTradeType } = body as { manualTradeType: string | null };

    const updated = await prisma.position.update({
      where: { id },
      data: { manualTradeType: manualTradeType ?? null },
    });

    // Fire-and-forget recompute so analytics see the updated effective type
    runCompute(walletAddress, 'mutation', updated.journalId ?? undefined).catch((err) =>
      console.error('[compute-policy] Background fast compute failed:', err),
    );

    return NextResponse.json(updated);
  });
}
