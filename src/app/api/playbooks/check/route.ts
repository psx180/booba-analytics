/**
 * POST /api/playbooks/check — run adherence against an arbitrary
 * position/playbook pair and return the breakdown.
 *
 * Used by the annotation popup to preview the score before the user
 * commits the tag, and by scripts (seed) that want to populate adherence
 * without going through the PATCH route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth, requireOwnedPosition } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import { checkAdherence } from '@/services/playbooks/adherence-service';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    let body: { positionId?: unknown; playbookId?: unknown; accountEquity?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (typeof body.positionId !== 'string' || typeof body.playbookId !== 'string') {
      return NextResponse.json({ error: 'positionId and playbookId are required' }, { status: 400 });
    }

    const owned = await requireOwnedPosition(walletAddress, body.positionId);
    if (!owned.ok) return owned.response;

    const playbook = await prisma.playbook.findUnique({ where: { id: body.playbookId } });
    if (!playbook) return NextResponse.json({ error: 'Playbook not found' }, { status: 404 });
    if (playbook.walletAddress !== walletAddress) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const accountEquity =
      typeof body.accountEquity === 'number' && Number.isFinite(body.accountEquity)
        ? body.accountEquity
        : undefined;

    const result = await checkAdherence(owned.position, playbook, { accountEquity });
    return NextResponse.json(result);
  });
}
