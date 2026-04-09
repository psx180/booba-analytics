import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const fills = await prisma.trade.findMany({
    where: { orderGroupId: id },
    orderBy: { entryTime: 'asc' },
  });

  return NextResponse.json({ fills });
}
