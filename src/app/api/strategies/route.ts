import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const [strategies, sourceTagRows] = await Promise.all([
      prisma.strategy.findMany({
        where: { walletAddress },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.position.findMany({
        where: { walletAddress, sourceTag: { not: null } },
        select: { sourceTag: true },
        distinct: ['sourceTag'],
      }),
    ]);

    const sourceTags = sourceTagRows
      .map((r) => r.sourceTag!)
      .filter(Boolean)
      .sort();

    return NextResponse.json({ strategies, sourceTags });
  });
}

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const { name } = await req.json();
    if (!name?.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const strategy = await prisma.strategy.create({
      data: { name: name.trim(), walletAddress },
      select: { id: true, name: true },
    });

    return NextResponse.json({ strategy });
  });
}
