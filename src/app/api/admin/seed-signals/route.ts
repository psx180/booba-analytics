import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const { seedSignals } = await import('@/scripts/seed-signals-fn');
    const result = await seedSignals(walletAddress);
    return NextResponse.json(result);
  });
}

export async function DELETE(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const { prisma } = await import('@/lib/prisma');
    const result = await prisma.signal.deleteMany({ where: { walletAddress } });
    return NextResponse.json({ deleted: result.count });
  });
}
