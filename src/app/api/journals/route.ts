/**
 * Journal collection endpoints.
 *
 *   GET  /api/journals?walletAddress=X — list all journals for a wallet.
 *                                          The default journal is guaranteed
 *                                          to exist (created lazily on the
 *                                          first read for any wallet).
 *
 *   POST /api/journals                 — body: { walletAddress, name, description?, filters? }
 *                                          create a new journal. The first
 *                                          journal created for a wallet via
 *                                          POST is *not* automatically the
 *                                          default — that role belongs to
 *                                          "All Trades" which is seeded by
 *                                          ensureDefaultJournal().
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureDefaultJournal } from '@/lib/journals';

export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get('walletAddress');
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }

  // Make sure "All Trades" exists before listing — otherwise a brand-new
  // wallet would see an empty dropdown and have nothing selectable.
  await ensureDefaultJournal(walletAddress);

  const journals = await prisma.journal.findMany({
    where: { walletAddress },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    include: { _count: { select: { positions: true } } },
  });

  return NextResponse.json({
    journals: journals.map((j) => ({
      id: j.id,
      walletAddress: j.walletAddress,
      name: j.name,
      description: j.description,
      isDefault: j.isDefault,
      filters: j.filters,
      positionCount: j._count.positions,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { walletAddress, name, description, filters } = body as {
    walletAddress?: string;
    name?: string;
    description?: string;
    filters?: Record<string, unknown> | string | null;
  };

  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }

  // Ensure the wallet has a default journal so creating side journals never
  // leaves the wallet without a fallback target.
  await ensureDefaultJournal(walletAddress);

  // Stringify filter object if the client sent one as JSON; tolerate strings
  // (already-encoded) for forward compatibility.
  const filtersString =
    filters == null
      ? null
      : typeof filters === 'string'
      ? filters
      : JSON.stringify(filters);

  const journal = await prisma.journal.create({
    data: {
      walletAddress,
      name: name.trim(),
      description: description ?? null,
      filters: filtersString,
      isDefault: false,
    },
  });

  return NextResponse.json({ journal }, { status: 201 });
}
