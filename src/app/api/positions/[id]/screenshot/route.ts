import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAuthenticatedWallet } from '@/lib/auth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const walletAddress = await getAuthenticatedWallet(req);
  if (!walletAddress) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const position = await prisma.position.findUnique({ where: { id } });
  if (!position) {
    return NextResponse.json({ error: 'Position not found' }, { status: 404 });
  }
  if (position.walletAddress !== walletAddress) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { screenshot } = body;

  if (!screenshot || typeof screenshot !== 'string') {
    return NextResponse.json({ error: 'Missing screenshot' }, { status: 400 });
  }

  const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024; // 2 MB
  if (screenshot.length > MAX_SCREENSHOT_BYTES) {
    return NextResponse.json({ error: 'Screenshot too large (max 2 MB)' }, { status: 413 });
  }

  await prisma.position.update({
    where: { id },
    data: { screenshot },
  });

  return NextResponse.json({ success: true });
}
