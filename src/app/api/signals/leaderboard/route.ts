/**
 * GET /api/signals/leaderboard — Caller leaderboard for the authenticated wallet.
 *
 * Aggregates all resolved signals per caller and computes:
 *   totalSignals, hitTargets, hitStops, partialTargets, expired, open,
 *   hitRate, avgPnlPct, avgRMultiple, bestSignal, worstSignal
 *
 * hitRate treats partial_target proportionally: a signal with 2 of 3 TPs hit
 * contributes 0.67 to the win numerator rather than 0 or 1.
 *
 * Only callers with at least one signal are returned. Sorted by avgPnlPct desc.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';

export interface CallerStats {
  callerName: string;
  totalSignals: number;
  hitTargets: number;
  hitStops: number;
  partialTargets: number;
  expired: number;
  open: number;
  hitRate: number;           // weighted: full wins + fractional partial wins / resolved
  avgPnlPct: number | null;
  avgRMultiple: number | null;
  bestSignal: { asset: string; direction: string; pnlPct: number } | null;
  worstSignal: { asset: string; direction: string; pnlPct: number } | null;
}

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const signals = await prisma.signal.findMany({
      where: { walletAddress },
      select: {
        callerName: true,
        asset: true,
        direction: true,
        status: true,
        outcomePnlPct: true,
        outcomeRMultiple: true,
        targetPricesHit: true,
      },
    });

    // Group by callerName
    const byCallerMap = new Map<string, typeof signals>();
    for (const s of signals) {
      const arr = byCallerMap.get(s.callerName) ?? [];
      arr.push(s);
      byCallerMap.set(s.callerName, arr);
    }

    const callers: CallerStats[] = [];

    for (const [callerName, callerSignals] of byCallerMap) {
      const hitTargets    = callerSignals.filter((s) => s.status === 'hit_target').length;
      const hitStops      = callerSignals.filter((s) => s.status === 'hit_stop').length;
      const partialTargets = callerSignals.filter((s) => s.status === 'partial_target').length;
      const expired       = callerSignals.filter((s) => s.status === 'expired').length;
      const open          = callerSignals.filter((s) => s.status === 'open').length;
      const totalSignals  = callerSignals.length;

      const resolved = hitTargets + hitStops + partialTargets + expired;

      // Win points: full wins = 1, partial_target = fraction of TPs hit
      let hitPoints = hitTargets;
      for (const s of callerSignals) {
        if (s.status === 'partial_target' && s.targetPricesHit) {
          const flags = JSON.parse(s.targetPricesHit) as boolean[];
          const hitCount = flags.filter(Boolean).length;
          hitPoints += flags.length > 0 ? hitCount / flags.length : 0;
        }
      }
      const hitRate = resolved > 0 ? hitPoints / resolved : 0;

      const resolvedWithPnl = callerSignals.filter(
        (s) => s.status !== 'open' && s.outcomePnlPct != null,
      );
      const avgPnlPct = resolvedWithPnl.length > 0
        ? resolvedWithPnl.reduce((sum, s) => sum + s.outcomePnlPct!, 0) / resolvedWithPnl.length
        : null;

      const resolvedWithR = callerSignals.filter(
        (s) => s.status !== 'open' && s.outcomeRMultiple != null,
      );
      const avgRMultiple = resolvedWithR.length > 0
        ? resolvedWithR.reduce((sum, s) => sum + s.outcomeRMultiple!, 0) / resolvedWithR.length
        : null;

      const sorted = [...resolvedWithPnl].sort((a, b) => b.outcomePnlPct! - a.outcomePnlPct!);
      const bestSignal = sorted.length > 0
        ? { asset: sorted[0].asset, direction: sorted[0].direction, pnlPct: sorted[0].outcomePnlPct! }
        : null;
      const worstSignal = sorted.length > 0
        ? { asset: sorted[sorted.length - 1].asset, direction: sorted[sorted.length - 1].direction, pnlPct: sorted[sorted.length - 1].outcomePnlPct! }
        : null;

      callers.push({
        callerName,
        totalSignals,
        hitTargets,
        hitStops,
        partialTargets,
        expired,
        open,
        hitRate,
        avgPnlPct,
        avgRMultiple,
        bestSignal,
        worstSignal,
      });
    }

    // Sort: callers with resolved signals first, ranked by avgPnlPct desc
    callers.sort((a, b) => {
      if (a.avgPnlPct == null && b.avgPnlPct == null) return 0;
      if (a.avgPnlPct == null) return 1;
      if (b.avgPnlPct == null) return -1;
      return b.avgPnlPct - a.avgPnlPct;
    });

    return NextResponse.json({ callers });
  });
}
