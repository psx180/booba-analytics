/**
 * GET /api/signals/caller-analytics?caller=AlphaTrader
 *
 * Runs caller analytics (signal-to-position adapter + simplified metrics)
 * for the given caller name scoped to the authenticated wallet.
 *
 * Returns { analytics: CallerAnalytics | null }. Null means the caller has
 * fewer than 5 resolved signals — not enough data to compute meaningful stats.
 *
 * Results are cached in-memory for 5 minutes (keyed by wallet + caller name)
 * to avoid re-running the computation on every modal open.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { computeCallerAnalytics, type CallerAnalytics } from '@/services/signals/caller-analytics';

// ─── Module-level cache ───────────────────────────────────────────────────────

const cache = new Map<string, { data: CallerAnalytics | null; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const caller = req.nextUrl.searchParams.get('caller');
    if (!caller) {
      return NextResponse.json({ error: 'Missing caller parameter' }, { status: 400 });
    }

    const cacheKey = `${walletAddress}:${caller}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return NextResponse.json({ analytics: cached.data });
    }

    const analytics = await computeCallerAnalytics(walletAddress, caller);
    cache.set(cacheKey, { data: analytics, expiresAt: Date.now() + TTL_MS });

    return NextResponse.json({ analytics });
  });
}
