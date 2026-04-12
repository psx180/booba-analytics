import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const where = {
      walletAddress,
      thesis: null,
      emotion: null,
      strategyId: null,
    } as const;

    const [count, rows] = await Promise.all([
      prisma.position.count({ where }),
      prisma.position.findMany({
        where,
        select: { id: true },
        orderBy: { firstEntryTime: 'desc' },
      }),
    ]);

    return NextResponse.json({ count, ids: rows.map((r) => r.id) });
  });
}
