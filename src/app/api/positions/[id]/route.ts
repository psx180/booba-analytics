import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { GroupingService } from '@/services/grouping';
import { POSITION_TYPES } from '@/services/grouping/types';
import type { PositionType } from '@/services/grouping/types';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const position = await prisma.position.findUnique({
    where: { id },
  });

  if (!position) {
    return NextResponse.json({ error: 'Position not found' }, { status: 404 });
  }

  return NextResponse.json({ position });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();
  const service = new GroupingService();

  if (body.tradeType) {
    if (!POSITION_TYPES.includes(body.tradeType as PositionType)) {
      return NextResponse.json(
        { error: `Invalid type. Valid: ${POSITION_TYPES.join(', ')}` },
        { status: 400 },
      );
    }
    const updated = await service.reclassifyPosition(id, body.tradeType);
    return NextResponse.json(updated);
  }

  // Annotation fields: thesis, strategyTag, sourceTag, conviction
  const annotationFields = ['thesis', 'strategyTag', 'sourceTag', 'conviction'] as const;
  const updateData: Record<string, string | number | null> = {};
  for (const field of annotationFields) {
    if (field in body) {
      updateData[field] = body[field] as string | number | null;
    }
  }

  if (Object.keys(updateData).length > 0) {
    const updated = await prisma.position.update({
      where: { id },
      data: updateData,
    });
    return NextResponse.json(updated);
  }

  return NextResponse.json({ error: 'No valid operation specified' }, { status: 400 });
}
