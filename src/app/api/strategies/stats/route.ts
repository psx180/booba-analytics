/**
 * GET /api/strategies/stats
 *
 * Returns per-strategy aggregate stats (trade count, win rate, expectancy)
 * for all CLOSED positions the wallet has tagged with a strategyId.
 * Computed in JS from raw position rows so no complex SQL window functions
 * are needed — this is fine at hackathon data volumes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const positions = await prisma.position.findMany({
      where: {
        walletAddress,
        strategyId: { not: null },
        status: 'CLOSED',
      },
      select: {
        strategyId: true,
        aggregatePnl: true,
        strategy: { select: { name: true } },
      },
    });

    // Group by strategyId and aggregate
    const byStrategy = new Map<string, { name: string; pnls: number[] }>();
    for (const pos of positions) {
      if (!pos.strategyId || !pos.strategy) continue;
      if (!byStrategy.has(pos.strategyId)) {
        byStrategy.set(pos.strategyId, { name: pos.strategy.name, pnls: [] });
      }
      byStrategy.get(pos.strategyId)!.pnls.push(pos.aggregatePnl ?? 0);
    }

    const stats = Array.from(byStrategy.entries())
      .map(([strategyId, { name, pnls }]) => {
        const count = pnls.length;
        const wins = pnls.filter((p) => p > 0).length;
        const sum = pnls.reduce((s, p) => s + p, 0);
        return {
          strategyId,
          name,
          tradeCount: count,
          winRate: count > 0 ? wins / count : null,
          expectancy: count > 0 ? sum / count : null,
        };
      })
      .sort((a, b) => b.tradeCount - a.tradeCount);

    return NextResponse.json({ stats });
  });
}
