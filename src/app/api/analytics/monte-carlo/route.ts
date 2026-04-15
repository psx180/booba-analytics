import { NextRequest, NextResponse } from 'next/server';
import { resolveJournalFilterId } from '@/lib/journals';
import { withAuth } from '@/lib/api-auth';
import { prisma } from '@/lib/prisma';
import { runMonteCarloSimulation } from '@/services/analytics/monte-carlo';

const MAX_RETURN_PCT = 200; // sanity cap — no single trade should move ±200% of notional

export async function GET(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const sp = req.nextUrl.searchParams;

    const journalRes = await resolveJournalFilterId(walletAddress, sp.get('journalId'));
    if (!journalRes.valid) {
      return NextResponse.json({ error: 'Journal not found for this wallet' }, { status: 404 });
    }

    const where: Record<string, any> = { walletAddress, status: 'closed' };
    if (journalRes.id) where.journalId = journalRes.id;

    const positions = await (prisma as any).position.findMany({
      where,
      select: { aggregatePnl: true, totalSize: true, averageEntryPrice: true },
      take: 5000,
    });

    // Compute percentage return per trade: pnlPct = aggregatePnl / (averageEntryPrice * totalSize) * 100
    // This gives P&L as a % of the position's USD notional value.
    // e.g. $32 profit on 0.001 BTC at $79,000 → $32 / ($79,000 × 0.001) × 100 = 40.5%
    //
    // Skip positions where notional can't be computed (missing price or size data).
    const winReturnPcts: number[] = [];
    const lossReturnPcts: number[] = [];
    let grossWins  = 0;
    let grossLosses = 0;
    let validCount = 0;
    let clampedCount = 0;

    for (const p of positions) {
      const pnl:        number = p.aggregatePnl        ?? 0;
      const size:       number = p.totalSize           ?? 0;
      const entryPrice: number = p.averageEntryPrice   ?? 0;

      if (size <= 0 || entryPrice <= 0) continue;

      const notional = entryPrice * size;
      let pnlPct = (pnl / notional) * 100;

      if (Math.abs(pnlPct) > MAX_RETURN_PCT) {
        console.warn(
          `[monte-carlo] Clamping extreme return ${pnlPct.toFixed(1)}% to ±${MAX_RETURN_PCT}% ` +
          `(pnl=${pnl}, notional=${notional.toFixed(2)})`,
        );
        pnlPct = Math.sign(pnlPct) * MAX_RETURN_PCT;
        clampedCount++;
      }

      validCount++;

      if (pnlPct > 0) {
        winReturnPcts.push(pnlPct);
        grossWins += pnlPct;
      } else if (pnlPct < 0) {
        lossReturnPcts.push(pnlPct);
        grossLosses += Math.abs(pnlPct);
      }
      // Flat trades (pnlPct === 0) count toward validCount only
    }

    if (clampedCount > 0) {
      console.warn(`[monte-carlo] ${clampedCount} of ${validCount} trades had returns clamped to ±${MAX_RETURN_PCT}%`);
    }

    if (validCount < 20) {
      return NextResponse.json(
        { error: 'Not enough trade history for reliable simulation. Need at least 20 trades.' },
        { status: 422 },
      );
    }

    const winCount  = winReturnPcts.length;
    const lossCount = lossReturnPcts.length;
    const winRate    = winCount / validCount;
    const avgWinPct  = winCount  > 0 ? grossWins    / winCount  : 0;
    const avgLossPct = lossCount > 0 ? -(grossLosses / lossCount) : 0;
    const initialBalance = 10000;

    const result = runMonteCarloSimulation({
      winRate,
      avgWinPct,
      avgLossPct,
      tradeCount:    100,
      simulations:   10000,
      initialBalance,
      winReturnPcts:  winCount  > 0 ? winReturnPcts  : undefined,
      lossReturnPcts: lossCount > 0 ? lossReturnPcts : undefined,
    });

    return NextResponse.json({
      ...result,
      initialBalance,
      inputWinRate:    Math.round(winRate    * 10000) / 10000,
      inputAvgWinPct:  Math.round(avgWinPct  * 100)   / 100,
      inputAvgLossPct: Math.round(avgLossPct * 100)   / 100,
      inputTradeCount: validCount,
    });
  });
}
