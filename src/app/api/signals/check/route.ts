/**
 * POST /api/signals/check — Trigger outcome checking for the authenticated wallet.
 *
 * Runs checkSignalOutcomes and returns the count and details of updated signals.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { checkSignalOutcomes } from '@/services/signals/signal-tracker';

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const updated = await checkSignalOutcomes(walletAddress);
    return NextResponse.json({ updated: updated.length, signals: updated });
  });
}
