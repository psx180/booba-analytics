/**
 * POST /api/journals/:id/assign
 *
 * Body: { filter: { asset?, subaccount?, tradeType?, regime?, dateFrom?, dateTo? } }
 *
 * Bulk-assigns every position in the wallet matching the filter into this
 * journal. The user-facing flow: "put all my BTC trades in a separate
 * journal" — one click instead of selecting and moving each row.
 *
 * Filter dimensions accepted:
 *   asset       — exact match on Position.asset
 *   subaccount  — match positions whose underlying fills include this
 *                 subaccount tag (Trade.subaccount)
 *   tradeType   — exact match on Position.tradeType
 *   regime      — exact match on Position.regimeAtEntry
 *   dateFrom    — Position.firstEntryTime >= dateFrom
 *   dateTo      — Position.firstEntryTime <= dateTo
 *
 * Subaccount is the one dimension that doesn't live on Position directly —
 * it's recorded per fill on Trade. We resolve it via OrderGroup → Trade so
 * we don't have to add a denormalised column to Position just for this.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

interface AssignFilter {
  asset?: string;
  subaccount?: string;
  tradeType?: string;
  regime?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const filter: AssignFilter = body?.filter ?? {};

  const journal = await prisma.journal.findUnique({ where: { id } });
  if (!journal) {
    return NextResponse.json({ error: 'Journal not found' }, { status: 404 });
  }

  // No filter = no-op rather than "assign all positions to this journal";
  // the user can use the move-journal endpoint with explicit ids if they
  // really want to bulk-assign every position.
  const hasAnyFilter =
    !!filter.asset ||
    !!filter.subaccount ||
    !!filter.tradeType ||
    !!filter.regime ||
    !!filter.dateFrom ||
    !!filter.dateTo;
  if (!hasAnyFilter) {
    return NextResponse.json({ error: 'filter must specify at least one dimension' }, { status: 400 });
  }

  const where: Record<string, unknown> = { walletAddress: journal.walletAddress };

  if (filter.asset) where.asset = filter.asset;
  if (filter.tradeType) where.tradeType = filter.tradeType;
  if (filter.regime) where.regimeAtEntry = filter.regime;
  if (filter.dateFrom || filter.dateTo) {
    where.firstEntryTime = {
      ...(filter.dateFrom ? { gte: new Date(filter.dateFrom) } : {}),
      ...(filter.dateTo ? { lte: new Date(filter.dateTo) } : {}),
    };
  }

  // Subaccount lives on Trade (the fill table). A position counts if any of
  // its fills carry the matching subaccount tag — we walk the relation chain
  // (position → orderGroups → trades) so we don't have to denormalise.
  if (filter.subaccount) {
    where.orderGroups = {
      some: {
        trades: { some: { subaccount: filter.subaccount } },
      },
    };
  }

  const result = await prisma.position.updateMany({
    where: where as any,
    data: { journalId: id },
  });

  return NextResponse.json({ assigned: result.count, journalId: id });
}
