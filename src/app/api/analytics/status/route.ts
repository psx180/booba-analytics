/**
 * GET /api/analytics/status
 *
 * Returns the slow-tier analytics state for the authenticated wallet.
 * Drives the dashboard's "deep analytics computing" banner — the frontend
 * polls this endpoint every few seconds after an import until it sees
 * `ready`, then reloads the page to pick up the now-populated MFE/MAE and
 * regime data.
 *
 * Response:
 *   { status: 'computing' | 'ready' | null }
 *
 * `null` means the wallet either hasn't imported yet or has no Journal row
 * on record — in both cases the banner stays hidden.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    // Wallets can have multiple journals but analyticsStatus is wallet-wide,
    // so any row's value is authoritative. Prefer the default journal to
    // keep the read deterministic when multiple rows exist.
    const row = await prisma.journal.findFirst({
      where: { walletAddress },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { analyticsStatus: true },
    });
    return NextResponse.json({ status: row?.analyticsStatus ?? null });
  });
}
