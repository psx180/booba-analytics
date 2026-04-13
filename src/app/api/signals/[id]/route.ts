/**
 * PATCH /api/signals/[id] — Update a signal (link to position, manual close).
 *
 * Request: { positionId?: string, status?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

const ALLOWED_STATUSES = ['open', 'hit_target', 'hit_stop', 'expired', 'closed_manual'];

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await ctx.params;

    const signal = await prisma.signal.findUnique({ where: { id } });
    if (!signal) {
      return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
    }
    if (signal.walletAddress !== walletAddress) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    let body: { positionId?: string; status?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (body.status && !ALLOWED_STATUSES.includes(body.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` },
        { status: 400 },
      );
    }

    const updated = await prisma.signal.update({
      where: { id },
      data: {
        ...(body.positionId !== undefined ? { positionId: body.positionId } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.status && body.status !== 'open' && !signal.resolvedAt
          ? { resolvedAt: new Date() }
          : {}),
      },
    });

    return NextResponse.json({ signal: updated });
  });
}
