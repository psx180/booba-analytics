import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';
import { withAuth, requireOwnedLinkedStrategy } from '@/lib/api-auth';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (walletAddress) => {
    const { id } = await params;

    const owned = await requireOwnedLinkedStrategy(walletAddress, id);
    if (!owned.ok) return owned.response;

    const service = new GroupingService();
    await service.unlinkStrategy(id);

    return NextResponse.json({ success: true });
  });
}
