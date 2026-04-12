import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth, requireOwnedOrderGroup } from '@/lib/api-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;

    const owned = await requireOwnedOrderGroup(walletAddress, id);
    if (!owned.ok) return owned.response;

    const fills = await prisma.trade.findMany({
      where: { orderGroupId: id },
      orderBy: { entryTime: 'asc' },
    });

    return NextResponse.json({ fills });
  });
}
