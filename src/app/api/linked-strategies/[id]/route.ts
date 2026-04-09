import { NextRequest, NextResponse } from 'next/server';
import { GroupingService } from '@/services/grouping';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const service = new GroupingService();
  await service.unlinkStrategy(id);

  return NextResponse.json({ success: true });
}
