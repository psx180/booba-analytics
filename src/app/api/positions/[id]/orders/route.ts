import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth, requireOwnedPosition } from '@/lib/api-auth';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
  const { id } = await params;

  const owned = await requireOwnedPosition(walletAddress, id);
  if (!owned.ok) return owned.response;

  const position = await prisma.position.findUnique({
    where: { id },
    select: { averageEntryPrice: true, direction: true },
  });

  const orders = await prisma.orderGroup.findMany({
    where: { positionId: id },
    include: {
      _count: { select: { trades: true } },
      trades: {
        select: { rawData: true, exitPrice: true, pnlRealized: true },
        take: 1,
      },
    },
    orderBy: { firstEntryTime: 'asc' },
  });

  // Augment each order with role and execution type from raw data
  const augmented = orders.map((order) => {
    const firstFill = order.trades[0];
    const raw = firstFill?.rawData ? JSON.parse(firstFill.rawData) : {};
    const side: string = raw.side ?? '';

    // Determine order role
    let role: string;
    if (side.startsWith('open_')) {
      role = 'entry';
    } else if (side.startsWith('close_')) {
      const hasStopParent = raw.stop_parent_order_id != null;
      if (hasStopParent) {
        // TP or SL — determine by comparing exit price to position avg entry
        const exitPrice = firstFill?.exitPrice ?? 0;
        const avgEntry = position?.averageEntryPrice ?? 0;
        const isLong = position?.direction === 'long';

        if (isLong) {
          role = exitPrice >= avgEntry ? 'take profit' : 'stop loss';
        } else {
          role = exitPrice <= avgEntry ? 'take profit' : 'stop loss';
        }
      } else {
        role = 'manual close';
      }
    } else {
      role = 'unknown';
    }

    // Execution type from raw data
    const executionType: string | null = raw.order_type ?? raw.type ?? null;

    const { trades: _trades, ...orderData } = order;
    return {
      ...orderData,
      role,
      executionType,
      isEntry: side.startsWith('open_'),
    };
  });

  return NextResponse.json({ orders: augmented });
  });
}
