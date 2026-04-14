/**
 * GET /api/carry — Carry trade opportunities for the authenticated wallet.
 *
 * Returns top 10 opportunities sorted by stability then net yield. When a
 * 4-5 star opportunity with >30% gross APR is found, a Signal is auto-created
 * (deduplicated: one per asset per 6 hours to avoid spam).
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import { getCarryOpportunities } from '@/services/pacifica/carry-service';

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    let opportunities;
    try {
      opportunities = await getCarryOpportunities(walletAddress);
    } catch (err) {
      console.error('[carry] getCarryOpportunities failed:', err);
      return NextResponse.json({ opportunities: [], loanPoolAvailable: false });
    }

    const top10 = opportunities.slice(0, 10);

    // Auto-create signals for 4-5 star opportunities with >30% gross APR.
    // Deduplication: skip if a carry signal already exists for this asset
    // within the last 6 hours to avoid flooding the signal list.
    const highValueOpps = top10.filter(
      (o) => o.stabilityScore >= 4 && o.fundingAprGross > 30 && o.fundingAprGross > 0,
    );

    if (highValueOpps.length > 0) {
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1_000);

      await Promise.all(
        highValueOpps.map(async (opp) => {
          const asset = opp.symbol.replace(/-PERP$/i, '').replace(/-USD$/i, '').toUpperCase();
          try {
            const existing = await prisma.signal.findFirst({
              where: {
                walletAddress,
                asset,
                source: 'pacifica-funding',
                createdAt: { gte: sixHoursAgo },
              },
              select: { id: true },
            });
            if (existing) return;

            await prisma.signal.create({
              data: {
                walletAddress,
                asset,
                direction: 'SHORT',
                entryPrice: opp.markPrice,
                targetPrice: null,
                stopPrice: null,
                callerName: 'Carry Monitor',
                source: 'pacifica-funding',
                channelName: null,
                rawMessage: `Carry opportunity: ${opp.fundingAprGross.toFixed(1)}% gross APR, ${opp.stabilityScore}-star stability`,
                status: 'open',
              },
            });
          } catch (err) {
            console.warn(`[carry] failed to create signal for ${asset}:`, err);
          }
        }),
      );
    }

    const loanPoolAvailable = top10.length > 0 ? top10[0].borrowRateApr !== null : false;
    const utilizationRate = top10.length > 0 ? top10[0].utilizationRate : null;
    const borrowRateApr = top10.length > 0 ? top10[0].borrowRateApr : null;

    return NextResponse.json({
      opportunities: top10,
      loanPoolAvailable,
      utilizationRate,
      borrowRateApr,
    });
  });
}
